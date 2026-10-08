#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert-orchestrator 任务板：状态机 + 依赖 DAG + 崩溃恢复。

状态文件默认 <cwd>/.expert-taskboard.json，可用 --board 覆盖。
状态流转：pending（依赖未满足）-> ready -> running -> done | failed
  claim: ready -> running；done: running -> done（依赖它的任务自动转 ready）
  fail:  running -> failed；retry: failed -> ready；recover: 所有 running -> ready
依赖：create 时 --dep T1,T2 声明；引用不存在的任务会报错。
检查点：progress <id> "<说明>" 向任务追加带时间戳的检查点记录（新字段 checkpoints，旧板无此字段兼容）；长任务/多阶段委派每完成一个阶段记一次，专家失败重试前编排者先读取它组装续跑任务书，禁止无检查点直接从头重跑。
指标：metrics 按 owner 聚合 任务数/累计返工/换人次数（新字段 rework/switched，旧板无此字段兼容）；done 支持 --rework N / --switched 记录返工与换人，--by 记录实际执行者（新字段 executors，旧板无此字段兼容），供项目收口时反哺专家路由表。
并发正确性（v2.6）：
  进程互斥与原子写：除 boards 外所有命令全程持有 <board>.lock 文件的 fcntl.flock 独占锁，CAS 校验在锁内
    针对最新落盘状态进行、与写入原子（无 TOCTOU）；无 fcntl 平台（如 Windows）或设 TASKBOARD_DISABLE_FLOCK=1
    时降级为无锁——写入仍走唯一 tmp（pid+uuid 后缀）+ os.replace 原子替换，不会互相截断板文件，
    但校验-写入的强一致仅 POSIX 保证。
  CAS 乐观锁：板级 revision 随每次写自增；除 boards/archive 外所有命令末行输出 revision=N，写命令可带
    --expected-revision N，与当前不符返回具名错误 {"error":"stale_revision",...} 且不落盘；不带该参数行为与旧版一致。
  attempt 代际：claim --attempt <id> 建立派工代际；reassign <id> <新attempt> 转派先撤销旧代际（记入 attempt_revoked），
    且拒绝复活任何已撤销代际；done/fail/progress 带 --attempt 时按代际校验（fail closed：任务无开放代际时
    返回 {"error":"no_attempt",...}），旧/已撤销代际返回 {"error":"stale_attempt",...} 且不落盘；不带 --attempt 行为与旧版一致。
  查询失败语义：任务板文件损坏/结构非法（含深层结构，如 tasks 条目非对象）时，除 boards（逐板标注损坏）外
    所有命令返回 {"error":"unrecoverable","unrecoverable":true,...}，绝不静默返回空列表、绝不裸 traceback。
  环检测：create --dep 与 set_dependencies 写入前做全图环检测，成环返回 {"error":"dependency_cycle","cycle":"A->B->A"} 且不落盘。
门禁执法平面（v2.6，默认关闭，显式开启——未 --install-hook 前任何命令不触碰 .git/hooks/）：
  --install-hook：向当前仓库 .git/hooks/commit-msg 写入零依赖 POSIX sh hook（内嵌 python3 调本工具 _hook-check 三查：
    ① 提交消息须可解析出任务 id（形如 T<数字>）；② 消息中解析出的全部任务 id 均须在板内且状态 running（任一不满足即拒，
    防夹带未核 id）；③ 各任务声明 scope 时的并集内提交文件均须落在关联域内）。已有同名 hook 时报错退出不覆盖
    （内容完全一致视为已安装幂等返回；内容含本插件指纹标记行视为旧版本插件 hook，允许原地升级覆盖）；
    --board 可把项目板路径固化进 hook。
  --uninstall-hook：仅移除本插件安装的 hook——凭写入 hook 内的稳定指纹标记行辨认（标记行为固定注释前缀+协议版本，
    不随模板内容演进变化，模板任何一改旧 hook 仍可用工具卸载；旧版哈希形态的标记行同样被认得），无标记行则拒绝
    （不破坏用户自有 hook）。
  降级语义（fail-open，均 stderr 告警放行、不阻塞提交，与门禁辅助定位一致——板/环境不可用时拒绝会永久卡死所有提交）：
    ① hook 找不到门禁脚本（taskboard.py 被移动/卸载）；② python3 不可用（command -v 检测，hook 头部拦截，
    装回 python3 后门禁自动恢复）；③ 任务板缺失（含 archive 归档把板移走后——归档收口属预期流程，hook 不再阻塞
    提交，提示重新 --install-hook 或 --uninstall-hook）。脚本在、python3 在、板在而三查不过则拒绝提交（fail closed）。
滑动无进展 watchdog + 孤儿 adopt（v2.7，WP-4b/S2）：
  heartbeat <id>：running 任务心跳——重臂窗口并清零 nudge 计数（长任务报活的最小信号，不产检查点）。
  watchdog：扫描 running 任务的滑动无进展窗口（activity=max(updated,heartbeat_at,nudged_at)；claim
    新代际/progress/heartbeat 重臂，健康的长任务永不因跑得久被杀）。窗口到期 nudge（计数+重臂一个
    窗口），连续 --max-nudges（默认 2）次无响应升级：先在落盘信箱（coordinator 收件箱、_archive 归档、
    _outbox/<owner> 发件箱）检索本任务本 attempt 本 owner 的完成报告（subject/body 含任务 id+「完成」
    +交付词汇，多条取 ts 最新）——有证据 adopt 为 done（汇报内容入 summary，工作比它的 agent 活得久），
    无证据 reclaim（撤销当前代际防迟到汇报、清 owner 回 ready）。nudge/reclaim/adopt 均落检查点轨迹
    （watchdog: 前缀）；所有变更走既有事件追加路径（watchdog/heartbeat 为写命令，单事件携带全部变更
    任务 after 快照），新字段 heartbeat_at/nudges/nudged_at 随快照折叠只增不减，既有命令输出零变化。
验证回执范围指纹（v2.6）：verify <id> <文件...> 对完成汇报附带文件清单逐文件记 SHA-256（整表 digest 存板）；
  verify <id>（无文件）与 show/done 均重算比对，文件一变回执即标 stale（旧验证/旧评审自动失效），done 时 stale 仅告警不阻塞。
事件溯源化核心（v2.7）：
  状态权威：append-only JSONL 事件流 <板文件>.events.jsonl；JSON 板文件降级为「折叠视图」缓存（对外只增簿记字段
    event_seq/event_state_hash，既有字段零删改），list/status/show/deps 等命令输出结构不变。
  写路径：命令在 board_lock 锁内 load（折叠）-> CAS 校验 -> 变更 -> 追加一个事件（O_APPEND+fsync）-> os.replace
    原子重写视图；事件记录变更任务的全量快照（after）与命令意图（args），折叠=逐事件应用快照，重放与崩溃前
    逐字段一致；状态迁移逻辑只在命令函数一处，折叠层零业务规则。
  hash 防手改：事件链式 hash（每事件 hash=SHA-256(canonical(除 hash 外全字段))，prev 串前事件；中段断链/篡改
    -> unrecoverable），末事件另记 state_hash=SHA-256(canonical({tasks,seq,revision}))；加载时视图按同一
    state_hash 对账——视图缺失或落后（事件已追加、视图未及写的崩溃间隙）静默重放重建；视图被手改/损坏
    -> stderr 报警并按事件流权威重建覆盖（stdout 零污染，消费方解析不受扰）。
  崩溃恢复：事件流尾部残行/末事件校验失败（追加途中被杀）自动截断修复并 stderr 告警，后续追加 seq 连续衔接；
    末事件完整合法但缺行尾换行（fsync 后恰损换行的部分落盘）→ 读路径补写换行自愈并告警，后续追加不粘包、
    已落账事件不回滚；replay 命令可显式重放重建视图（幂等，崩溃演练/人工核对用）。
  旧板收编：无事件流的 v2.6 板首次写命令时以既有折叠状态为种子事件（seed）自动收编，数据零丢失，revision 延续；
    含 tasks/seq/revision+簿记之外未知顶层键的板当场 unrecoverable（收编早失败——放行则未知键被折叠模型
    静默丢弃，错一拍才暴露且无对账线索）。
  防洗白/防劫持（回炉加固）：事件流文件存在但为空而视图含簿记字段 → unrecoverable（簿记证明日志曾有事件，
    此刻为空必异常；拒绝按未校验视图直读或以其为种子重新收编。合法空日志仅出现在收编前——视图必无簿记字段，
    不误伤崩溃恢复）；archive 先迁事件流后迁板（两步间被杀顶层残留的是板而非孤儿日志，读命令可直读降级、
    写命令重新收编）；load 对「板文件缺失但事件流存在，且归档区有同名板的有簿记无日志残留」（旧序 archive
    崩溃窗口孤儿日志）拒绝复活旧板/续链（unrecoverable），同名 create 同拒。
  archive：事件流随板文件一并归档（<归档名>.events.jsonl），重放能力不因归档丢失。
  折叠语义不变量（当前命令集契约，扩展事件模型前必读；违背即重放与末事件 state_hash 失配 → 板 unrecoverable）：
    ① fold_events 只能逐事件覆盖 after 快照中的任务，无法表达任务删除——当前命令集不存在删除任务的命令；
       未来新增删除类命令须同步扩展折叠语义（如墓碑事件），否则重放结果多出已删任务，与崩溃前状态不一致。
    ② commit_event 落视图仅写 {tasks,seq,revision}+簿记（event_seq/event_state_hash），当前命令集不写板
       顶层其他键；未来新增板顶层键须同步纳入 seed/折叠/state_hash 口径，否则重放折叠缺该键、对账失配。
"""
import argparse, collections, contextlib, copy, datetime, glob, hashlib, json, os, re, subprocess, sys, time, uuid

try:
    # POSIX 标准库；Windows 等无 fcntl 平台降级（见 board_lock）
    import fcntl
except ImportError:
    fcntl = None


class BoardError(Exception):
    """具名错误：main 统一以 JSON（stdout）输出并退出码 1，机器可解析。"""

    def __init__(self, code, **fields):
        super().__init__(code)
        self.code = code
        self.fields = fields


def now_ms():
    return int(time.time() * 1000)


class _NullBoardLock:
    """无 fcntl 平台（或 TASKBOARD_DISABLE_FLOCK=1）的降级锁：不提供进程间互斥。"""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FlockBoardLock:
    """fcntl.flock 独占锁：多进程写同一板时校验-写入串行化（内核保证进程死亡即释放）。"""

    def __init__(self, lock_path):
        self.lock_path = lock_path
        self.f = None

    def __enter__(self):
        self.f = open(self.lock_path, 'w')
        fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        finally:
            self.f.close()
            self.f = None
        return False


def board_lock(path):
    """进程间互斥：main 中 load -> CAS 校验 -> 命令写入（save）必须整体在锁内完成（TOCTOU 防护）。
    - POSIX（有 fcntl）：fcntl.flock 独占锁 <board>.lock。
    - 无 fcntl（如 Windows）或设 TASKBOARD_DISABLE_FLOCK=1：降级为无锁——写入仍走唯一 tmp（pid+uuid
      后缀）+ os.replace 原子替换，不会互相截断板文件；但 CAS 校验与写入不再原子（强一致仅 POSIX 保证）。
    """
    if fcntl is None or os.environ.get('TASKBOARD_DISABLE_FLOCK'):
        return _NullBoardLock()
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    return _FlockBoardLock(path + '.lock')


def _unrecoverable(path, reason):
    return BoardError('unrecoverable', path=path, reason=reason)


def _validate_board(data, path):
    """深层结构校验：tasks 条目必须为对象且命令路径会访问的字段类型正确。
    违反即 unrecoverable（覆盖评审项：tasks 条目非 dict 等深层损坏，绝不裸 traceback）。"""
    tasks = data.get('tasks')
    if not isinstance(tasks, dict):
        raise _unrecoverable(path, '结构非法：缺少 tasks 对象')
    if not isinstance(data.get('seq'), int) or isinstance(data.get('seq'), bool):
        raise _unrecoverable(path, '结构非法：seq 必须是整数')
    for tid, t in tasks.items():
        if not isinstance(tid, str) or not (tid.startswith('T') and tid[1:].isdigit()):
            raise _unrecoverable(path, f'结构非法：任务 id {tid!r} 不是 T<数字> 形式')
        if not isinstance(t, dict):
            raise _unrecoverable(path, f'结构非法：任务 {tid} 条目不是对象')
        for k in ('id', 'title', 'status'):
            if not isinstance(t.get(k), str):
                raise _unrecoverable(path, f'结构非法：任务 {tid} 缺少或类型错误的字段 {k}')
        dep = t.get('dep')
        if not isinstance(dep, list) or not all(isinstance(d, str) for d in dep):
            raise _unrecoverable(path, f'结构非法：任务 {tid} 的 dep 必须是字符串列表')


# ── 事件溯源化核心（v2.7）：JSONL 事件流为状态权威，JSON 板文件降级为折叠视图缓存 ──
# 组织：事件流 <板文件>.events.jsonl（不以 .json 结尾，不干扰板定位的 *.json 枚举与 boards 列举）；
#   事件=变更任务的全量快照差分（after）+ 命令意图（args），折叠=逐事件应用快照——重放与崩溃前逐字段一致，
#   状态迁移逻辑只存在于命令函数一处（快照采集自真实落盘状态，折叠层零业务规则，不双写不分叉）。
# hash 方案：事件链式 hash——每事件 hash=SHA-256(canonical(除 hash 外全部字段))，prev 串前事件 hash；
#   末事件另记 state_hash=SHA-256(canonical({tasks,seq,revision}))；加载时视图按同一 state_hash 对账。
#   视图缺失/落后于事件流（「事件已追加、视图未及写」的崩溃间隙，含旧板收编的同类间隙）→ 静默重放
#   重建；视图被手改/损坏（state_hash 失配或 JSON 解析失败）→ stderr 报警并按事件流权威重建
#   （stdout 零污染，消费方解析不受扰）。
# 事件流尾部残行（末行不可解析的撕裂写）→ 自动截断修复并告警；可解析但链/hash 校验失败（含末事件）
#   与中段损坏/断链 → 一律 unrecoverable（截断已落账的末事件=静默回滚命令，篡改语义对称）。
# 旧板收编：无事件流的 v2.6 板首次写命令时以既有状态为种子事件（seed）自动收编，数据零丢失，revision 延续。
BOOKKEEPING_KEYS = ('event_seq', 'event_state_hash')


def events_path(path):
    """事件流文件路径：<板文件>.events.jsonl。"""
    return path + '.events.jsonl'


def _canonical(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _sha_hex(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def _state_hash(d):
    """折叠状态 hash：排除视图簿记字段后的 canonical JSON 整体 SHA-256（手改任意语义字段即失配）。"""
    return _sha_hex(_canonical({k: d[k] for k in d if k not in BOOKKEEPING_KEYS}))


def _event_hash(ev):
    return _sha_hex(_canonical({k: v for k, v in ev.items() if k != 'hash'}))


def _repair_events(ep, evs):
    """截断修复事件流：只保留验证通过的事件（唯一 tmp + os.replace 原子替换）。"""
    d = os.path.dirname(ep)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f'{ep}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for ev in evs:
            f.write(json.dumps(ev, ensure_ascii=False) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, ep)


def read_events(path):
    """读取并校验事件流：逐行解析 + 链式 hash 验证，返回验证通过的事件列表。
    尾部残行（末行不可解析的结构性残缺——O_APPEND 单行撕裂写缺闭合括号）→ 截断修复并 stderr 告警
    （崩溃恢复语义）；可解析但 seq/prev/hash/type 校验失败（含末事件被篡改、次末行被删导致的断链）
    一律 unrecoverable，与中段篡改同语义——可解析事件是已 fsync 落账的完整命令，按残尾截断等于
    静默回滚一次已执行命令（数据丢失且篡改语义不对称）；中段不可解析 → unrecoverable（权威受损
    绝不静默）。末事件完整合法但缺行尾换行（fsync 后恰损换行的部分落盘）→ 补写换行自愈并告警，
    防止下次 O_APPEND 追加与末事件粘包后被误当残尾截断。"""
    ep = events_path(path)
    if not os.path.exists(ep):
        return []
    with open(ep, encoding='utf-8', errors='replace') as f:
        raw = f.read()
    items = [(i + 1, s) for i, s in enumerate(raw.split('\n')) if s.strip()]
    evs, torn, bad = [], False, None
    for k, (ln, s) in enumerate(items):
        try:
            evs.append(json.loads(s))
        except Exception:
            bad = k
            break
    if bad is not None:
        # 解析失败行之后若还存在可解析行 → 中段损坏；否则视为崩溃残尾
        for _, s2 in items[bad:]:
            try:
                json.loads(s2)
            except Exception:
                continue
            raise _unrecoverable(path, f'事件流第 {items[bad][0]} 行损坏（中段不可解析）')
        torn = True
        evs = evs[:bad]
    prev_hash, prev_seq = '', 0
    for k, ev in enumerate(evs):
        ok = (isinstance(ev, dict) and ev.get('seq') == prev_seq + 1
              and ev.get('prev') == prev_hash and ev.get('hash') == _event_hash(ev)
              and isinstance(ev.get('type'), str))
        if not ok:
            # 可解析但链/hash 校验失败：无论位置一律 unrecoverable（含末事件——不按残尾截断，
            # 截断会静默回滚已落账命令的效果；撕裂写若只是丢了行尾换行（JSON 完整合法）由下方
            # 缺换行自愈分支处理，不会走到这里）
            raise _unrecoverable(path, f'事件流第 {k + 1} 个事件校验失败（链/hash 校验失败或被篡改）')
        prev_hash, prev_seq = ev['hash'], ev['seq']
    if torn:
        _repair_events(ep, evs)
        print(f'警告：事件流尾部存在未完成写入（疑似进程被杀），已截断修复至最后一个完整事件: {ep}', file=sys.stderr)
    elif raw and not raw.endswith('\n') and evs:
        # 丢尾随换行自愈（二轮评审重要-3）：fsync 后恰损行尾换行时末事件仍完整合法且链校验通过——
        # 若直接 O_APPEND 追加，会与末事件粘成一行不可解析，下次读取按撕裂残尾截断，把已落账命令
        # 一并回滚（实测 4→2）。读路径先补写换行（O_APPEND 单字节 + fsync），保证后续追加不粘包。
        with open(ep, 'a', encoding='utf-8') as f:
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        print(f'警告：事件流末尾缺失换行符（疑似写入中断残留），已补写自愈: {ep}', file=sys.stderr)
    return evs


def _prev_of_log(path):
    """取事件流末事件的 (seq, hash)；空/缺失返回 (0, '')（收编判定与 prev 串链用）。"""
    ep = events_path(path)
    if not os.path.exists(ep):
        return 0, ''
    last = None
    with open(ep, encoding='utf-8', errors='replace') as f:
        for ln in f:
            s = ln.strip()
            if s:
                last = s
    if not last:
        return 0, ''
    try:
        ev = json.loads(last)
        return int(ev.get('seq', 0)), ev.get('hash') or ''
    except Exception:
        return 0, ''  # 残尾：load 已在锁内修复；此处防御性归零


def _append_event(path, ev):
    """追加一个事件（O_APPEND 单行写入 + fsync；锁内串行，残尾由 read_events 崩溃恢复语义兜底）。"""
    ep = events_path(path)
    d = os.path.dirname(ep)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(ep, 'a', encoding='utf-8') as f:
        f.write(json.dumps(ev, ensure_ascii=False) + '\n')
        f.flush()
        os.fsync(f.fileno())


def fold_events(evs):
    """事件折叠：状态 = 逐事件应用 after 快照（任务级全量快照差分，见文件头「事件溯源化核心」）。"""
    state = {'tasks': {}, 'seq': 0, 'revision': 0}
    for ev in evs:
        after = ev.get('after')
        if isinstance(after, dict):
            for tid, t in after.items():
                state['tasks'][tid] = t
        if isinstance(ev.get('board_seq'), int) and not isinstance(ev.get('board_seq'), bool):
            state['seq'] = ev['board_seq']
        if isinstance(ev.get('revision'), int) and not isinstance(ev.get('revision'), bool):
            state['revision'] = ev['revision']
    return state


# 写命令事件上下文：main 派发前武装（pre 快照供差分、并按需充当收编种子），save() 据此落事件。
_EVT_CTX = {'armed': False, 'type': None, 'args': {}, 'pre_tasks': None, 'pre_seq': 0, 'pre_rev': 0, 'ts': 0}


def _event_args(a):
    """事件 args 载荷：记录命令意图（审计用）；状态本体由 after 快照承载。"""
    c = a.cmd
    if c == 'create':
        return {'title': a.title, 'owner': a.owner or '',
                'dep': [d.strip() for d in (a.dep or '').split(',') if d.strip()],
                'desc': a.desc or '', 'scope': a.scope or ''}
    if c == 'claim':
        return {'owner': a.owner, 'attempt': a.attempt}
    if c == 'done':
        return {'summary': a.summary or '', 'rework': a.rework, 'switched': a.switched, 'by': a.by}
    if c == 'fail':
        return {'reason': a.reason or ''}
    if c == 'progress':
        return {'note': a.note}
    if c == 'heartbeat':
        return {'attempt': a.attempt}
    if c == 'watchdog':
        return {'window_sec': a.window_sec, 'max_nudges': a.max_nudges, 'bus_root': a.bus_root or ''}
    if c == 'reassign':
        return {'attempt_id': a.attempt_id, 'owner': a.owner}
    if c == 'set_dependencies':
        return {'dep': a.dep}
    if c == 'verify':
        return {'files': list(a.files or [])}
    return {}  # retry/recover 等无附加意图


# 写命令事件上下文：main 派发前武装（pre 快照供差分、并按需充当收编种子），save() 据此落事件。
# 写命令白名单：与 save() 调用方一一对应。读命令（list/show/status/deps/metrics）与
# boards/archive/replay/_hook-check 永不 save，不武装——免去每次读命令两次全量 tasks deepcopy。
_WRITE_CMDS = frozenset(('create', 'claim', 'done', 'fail', 'progress', 'recover', 'retry',
                         'reassign', 'set_dependencies', 'verify', 'heartbeat', 'watchdog'))


def _arm_event_ctx(a, data):
    """写命令派发前武装事件上下文（pre 快照供差分与按需收编种子），save() 据此落事件；
    白名单外的命令（读命令及 boards/archive/_hook-check/replay）不落事件，跳过武装。
    收编种子按需惰性组装（二轮评审建议3）：pre_tasks 快照本身即种子数据，事件流已有有效事件时
    commit_event 永不需要种子——不再为此对全量 tasks 做第二次深拷贝；日志存在但为空的收编前
    崩溃恢复仍能收编（判定在 commit_event 锁内按 prev_seq 而非文件存在性，无误伤）。"""
    if a.cmd not in _WRITE_CMDS:
        _EVT_CTX.update({'armed': False, 'type': None, 'args': {}, 'pre_tasks': None,
                         'pre_seq': 0, 'pre_rev': 0, 'ts': 0})
        return
    _EVT_CTX.update({
        'armed': True, 'type': a.cmd, 'args': _event_args(a),
        'pre_tasks': copy.deepcopy(data['tasks']),
        'pre_seq': int(data.get('seq', 0)), 'pre_rev': int(data.get('revision', 0)),
        'ts': now_ms(),
    })


def save_view(path, data):
    """折叠视图原子落盘：唯一 tmp（pid+uuid 后缀）+ os.replace（同 v2.6 机制）。须在 board_lock 锁内调用。"""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f'{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def commit_event(path, data):
    """写路径落账：必要时先收编（pre 快照为种子）→ 追加本命令事件（fsync）→ 原子重写折叠视图。
    事件 after=与 pre 快照差分出的变更任务全量快照；revision 随每次写自增（与 v2.6 CAS 语义一致）。"""
    ctx = _EVT_CTX
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    prev_seq, prev_hash = _prev_of_log(path)
    if prev_seq == 0 and (ctx['pre_tasks'] or ctx['pre_seq'] or ctx['pre_rev']):
        # 旧板收编（含「日志文件存在但为空」的收编前崩溃恢复）：以既有折叠状态为种子事件
        #（revision 不自增，数据零丢失；pre_tasks 是武装时的隔离快照，种子与差分共用一份）
        seed = {'seq': 1, 'ts': ctx['ts'], 'type': 'seed',
                'args': {'reason': 'v2.6 旧板收编：以既有折叠状态为种子事件'},
                'after': ctx['pre_tasks'], 'board_seq': ctx['pre_seq'],
                'revision': ctx['pre_rev'], 'prev': ''}
        seed['state_hash'] = _sha_hex(_canonical({'tasks': ctx['pre_tasks'],
                                                  'seq': ctx['pre_seq'],
                                                  'revision': ctx['pre_rev']}))
        seed['hash'] = _event_hash(seed)
        _append_event(path, seed)
        prev_seq, prev_hash = 1, seed['hash']
    new_rev = int(data.get('revision', 0)) + 1
    data['revision'] = new_rev
    pre = ctx.get('pre_tasks') or {}
    after = {tid: t for tid, t in data['tasks'].items() if tid not in pre or pre[tid] != t}
    ev = {'seq': prev_seq + 1, 'ts': ctx['ts'], 'type': ctx['type'], 'args': ctx['args'],
          'after': after, 'board_seq': int(data.get('seq', 0)), 'revision': new_rev, 'prev': prev_hash}
    ev['state_hash'] = _state_hash(data)  # 先算状态 hash，事件 hash 覆盖含 state_hash 的全部其余字段
    ev['hash'] = _event_hash(ev)
    _append_event(path, ev)
    save_view(path, {'tasks': data['tasks'], 'seq': int(data.get('seq', 0)), 'revision': new_rev,
                     'event_seq': ev['seq'], 'event_state_hash': ev['state_hash']})


def _orphan_log_of_archived(path):
    """旧序 archive 崩溃窗口签名（二轮评审重要-2）：归档区存在与本板同名的归档板文件，其视图含
    事件簿记字段（曾是事件流板）但对应 .events.jsonl 不在归档区——即「板已迁、日志未迁完」的残留
    形态，顶层的孤儿事件日志正是其未迁完的日志；此时板已被收口，孤儿日志不得复活旧板或被续链。
    归档区落点与 cmd_archive 一致（cwd 相对 .expert-taskboards/archive）；无簿记字段的 v2.6 旧归档板
    本就无日志，不算窗口残留（避免误伤「升级前归档 + 活动板视图丢失」的正常崩溃恢复）。"""
    arch = os.path.join('.expert-taskboards', 'archive')
    if not os.path.isdir(arch):
        return False
    suffix = '-' + os.path.basename(path)
    try:
        names = os.listdir(arch)
    except OSError:
        return False
    for n in sorted(names):
        if n.endswith('.jsonl') or not n.endswith(suffix):
            continue
        ap = os.path.join(arch, n)
        if os.path.exists(ap + '.events.jsonl'):
            continue  # 归档板与日志成对在档：正常归档形态，非崩溃窗口
        try:
            with open(ap, encoding='utf-8') as f:
                if 'event_seq' in json.load(f):
                    return True
        except Exception:
            continue
    return False


def load(path):
    """加载任务板状态：有事件流 → 折叠（权威）+ 视图对账；无事件流 → v2.6 旧板直读（首次写时收编）。
    视图对账：缺失/落后 → 静默重放重建（崩溃恢复）；手改/损坏 → stderr 报警并按事件流权威重建。
    直读分支两道防线：事件流被清空但视图含簿记 → unrecoverable（防清空日志洗白）；含未知顶层键 →
    unrecoverable（收编早失败）。"""
    evs = read_events(path)
    if not evs:
        if not os.path.exists(path):
            return {'tasks': {}, 'seq': 0, 'revision': 0}
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            raise _unrecoverable(path, f'JSON 解析失败: {e}')
        if not isinstance(data, dict):
            raise _unrecoverable(path, '结构非法：板文件顶层不是对象')
        if os.path.exists(events_path(path)) and any(k in data for k in BOOKKEEPING_KEYS):
            # 事件流清空即洗白防御（二轮评审重要-1）：簿记字段证明事件流曾有事件，此刻为空只能是被
            # 清空/截断——按旧板直读会对手改视图零告警放行，下次写命令还会以其为种子重新收编（手改
            # 洗白）。合法空日志只出现在收编前（视图必无簿记字段），不误伤崩溃恢复。
            raise _unrecoverable(path, '事件流文件存在但为空，而视图含事件簿记字段 '
                                       f'{list(BOOKKEEPING_KEYS)}——事件流疑似被清空或截断（曾有事件，'
                                       '此时为空必异常）；拒绝按未校验视图直读或重新收编，请从备份恢复事件流')
        unknown = [k for k in data if k != 'tasks' and k != 'seq' and k != 'revision'
                   and k not in BOOKKEEPING_KEYS]
        if unknown:
            # 收编早失败（二轮评审采纳）：未知顶层键放行收编会被折叠模型静默丢弃，错一拍才暴露；
            # 当场具名拒绝并给可读原因（与直读路径的结构校验同位，读命令同样早暴露）。
            raise _unrecoverable(path, f'板文件含未知顶层键 {unknown}（收编前旧板仅允许 '
                                       'tasks/seq/revision+事件簿记字段）；拒绝收编——未知键无法纳入'
                                       '事件折叠与 state_hash 口径，请先人工确认并移除该键')
        data.setdefault('revision', 0)  # 旧板无 revision 字段兼容
        _validate_board(data, path)
        return data
    state = fold_events(evs)
    _validate_board(state, path)
    last = evs[-1]
    actual = _state_hash(state)
    if last.get('state_hash') != actual:
        raise _unrecoverable(path, '事件流折叠校验失败：末事件 state_hash 与重放结果不一致')
    state['event_seq'] = int(last.get('seq', 0))
    state['event_state_hash'] = last.get('state_hash')
    v, v_exists = None, os.path.exists(path)
    if v_exists:
        try:
            with open(path, encoding='utf-8') as f:
                v = json.load(f)
        except Exception:
            v = None
    if v is None:
        if v_exists:  # 视图在但解析失败（外部损坏；崩溃不会产生半写视图——os.replace 原子）
            print(f'警告：任务板状态文件损坏（JSON 解析失败），已按事件流（权威）重放重建折叠状态: {path}',
                  file=sys.stderr)
        elif _orphan_log_of_archived(path):
            # archive 崩溃窗口防御（二轮评审重要-2）：板文件缺失而事件流在，且归档区有同名板的
            # 「有簿记、无日志」残留——顶层事件流是归档迁移未完成的孤儿日志，板已被收口；放行则
            # 读命令按孤儿日志静默复活旧板、同名 create 续链（跨板劫持）。拒绝并提示人工核查。
            # （视图意外丢失的正常崩溃恢复无此归档签名，仍走下方静默重建，不误伤。）
            raise _unrecoverable(path, '板文件缺失但事件流存在，且归档区存在同名归档板的孤儿日志残留'
                                       '（疑似 archive 迁移中断的崩溃窗口终态）；拒绝按孤儿事件流复活'
                                       '旧板或续链，请人工核查归档区与事件流后再处理')
        save_view(path, state)  # 视图整体丢失属崩溃恢复，静默重建
        return state
    vseq = v.get('event_seq')
    if _state_hash(v) == actual and vseq == state['event_seq']:
        return state  # 干净快路径：视图与事件流一致
    if isinstance(vseq, int) and not isinstance(vseq, bool) and vseq < state['event_seq']:
        # 崩溃间隙：事件已追加、视图未及写——静默重放（不报警）。诊断补充（二轮评审建议2）：
        # 视图自称 event_seq=vseq，其内容 hash 应与第 vseq 个事件的 state_hash 一致；失配说明视图
        # 内容曾被外部改动（而非单纯落后），stderr 补一条提示——重建行为不变，只补可观测性。
        ref = evs[vseq - 1].get('state_hash') if 0 < vseq <= len(evs) else None
        if ref is not None and _state_hash(v) != ref:
            print(f'提示：任务板视图落后于事件流且内容校验失配（疑似视图曾被外部改动），已按事件流重放重建: {path}',
                  file=sys.stderr)
        save_view(path, state)  # 崩溃间隙：事件已追加、视图未及写——静默重放（不报警）
        return state
    if not any(k in v for k in BOOKKEEPING_KEYS) and _state_hash(v) == actual:
        # 旧板收编崩溃间隙：种子事件已追加、视图未及写，仍是收编前的 v2.6 原生板（无簿记字段）。
        # 内容与折叠权威逐字段一致 → 与上一分支同语义，静默重建（不报警）；缺簿记但内容不一致
        # 的真实手改不豁免，仍落入下方报警分支。
        save_view(path, state)
        return state
    print(f'警告：任务板状态文件校验不一致（疑似手改或外部修改），已按事件流（权威）重放重建折叠状态: {path}',
          file=sys.stderr)
    save_view(path, state)
    return state


def save(path, data):
    """命令写路径（须在 board_lock 锁内调用）：armed 时落成事件（追加事件流 + 原子重写视图）；
    未武装的防御路径退化为 v2.6 直写（revision 自增 + 原子替换）。"""
    if _EVT_CTX.get('armed'):
        commit_event(path, data)
        return
    data['revision'] = int(data.get('revision', 0)) + 1
    save_view(path, data)


def check_revision(a, data):
    """CAS 乐观锁：写命令带 --expected-revision 时校验；不符则具名拒绝，不落盘。"""
    er = getattr(a, 'expected_revision', None)
    cur = int(data.get('revision', 0))
    if er is not None and er != cur:
        raise BoardError('stale_revision', expected=er, current=cur,
                         hint='任务板已被并发写入；重新读取（读命令末行 revision=N）后携带最新 revision 重试')


def check_attempt(a, t):
    """attempt 代际校验（汇报路径 done/fail/progress）：
    不带 --attempt 不校验（向后兼容，行为与旧版一致）；带 --attempt 时 fail closed——
    任务无开放代际 → no_attempt；attempt 已撤销 → stale_attempt（revoked）；非当前代际 → stale_attempt。"""
    att = getattr(a, 'attempt', None)
    if att is None:
        return
    cur = t.get('attempt_id')
    revoked = t.get('attempt_revoked') or []
    if att in revoked:
        raise BoardError('stale_attempt', attempt=att, current=cur, revoked=revoked,
                         hint='该 attempt 已被撤销，不能用于汇报；向编排者确认最新 attempt_id')
    if not cur:
        raise BoardError('no_attempt', attempt=att,
                         hint='该任务没有开放的派工代际；先由编排者 claim --attempt / reassign 建立代际，或省略 --attempt（与旧版一致）')
    if att != cur:
        raise BoardError('stale_attempt', attempt=att, current=cur,
                         revoked=revoked,
                         hint='该任务已转派到新代际；向编排者确认最新 attempt_id，或重新领取')


def find_cycle(graph):
    """graph: id -> dep 列表（id 依赖 dep）；返回环路径如 ['A','B','C','A']，无环返回 None。"""
    color = {u: 0 for u in graph}  # 0=未访 1=在栈 2=完成

    def dfs(u, stack):
        color[u] = 1
        stack.append(u)
        for v in graph[u]:
            if v not in graph:
                continue
            if color[v] == 1:
                return stack[stack.index(v):] + [v]
            if color[v] == 0:
                c = dfs(v, stack)
                if c:
                    return c
        stack.pop()
        color[u] = 2
        return None

    for u in graph:
        if color[u] == 0:
            c = dfs(u, [])
            if c:
                return c
    return None


def ensure_acyclic(tasks, extra_id, extra_deps):
    """依赖写入前全图环检测：extra_id/extra_deps 为拟写入的边。"""
    graph = {tid: list(t['dep']) for tid, t in tasks.items()}
    graph[extra_id] = list(extra_deps)
    cycle = find_cycle(graph)
    if cycle:
        raise BoardError('dependency_cycle', cycle='->'.join(cycle),
                         hint=f'拒绝写入：{extra_id} 的新依赖构成环；先调整依赖再写入')


def deps_state(task, tasks):
    missing = [d for d in task['dep'] if d not in tasks]
    if missing:
        return False, '缺失依赖: ' + ','.join(missing)
    un = [d for d in task['dep'] if tasks[d]['status'] != 'done']
    return (not un), ('等待: ' + ','.join(un) if un else '')


def refresh(data):
    promoted = []
    for t in data['tasks'].values():
        if t['status'] == 'pending':
            ok, _ = deps_state(t, data['tasks'])
            if ok:
                t['status'] = 'ready'
                t['updated'] = now_ms()
                promoted.append(t['id'])
    return promoted


def get_task(data, tid):
    t = data['tasks'].get(tid)
    if not t:
        sys.exit(f"错误：任务 {tid} 不存在")
    return t


# ── 验证回执范围指纹（v2.6）：逐文件 SHA-256 整表 hash 存板，文件一变回执即 stale ──
TASK_ID_RE = re.compile(r'(?<![A-Za-z0-9_/.-])T(\d+)(?![0-9])')  # 独立 token 形态，排除路径片段（build/T3）与更长数字


def parse_task_ids(text):
    """从文本解析独立 token 形态的任务 id（去重保序）；路径形态与更长数字不解析。"""
    seen, out = set(), []
    for m in TASK_ID_RE.finditer(text):
        tid = 'T' + (m.group(1).lstrip('0') or '0')
        if tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out


def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def _verify_digest(files):
    """整表 digest：排序后逐行 'path  sha256' 再整体 SHA-256（与文件集合顺序无关，确定可复算）。"""
    lines = ''.join(f'{p}  {h}\n' for p, h in sorted(files.items()))
    return hashlib.sha256(lines.encode('utf-8')).hexdigest()


def verify_status(t, cwd=None):
    """重算验证回执：返回 (state, changed, missing)。state ∈ 'none'|'fresh'|'stale'。"""
    rec = t.get('verify')
    if not rec:
        return 'none', [], []
    cwd = cwd or os.getcwd()
    cur, missing = {}, []
    for p in rec.get('files', {}):
        full = p if os.path.isabs(p) else os.path.join(cwd, p)
        if os.path.isfile(full):
            cur[p] = _sha256_file(full)
        else:
            missing.append(p)
    changed = sorted(p for p, h in cur.items() if rec['files'].get(p) != h) + [f'{p}（缺失）' for p in missing]
    state = 'fresh' if not changed else 'stale'
    return state, changed, missing


def cmd_verify(a, data, path):
    """verify <id> <文件...>：记录验证回执指纹；verify <id>：重算并输出 fresh/stale。"""
    t = get_task(data, a.id)
    if a.files:
        rels = []
        for f in a.files:
            full = f if os.path.isabs(f) else os.path.join(os.getcwd(), f)
            if not os.path.isfile(full):
                sys.exit(f'错误：文件不存在或不是普通文件：{f}')
            rels.append(os.path.relpath(full, os.getcwd()))
        files = {p: _sha256_file(p if os.path.isabs(p) else os.path.join(os.getcwd(), p)) for p in rels}
        t['verify'] = {'files': files, 'digest': _verify_digest(files), 'time': now_ms()}
        t['updated'] = now_ms()
        save(path, data)
        print(f"{a.id} 验证回执已记录（{len(files)} 文件，digest={t['verify']['digest'][:16]}）")
        print(f"  状态: fresh")
        return
    if not t.get('verify'):
        sys.exit(f'错误：{a.id} 没有验证回执；先用 verify {a.id} <文件...> 记录文件清单指纹')
    state, changed, _ = verify_status(t)
    print(f"{a.id} 验证回执: {state}")
    if state == 'stale':
        print(f'  文件已变更: {", ".join(changed)}')
        print('  旧验证/旧评审自动失效；重新 verify 后再交付')



def show(t):
    dep = (' dep=' + ','.join(t['dep'])) if t['dep'] else ''
    owner = (f" owner={t['owner']}") if t['owner'] else ''
    scope = (' scope=' + ','.join(t['scope'])) if t.get('scope') else ''
    print(f"{t['id']} [{t['status']}] {t['title']}{owner}{dep}{scope}")


def cmd_create(a, data, path):
    deps = [d.strip() for d in (a.dep or '').split(',') if d.strip()]
    for d in deps:
        if d not in data['tasks']:
            sys.exit(f"错误：依赖任务 {d} 不存在")
    scope = [s.strip().rstrip('/') for s in (a.scope or '').split(',') if s.strip()]
    tid = f"T{data['seq'] + 1}"
    ensure_acyclic(data['tasks'], tid, deps)  # 全图环检测（写入前）
    data['seq'] += 1
    data['tasks'][tid] = {
        'id': tid, 'title': a.title, 'owner': a.owner or '', 'dep': deps,
        'desc': a.desc or '', 'status': 'pending', 'created': now_ms(),
        'updated': now_ms(), 'summary': '', 'fail': '',
    }
    if scope:
        data['tasks'][tid]['scope'] = scope
    promoted = refresh(data)
    save(path, data)
    show(data['tasks'][tid])
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


def cmd_list(a, data, _):
    if not data['tasks']:
        print('（任务板为空）')
        return
    for tid in sorted(data['tasks'], key=lambda x: int(x[1:])):
        show(data['tasks'][tid])


def last_checkpoint(t):
    """取最新检查点；旧板条目无 checkpoints 字段时返回 None。"""
    cps = t.get('checkpoints') or []
    return cps[-1] if cps else None


def cmd_show(a, data, _):
    t = get_task(data, a.id)
    show(t)
    if t['desc']:
        print(f"  完成标准: {t['desc']}")
    if t['summary']:
        print(f"  结果: {t['summary']}")
    if t['fail']:
        print(f"  失败原因: {t['fail']}")
    cp = last_checkpoint(t)
    if cp:
        n = len(t.get('checkpoints') or [])
        print(f"  最新检查点({n}): [{cp['time']}] {cp['note']}")
    rework = t.get('rework') or 0
    switched = t.get('switched') or False
    if rework or switched:
        print(f"  返工 {rework} 次" + ('，已换人' if switched else ''))
    exs = t.get('executors') or []
    if exs:
        print('  实际执行者: ' + ', '.join(f"{e['name']}[{e['time']}]" for e in exs))
    if t.get('verify'):
        state, changed, _ = verify_status(t)
        n = len(t['verify'].get('files') or {})
        print(f"  验证回执: {state}（{n} 文件，digest={t['verify']['digest'][:16]}）")
        if state == 'stale':
            print(f'    文件已变更（旧验证/评审失效）: {", ".join(changed)}')
    ok, why = deps_state(t, data['tasks'])
    if t['dep'] and not ok:
        print(f"  依赖未满足（{why}）")


def cmd_claim(a, data, path):
    t = get_task(data, a.id)
    if t['status'] != 'ready':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 ready 可认领")
    if a.attempt:
        if a.attempt in (t.get('attempt_revoked') or []):
            raise BoardError('stale_attempt', attempt=a.attempt, current=t.get('attempt_id'),
                             revoked=t.get('attempt_revoked') or [],
                             hint='该 attempt 已被撤销，不能重新启用；请使用编排者下发的新 attempt_id')
        old = t.get('attempt_id')
        if old and old != a.attempt:
            t.setdefault('attempt_revoked', []).append(old)  # 转派即撤销旧代际
        t['attempt_id'] = a.attempt
        _reset_nudges(t)  # 新代际=新起点：旧代积攒的未响应 nudge 不带入（watchdog 从头计窗）
        t.pop('heartbeat_at', None)
    t['status'] = 'running'
    if a.owner:
        t['owner'] = a.owner
    t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_done(a, data, path):
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可完成")
    t['status'] = 'done'
    if a.rework is not None and a.rework < 0:
        sys.exit('错误：--rework 不能为负数')
    t['summary'] = a.summary or ''
    if a.rework is not None:
        t['rework'] = a.rework
    if a.switched:
        t['switched'] = True
    if a.by and a.by != t['owner']:
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('executors', []).append({'name': a.by, 'time': ts})
    t['updated'] = now_ms()
    promoted = refresh(data)
    save(path, data)
    show(t)
    if t.get('verify'):  # done/deliver 前重算：代码一变旧验证回执自动失效（告警不阻塞）
        state, changed, _ = verify_status(t)
        if state == 'stale':
            print(f"警告：验证回执已 stale（文件已变更: {', '.join(changed)}）——旧验证/旧评审自动失效，建议重新 verify 后再交付")
    if a.by and a.by != t['owner']:
        print(f"实际执行者 {a.by} 已记录（owner={t['owner']}）")
    elif not a.by and t['owner'] in ('', '编排者'):
        print('提醒：owner 为空或编排者时建议用 --by <执行专家名> 记录实际执行者（多专家/门禁条目）')
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


def cmd_fail(a, data, path):
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可标记失败")
    t['status'] = 'failed'
    t['fail'] = a.reason or ''
    t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_retry(a, data, path):
    t = get_task(data, a.id)
    if t['status'] != 'failed':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 failed 可重试")
    t['status'] = 'ready'
    t['fail'] = ''
    t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_progress(a, data, path):
    t = get_task(data, a.id)
    check_attempt(a, t)
    ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
    t.setdefault('checkpoints', []).append({'time': ts, 'note': a.note})
    t['updated'] = now_ms()
    _reset_nudges(t)  # 检查点=活着的证据：滑动无进展窗口重臂，连续未响应 nudge 计数清零
    save(path, data)
    show(t)
    print(f"  最新检查点({len(t['checkpoints'])}): [{ts}] {a.note}")


# ── 滑动无进展 watchdog + 孤儿 adopt（v2.7，WP-4b/S2）────────────────────────
# 语义（对齐 swarm watchdog 原型）：
#   滑动窗口而非固定超时——activity = max(updated, heartbeat_at, nudged_at)，claim/progress/heartbeat/
#   reassign 都会推进它；「健康的孩子永远不会因为跑得久被杀」。窗口到期先 nudge（记数 + 置 nudged_at
#   重臂一个窗口），连续 max_nudges 次 nudge 无响应才升级：升级时先在落盘信箱（收件箱/归档/发件箱）
#   里找本任务本 attempt 的完成报告——找到则 adopt（采纳为 done，工作比它的 agent 活得久），找不到才
#   reclaim（撤销代际、释放回 ready）。计数与状态判定以事件流折叠状态为准，所有变更走既有事件追加路径
#   （watchdog/heartbeat 均为写命令，一个事件携带全部变更任务的 after 快照），既有命令 stdout/stderr
#   零变化；新字段 heartbeat_at/nudges/nudged_at 随任务快照折叠，向后兼容只增不减。
WATCHDOG_ACTIVITY_FIELDS = ('heartbeat_at', 'nudged_at')


def _reset_nudges(t):
    """活着的证据（claim 新代际/progress/heartbeat）：清零连续未响应 nudge 计数。"""
    t['nudges'] = 0
    t.pop('nudged_at', None)


def cmd_heartbeat(a, data, path):
    """heartbeat <id>：running 任务的心跳——重臂滑动无进展窗口并清零 nudge 计数（长任务主动报活，
    代替「必须产出检查点」的最小信号）。带 --attempt 时按代际校验（与 progress 同语义）。"""
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可心跳")
    t['heartbeat_at'] = now_ms()
    _reset_nudges(t)
    t['updated'] = t['heartbeat_at']
    save(path, data)
    show(t)


def _completion_evidence(tid, t, bus_root):
    """孤儿 adopt 证据（S2 断言 d）：在落盘信箱里找本任务、本 attempt、本 owner 的完成报告。
    检查位置：收件箱 coordinator/、归档 _archive/coordinator/（过代过滤误杀/整轮未读的最终去向）、
    发件箱 _outbox/<owner>/（投递中断的挂起副本）——「落盘即算送达」是 adopt 的立足点。
    完成报告判定（T11 回炉 M1/M2，确定性启发，针对本工作区实际汇报约定）：
    - 硬约束（缺一不可）：task 与 attempt_id 均与当前任务一致（防跨代采纳）、from==owner；
    - 强证据：subject 以「[交付]」开头 → 直接构成采纳证据（协议级显式交付标记，协议文本由 T12 写入，
      本工具只负责识别；能伪造该标记即能直改主板，同信任级别，不再叠加词汇启发）；
    - 词汇启发（无强证据时）：① body 不含负向词汇「继续/进行中/下一步/开始/即将/计划/待」任一——
      协议检查点模板词汇（「已完成…；产物:路径」）类过程汇报的负向守卫，防中途汇报被误标 done；
      ② 「完成」须出现在 subject（过程汇报的「完成」多在 body 叙述）；③ subject+body 含交付词汇
      （产物/改动/交付/文件/路径）。任务 id 字面不再是必要条件（M2：合规完成报告 subject 可无任务
      id 字面——硬约束已按结构化字段精确匹配，字面冗余检查只会把合规报告误判 reclaim、让证据随
      代际作废）。多条命中取 ts 最新（最终报告晚于过程汇报）。返回 (msg, 位置标记) 或 (None, '')。"""
    if not t.get('owner') or not t.get('attempt_id'):
        return None, ''
    locations = [
        ('inbox', os.path.join(bus_root, 'coordinator')),
        ('archive', os.path.join(bus_root, '_archive', 'coordinator')),
        ('outbox', os.path.join(bus_root, '_outbox', t['owner'])),
    ]
    delivery_words = ('产物', '改动', '交付', '文件', '路径')
    negative_words = ('继续', '进行中', '下一步', '开始', '即将', '计划', '待')  # M1①：过程汇报负向守卫（只看 body，规格如此）
    delivery_mark = '[交付]'  # M1③：协议交付标记强证据（识别先行，协议文本 T12 落地）
    best, best_loc, best_ts = None, '', -1
    for loc, d in locations:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if not name.endswith('.json'):
                continue
            try:
                with open(os.path.join(d, name), encoding='utf-8') as f:
                    m = json.load(f)
            except Exception:
                continue  # 信箱残件不阻塞 watchdog（bus.py 侧有自己的损坏语义）
            if not isinstance(m, dict):
                continue
            if m.get('task') != tid or m.get('attempt_id') != t.get('attempt_id') or m.get('from') != t.get('owner'):
                continue
            subject, body = m.get('subject', '') or '', m.get('body', '') or ''
            if not subject.startswith(delivery_mark):  # 强证据路径：身份约束外免词汇启发（见 docstring 威胁模型）
                if any(w in body for w in negative_words):  # M1①：负向词汇守卫——body 含过程词汇不作完成证据
                    continue
                if '完成' not in subject:  # M1②：「完成」须在 subject（过程汇报的「完成」多在 body 叙述）
                    continue
                if not any(w in f'{subject} {body}' for w in delivery_words):
                    continue
            ts = m.get('ts') if isinstance(m.get('ts'), int) and not isinstance(m.get('ts'), bool) else 0
            if ts > best_ts:
                best, best_loc, best_ts = m, loc, ts
    return best, best_loc


def cmd_watchdog(a, data, path):
    """watchdog：扫描全部 running 任务的滑动无进展窗口；到期 nudge（重臂），连续 max_nudges 次无响应
    升级——先查落盘完成报告（任务板检查点轨迹已由 activity 覆盖：检查点即 progress，天然重臂窗口；
    完成报告落盘证据在 bus 收件箱/归档/发件箱），有证据 adopt 为 done，无证据 reclaim 回 ready 并撤销
    当前代际。全部变更合入一个 watchdog 事件（after 快照差分），stdout 为新增命令自有契约；
    adopt 显式记录实际执行者（executors，对齐手工 done --by 审计），汇总行输出 healthy 计数。"""
    window_ms = max(0, a.window_sec) * 1000
    max_nudges = max(0, a.max_nudges)
    bus_root = a.bus_root or os.path.join(os.getcwd(), '.expert-bus')
    now = now_ms()
    adopted, reclaimed, nudged, changed = 0, 0, 0, 0
    healthy = 0
    lines = []
    for tid in sorted(data['tasks'], key=lambda x: int(x[1:])):
        t = data['tasks'][tid]
        if t['status'] != 'running':
            continue
        activity = max([t.get('updated', 0)] + [t.get(k, 0) or 0 for k in WATCHDOG_ACTIVITY_FIELDS])
        stale_s = max(0, now - activity) // 1000
        if now - activity <= window_ms:
            healthy += 1  # 健康：窗口内有过活着的证据，永不因跑得久被盯上
            continue
        nudges = t.get('nudges') or 0
        if nudges < max_nudges:
            t['nudges'] = nudges + 1
            t['nudged_at'] = now  # nudge 重臂一个窗口；连续无响应计数不清零（progress/heartbeat 才清）
            ts = datetime.datetime.fromtimestamp(now / 1000).strftime('%Y-%m-%d %H:%M:%S')
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"watchdog: nudge 第{t['nudges']}次（无进展 {stale_s}s，window={a.window_sec}s）"})
            t['updated'] = now
            nudged += 1
            changed += 1
            lines.append(f"{tid} [running] owner={t['owner'] or '（未分配）'} 无进展 {stale_s}s "
                         f"nudge={t['nudges']}/{max_nudges} → 已 nudge（重臂 window={a.window_sec}s，等 heartbeat/progress 响应）")
            continue
        m, loc = _completion_evidence(tid, t, bus_root)
        att = t.get('attempt_id') or ''
        if m is not None:
            summary = f"{m.get('subject', '')}：{(m.get('body') or '')[:160]}"
            t['status'] = 'done'
            t['summary'] = f"[watchdog adopt] {summary}"
            ts = datetime.datetime.fromtimestamp(now / 1000).strftime('%Y-%m-%d %H:%M:%S')
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"watchdog: adopt（发现落盘完成报告 {m.get('id')}@{loc}，attempt={att}）→ done"})
            # 采纳建议②：对齐手工 done --by 的审计丰富度——adopt 是异常路径（专家进程已死、由 watchdog
            # 代收），显式落 executors（证据消息 from==owner 即实际执行者），show/metrics 事后可追溯。
            t.setdefault('executors', []).append({'name': m.get('from') or t.get('owner') or '未知', 'time': ts})
            t['updated'] = now
            adopted += 1
            changed += 1
            lines.append(f"{tid} [running] owner={t['owner'] or '（未分配）'} 无进展 {stale_s}s nudge={nudges}/{max_nudges}"
                         f" → 已采纳为 done（落盘完成报告 {m.get('id')}@{loc}）；完成标准：{t.get('desc', '')[:60]}")
        else:
            orig_owner = t.get('owner') or '未分配'
            t['status'] = 'ready'
            if att:
                t.setdefault('attempt_revoked', []).append(att)  # 孤儿代际撤销：旧 attempt 的迟到汇报按 stale_attempt 拒
                t.pop('attempt_id', None)
            t['owner'] = ''
            t['nudges'] = 0
            t.pop('nudged_at', None)
            t.pop('heartbeat_at', None)
            ts = datetime.datetime.fromtimestamp(now / 1000).strftime('%Y-%m-%d %H:%M:%S')
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"watchdog: reclaim（{max_nudges} 次 nudge 无响应且无落盘完成证据）→ ready；attempt {att or '（无）'} 已撤销"})
            t['updated'] = now
            reclaimed += 1
            changed += 1
            lines.append(f"{tid} [running] owner=（原 {orig_owner}）无进展 {stale_s}s nudge={nudges}/{max_nudges}"
                         f" → 已 reclaim（无落盘完成证据；attempt {att or '（无）'} 撤销，转 ready 待重新派工）")
    if not lines:
        if healthy:
            print(f"watchdog: {healthy} 个 running 任务全部健康（window={a.window_sec}s 内均有活动证据，未做任何变更）")
        else:
            print(f"watchdog: 无 running 任务（window={a.window_sec}s max_nudges={max_nudges}）")
        return
    if changed:
        promoted = refresh(data)
        save(path, data)
        if promoted:
            lines.append('依赖已满足，自动转 ready: ' + ' '.join(promoted))
    else:
        lines.append('（本轮无变更）')
    print(f"watchdog: window={a.window_sec}s max_nudges={max_nudges} bus_root={bus_root}")
    for ln in lines:
        print(ln)
    # 采纳建议③：有变更轮次也输出 healthy 计数（健康任务不因同轮有变更而不可见；无变更轮次的
    # 「全部健康」分支本就带计数，两分支口径一致）。
    print(f"watchdog: nudge={nudged} adopt={adopted} reclaim={reclaimed} healthy={healthy}")


def cmd_recover(a, data, path):
    n = 0
    for t in data['tasks'].values():
        if t['status'] == 'running':
            t['status'] = 'ready'
            t['updated'] = now_ms()
            n += 1
    save(path, data)
    print(f'已恢复 {n} 个 running 任务为 ready')


def cmd_reassign(a, data, path):
    """转派：先拒绝复活任何已撤销代际，再撤销旧 attempt（记入 attempt_revoked），建立新代际；
    旧代际的 done/fail/progress 随后被拒。"""
    t = get_task(data, a.id)
    revoked = t.get('attempt_revoked') or []
    if a.attempt_id in revoked:
        raise BoardError('stale_attempt', attempt=a.attempt_id, current=t.get('attempt_id'),
                         revoked=revoked,
                         hint='该 attempt 已被撤销，不能经 reassign 复活；请使用全新的 attempt_id')
    old = t.get('attempt_id')
    if old and old != a.attempt_id:
        t.setdefault('attempt_revoked', []).append(old)
    t['attempt_id'] = a.attempt_id
    _reset_nudges(t)  # 新代际=新起点：旧代积攒的未响应 nudge 不带入
    t.pop('heartbeat_at', None)
    if a.owner:
        t['owner'] = a.owner
    t['updated'] = now_ms()
    save(path, data)
    show(t)
    print(f"旧 attempt {old or '（无）'} 已撤销，当前代际 {a.attempt_id}")


def cmd_set_dependencies(a, data, path):
    """改依赖：写入前全图环检测；仅 pending/ready 可改，满足/不满足时在 pending<->ready 间自动流转。"""
    t = get_task(data, a.id)
    if t['status'] not in ('pending', 'ready'):
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 pending/ready 可改依赖")
    deps = [d.strip() for d in (a.dep or '').split(',') if d.strip()]
    for d in deps:
        if d not in data['tasks']:
            sys.exit(f"错误：依赖任务 {d} 不存在")
    ensure_acyclic(data['tasks'], a.id, deps)
    t['dep'] = deps
    ok, _ = deps_state(t, data['tasks'])
    if t['status'] == 'pending' and ok:
        t['status'] = 'ready'
        t['updated'] = now_ms()
    elif t['status'] == 'ready' and not ok:
        t['status'] = 'pending'
        t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_deps(a, data, _):
    t = get_task(data, a.id)

    def walk(task, depth, seen):
        print('  ' * depth + f"{task['id']} [{task['status']}] {task['title']}")
        for d in task['dep']:
            if d in seen:
                print('  ' * (depth + 1) + f"{d}（循环引用，已跳过）")
                continue
            seen.add(d)
            walk(data['tasks'][d], depth + 1, seen)

    walk(t, 0, {a.id})


def cmd_status(a, data, _):
    counts = {}
    for t in data['tasks'].values():
        counts[t['status']] = counts.get(t['status'], 0) + 1
    print('状态统计: ' + (' '.join(f"{k}={v}" for k, v in sorted(counts.items())) or '空'))
    ready = [t for t in data['tasks'].values() if t['status'] == 'ready']
    failed = [t for t in data['tasks'].values() if t['status'] == 'failed']
    running = [t for t in data['tasks'].values() if t['status'] == 'running']
    if ready:
        print('可认领: ' + ' '.join(t['id'] for t in ready))
    if running:
        print('进行中: ' + ' '.join(t['id'] for t in running))
    if failed:
        print('失败待重试: ' + ' '.join(t['id'] for t in failed))
    for t in running + failed:
        cp = last_checkpoint(t)
        if cp:
            print(f"  {t['id']} 最新检查点: [{cp['time']}] {cp['note']}")


def cmd_metrics(a, data, _):
    if not data['tasks']:
        print('（任务板为空，无数据可聚合）')
        return
    agg = {}
    for t in data['tasks'].values():
        o = t['owner'] or '（未分配）'
        s = agg.setdefault(o, [0, 0, 0])
        s[0] += 1
        s[1] += t.get('rework') or 0
        if t.get('switched'):
            s[2] += 1
    for o, (n, rw, sw) in sorted(agg.items(), key=lambda kv: (-kv[1][0], kv[0])):
        print(f"{o} | 任务数 {n} | 累计返工 {rw} | 换人 {sw}")



# ── 门禁执法平面（v2.6）：commit-msg hook 双平面执法，默认关闭、显式开启 ──────
# hook 本体选型：POSIX sh 薄壳（无 bash/第三方依赖），校验逻辑内嵌 python3 调本工具
# _hook-check——任务板解析/校验只此一处（与工具平面同一套裁决，taskboard.py 板格式
# 演进时 hook 不需重装），比把板解析复制进 shell 更稳。降级：脚本缺失放行并告警。
HOOK_TEMPLATE = '''#!/bin/sh
# dsh-expert-orchestrator commit-msg 门禁 hook（由 taskboard.py --install-hook 安装，零依赖：POSIX sh + python3 + git）
# {FPH}
# 三查：① 提交消息须可解析出任务 id（形如 T<数字>）；② 消息中解析出的全部任务 id 均须在板内且状态 running；
#       ③ 各任务 scope 的并集内，提交文件均须落在关联域内。
# 解除：python3 "{TB}" --uninstall-hook（凭上方指纹标记行辨认本插件 hook，仅移除本插件安装的）
# 降级（fail-open，均告警放行不阻塞提交）：门禁脚本缺失 / python3 不可用 / 任务板缺失（含 archive 归档后）；
#       三查不过则拒绝提交（fail closed）。
TB="{TB}"
if [ ! -f "$TB" ]; then
  echo "expert-orchestrator 门禁：脚本缺失（$TB 不存在），本次提交放行；请重装插件后重新 --install-hook，或 --uninstall-hook 移除本 hook" >&2
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "expert-orchestrator 门禁：python3 不可用，本次提交放行（fail-open，门禁未执行）；安装 python3 后门禁自动恢复，或用 --uninstall-hook 移除本 hook" >&2
  exit 0
fi
python3 "$TB"{BOARD_ARG} _hook-check "$1"
status=$?
if [ $status -ne 0 ]; then
  echo "expert-orchestrator 门禁：提交被拒绝（原因见上方输出）；核对任务板状态/提交消息/文件范围，紧急情况可用 git commit --no-verify 跳过一次" >&2
  exit 1
fi
exit 0
'''
# 指纹标记行协议版本：稳定字符串，不随模板内容演进变化——卸载/重装凭标记行前缀辨认本插件 hook，
# 模板任何一改都不会把已装 hook 变成"无法用工具卸载"的死 hook（评审项 ①）。
# 旧版（模板整体哈希形态）标记行同样以该前缀开头，天然被认得——即旧版兼容回退。
_HOOK_PROTOCOL_VERSION = 'v1'
_HOOK_INSTALL_MARK = '# dsh-expert-orchestrator hook fingerprint:'


def _hook_content(board):
    board_arg = f' --board "{os.path.abspath(board)}"' if board else ''
    return HOOK_TEMPLATE.replace('{FPH}', _HOOK_INSTALL_MARK + ' ' + _HOOK_PROTOCOL_VERSION) \
                        .replace('{TB}', os.path.abspath(__file__)) \
                        .replace('{BOARD_ARG}', board_arg)


def find_git_dir():
    """从 cwd 向上找 .git（目录或 worktree 指针文件）；找不到则退出报错。"""
    d = os.getcwd()
    while True:
        g = os.path.join(d, '.git')
        if os.path.isdir(g):
            return g
        if os.path.isfile(g):
            try:
                first = open(g, encoding='utf-8').read().strip()
            except Exception:
                first = ''
            if first.startswith('gitdir:'):
                p = first[len('gitdir:'):].strip()
                return p if os.path.isabs(p) else os.path.join(d, p)
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit('错误：当前目录不在 git 仓库内（未找到 .git）；--install-hook/--uninstall-hook 需在仓库内执行')
        d = parent


def cmd_install_hook(a):
    """写入 .git/hooks/commit-msg：内容一致幂等返回；含本插件指纹标记行视为旧版插件 hook，允许原地升级覆盖；
    无标记行的外部 hook 报错退出不覆盖。"""
    target = os.path.join(find_git_dir(), 'hooks', 'commit-msg')
    content = _hook_content(a.board)
    if os.path.exists(target):
        with open(target, encoding='utf-8', errors='replace') as f:
            cur = f.read()
        if cur == content:
            print(f'expert-orchestrator 门禁 hook 已安装（{os.path.relpath(target)}），无需重复操作')
            return
        if _HOOK_INSTALL_MARK in cur:
            # 本插件旧版模板安装的 hook：模板演进后原地升级（卸载/重装不因模板内容变化被锁死，评审项 ① 同源）
            with open(target, 'w', encoding='utf-8') as f:
                f.write(content)
            os.chmod(target, 0o755)
            print(f'expert-orchestrator 门禁 hook 已升级覆盖（{os.path.relpath(target)}，检测到本插件指纹标记行）')
            return
        sys.exit(f'错误：{os.path.relpath(target)} 已存在且非当前插件 hook（内容不一致），拒绝覆盖；'
                 f'确认后先 --uninstall-hook（仅移除本插件安装的）或手工处理既有 hook')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'w', encoding='utf-8') as f:
        f.write(content)
    os.chmod(target, 0o755)
    print(f'expert-orchestrator 门禁 hook 已安装: {os.path.relpath(target)}')
    print('  三查：提交消息含任务 id（T<数字>）｜消息中全部任务 id 在板内且 running｜提交文件落在各任务 scope 并集内（未声明 scope 跳过）')
    print('  降级：门禁脚本缺失 / python3 不可用 / 任务板缺失（含 archive 后）均放行并告警；紧急情况 git commit --no-verify 可跳过一次')
    if a.board:
        print(f'  校验板已固化为: {os.path.abspath(a.board)}')


def cmd_uninstall_hook(a):
    """仅移除本插件安装的 hook：凭稳定指纹标记行辨认（不认全文/模板哈希，模板演进不影响卸载；
    旧版哈希形态标记行同被认得），无标记行则拒绝（不破坏用户自有 hook）。"""
    target = os.path.join(find_git_dir(), 'hooks', 'commit-msg')
    if not os.path.exists(target):
        print(f'未安装 expert-orchestrator 门禁 hook（{os.path.relpath(target)} 不存在）')
        return
    with open(target, encoding='utf-8', errors='replace') as f:
        cur = f.read()
    if _HOOK_INSTALL_MARK not in cur:
        sys.exit(f'错误：{os.path.relpath(target)} 存在但非本插件安装（指纹不匹配：未找到本插件指纹标记行 {_HOOK_INSTALL_MARK}），拒绝删除')
    os.remove(target)
    print(f'已移除 expert-orchestrator 门禁 hook: {os.path.relpath(target)}')


def _staged_files():
    """commit-msg 时点暂存区文件清单（unborn HEAD 下 git diff --cached 与空树比较，实测可用）；
    git 异常时返回 None（调用方跳过范围检查并注明，不误伤）。"""
    try:
        r = subprocess.run(['git', 'diff', '--cached', '--name-only', '-z'],
                           capture_output=True, timeout=10)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return [s.decode('utf-8', 'replace') for s in r.stdout.split(b'\x00') if s]


def _scope_match(fname, scope):
    return any(fname == s or fname.startswith(s + '/') for s in scope)


def cmd_hook_check(a, data, path):
    """commit-msg hook 三查（cwd=仓库根，git 调用；exit 1 = 拒绝提交）。
    降级（fail-open）：任务板缺失（含 archive 归档把板移走——归档收口属预期流程，hook 不再阻塞提交）
    时 stderr 告警放行并提示 --install-hook/--uninstall-hook 逃生口；
    板在而三查不过（含消息含夹带的假 id/非 running id）则 fail closed。"""
    if not os.path.exists(path):
        print(f'expert-orchestrator 门禁告警：任务板不存在（{path}），本次提交放行（fail-open）；'
              f'板已 archive 归档或移走属预期，若仍需门禁请重新 --install-hook，不再需要请 --uninstall-hook 移除本 hook',
              file=sys.stderr)
        return
    try:
        with open(a.msgfile, 'rb') as f:
            msg = f.read().decode('utf-8', 'replace')
    except Exception as e:
        sys.exit(f'expert-orchestrator 门禁拒绝：提交消息不可读（{e}）')
    ids = parse_task_ids(msg)
    if not ids:
        sys.exit('expert-orchestrator 门禁拒绝：提交消息未解析出任务 id（形如 T<数字>）；'
                 '在消息中注明任务 id（如 "feat: xxx T3"）')
    # ② 全部任务 id 逐个核（防夹带）：消息解析出的每个 id 都须在板内且 running，任一不满足即拒
    for tid in ids:
        t = data['tasks'].get(tid)
        if not t:
            sys.exit(f'expert-orchestrator 门禁拒绝：任务 {tid} 不在任务板内（板: {os.path.relpath(path)}）')
        if t['status'] != 'running':
            sys.exit(f'expert-orchestrator 门禁拒绝：任务 {tid} 状态为 {t["status"]}，门禁要求 running（先 claim 再提交）')
    # ③ scope 取全部引用任务 scope 的并集：多任务同 commit 时文件命中任一任务的 scope 即可
    scopes = []
    for tid in ids:
        for s in (data['tasks'][tid].get('scope') or []):
            if s not in scopes:
                scopes.append(s)
    if scopes:
        files = _staged_files()
        if files is None:
            print('expert-orchestrator 门禁提示：无法获取暂存区文件清单，本次跳过 scope 范围检查')
        else:
            bad = [f for f in files if not _scope_match(f, scopes)]
            if bad:
                sys.exit(f'expert-orchestrator 门禁拒绝：{len(bad)} 个提交文件超出任务 {",".join(ids)} scope '
                         f'（并集: {", ".join(scopes)}）: {", ".join(sorted(bad)[:5])}')
            print(f'expert-orchestrator 门禁通过: {",".join(ids)} running，{len(files)} 个文件均在 scope 并集内')
            return
    print(f'expert-orchestrator 门禁通过: {",".join(ids)} running' + ('' if scopes else '（任务未声明 scope，跳过范围检查）'))


def default_board():
    """无 --board 时：遗留 .expert-taskboard.json 优先，否则用 .expert-taskboards/default.json。"""
    legacy = os.path.join(os.getcwd(), '.expert-taskboard.json')
    if os.path.exists(legacy):
        return legacy
    return os.path.join(os.getcwd(), '.expert-taskboards', 'default.json')


def all_boards():
    """当前目录下的全部任务板（含遗留文件与 .expert-taskboards/*.json）。"""
    found = []
    legacy = os.path.join(os.getcwd(), '.expert-taskboard.json')
    if os.path.exists(legacy):
        found.append(legacy)
    gdir = os.path.join(os.getcwd(), '.expert-taskboards')
    if os.path.isdir(gdir):
        found.extend(sorted(glob.glob(os.path.join(gdir, '*.json'))))
    return found


def cmd_boards(a, _data=None):
    found = all_boards()
    if not found:
        print('（当前目录没有任务板）')
        return
    for p in found:
        try:
            data = json.load(open(p, encoding='utf-8'))
            tasks = data.get('tasks', {})
            st = collections.Counter(t['status'] for t in tasks.values())
            upd = max([t.get('updated', 0) for t in tasks.values()] or [0])
            ts = datetime.datetime.fromtimestamp(upd / 1000).strftime('%m-%d %H:%M') if upd else '-'
            dist = ' '.join(f'{k}={v}' for k, v in sorted(st.items())) or '空'
            print(f"{os.path.relpath(p)} | {len(tasks)} 任务 | {dist} | 最近更新 {ts}")
        except Exception:
            print(f'{os.path.relpath(p)} （损坏）')  # 解析失败或深层结构损坏都不裸 traceback


def cmd_replay(a, data, path):
    """replay：显式从事件流重放折叠状态并重写视图文件（幂等）。
    崩溃恢复的常规路径是任意命令加载时自动重放；本命令用于人工核对与崩溃演练。"""
    save_view(path, data)
    print(f"已从事件流重放折叠状态: event_seq={data.get('event_seq', 0)} "
          f"revision={data.get('revision', 0)} 任务数={len(data['tasks'])} "
          f"state_hash={str(data.get('event_state_hash', ''))[:16]}")


def cmd_archive(a, data, path):
    open_tasks = [t for t in data['tasks'].values() if t['status'] not in ('done', 'failed')]
    if open_tasks and not a.force:
        listing = ', '.join(f"{t['id']}[{t['status']}]" for t in open_tasks)
        sys.exit(f'拒绝归档：还有未收口任务 {listing}；先 done/fail，或确认放弃用 --force')
    os.makedirs('.expert-taskboards/archive', exist_ok=True)
    name = time.strftime('%Y%m%d-%H%M%S') + '-' + os.path.basename(path)
    target = os.path.join('.expert-taskboards', 'archive', name)
    ep = events_path(path)
    moved_log = os.path.exists(ep)
    if moved_log:
        # 先迁事件流后迁板（二轮评审重要-2）：两步间被杀时顶层残留的是板（折叠视图）而非孤儿事件流
        # ——视图仍可直读降级、下次写以视图重新收编，数据零丢失；反序则顶层孤儿日志会被读命令按权威
        # 静默复活旧板、被同名 create 续链（跨板劫持）。归档区孤儿日志无代码枚举消费，可接受。
        os.replace(ep, events_path(target))
    os.replace(path, target)
    print(f'已归档 {os.path.relpath(path)} -> .expert-taskboards/archive/{name}')
    if moved_log:  # 事件流（状态权威）随板一并归档，重放能力不因归档丢失
        print(f'事件日志已一并归档: .expert-taskboards/archive/{os.path.basename(events_path(target))}')


def main():
    ap = argparse.ArgumentParser(description='expert-orchestrator 任务板')
    ap.add_argument('--board', help='状态文件路径，默认 <cwd>/.expert-taskboard.json；--install-hook 时可固化项目板进 hook')
    ap.add_argument('--install-hook', action='store_true',
                    help='门禁执法平面（默认关闭）：向当前仓库 .git/hooks/commit-msg 安装零依赖三查 hook；已有同名 hook 报错不覆盖')
    ap.add_argument('--uninstall-hook', action='store_true',
                    help='仅移除本插件安装的 commit-msg hook（凭稳定指纹标记行辨认，不破坏用户自有 hook）')
    sub = ap.add_subparsers(dest='cmd')

    def add_write_args(p):
        p.add_argument('--expected-revision', type=int, default=None,
                       help='CAS 乐观锁：期望的板级 revision，不符则拒绝写入（stale_revision）；缺省不校验（与旧版一致）')

    def add_attempt_arg(p):
        p.add_argument('--attempt', default=None,
                       help='派工代际 attempt_id；与任务当前代际不符则拒绝（stale_attempt）；缺省不校验（与旧版一致）')

    p = sub.add_parser('create')
    p.add_argument('title')
    p.add_argument('--owner')
    p.add_argument('--dep', help='逗号分隔的依赖任务ID')
    p.add_argument('--desc', help='完成标准')
    p.add_argument('--scope', help='关联域（逗号分隔路径前缀，如 src,docs）；hook 第三查与验证回执的依据')
    add_write_args(p)
    p.set_defaults(fn=cmd_create)

    p = sub.add_parser('list')
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser('show'); p.add_argument('id'); p.set_defaults(fn=cmd_show)
    p = sub.add_parser('claim'); p.add_argument('id'); p.add_argument('owner', nargs='?'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_claim)
    p = sub.add_parser('done'); p.add_argument('id'); p.add_argument('summary', nargs='?'); p.add_argument('--rework', type=int, help='返工次数'); p.add_argument('--switched', action='store_true', help='中途换人'); p.add_argument('--by', help='实际执行专家名'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_done)
    p = sub.add_parser('fail'); p.add_argument('id'); p.add_argument('reason', nargs='?'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_fail)
    p = sub.add_parser('retry'); p.add_argument('id'); add_write_args(p); p.set_defaults(fn=cmd_retry)
    p = sub.add_parser('progress'); p.add_argument('id'); p.add_argument('note'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_progress)
    p = sub.add_parser('heartbeat'); p.add_argument('id'); add_attempt_arg(p); add_write_args(p)
    p.set_defaults(fn=cmd_heartbeat,
                   help='running 任务心跳：重臂滑动无进展窗口并清零 nudge 计数（watchdog 用，长任务报活）')
    p = sub.add_parser('watchdog')
    p.add_argument('--window-sec', type=int, default=1800, help='滑动无进展窗口秒数（默认 1800；0=立即可判定，测试/演练用）')
    p.add_argument('--max-nudges', type=int, default=2, help='连续 nudge 无响应上限（默认 2；达到后升级 adopt/reclaim）')
    p.add_argument('--bus-root', help='完成报告落盘信箱根目录，默认 <cwd>/.expert-bus（收件箱/归档/发件箱均纳入检索）')
    add_write_args(p)
    p.set_defaults(fn=cmd_watchdog,
                   help='滑动无进展看门狗：到期 nudge 重臂，连续无响应先查落盘完成报告（有→adopt 为 done，无→reclaim 回 ready 并撤销代际）')
    p = sub.add_parser('metrics'); p.set_defaults(fn=cmd_metrics)

    p = sub.add_parser('recover'); add_write_args(p); p.set_defaults(fn=cmd_recover)
    p = sub.add_parser('deps'); p.add_argument('id'); p.set_defaults(fn=cmd_deps)
    p = sub.add_parser('status'); p.set_defaults(fn=cmd_status)
    p = sub.add_parser('boards'); p.set_defaults(fn=cmd_boards)
    p = sub.add_parser('archive'); p.add_argument('--force', action='store_true'); p.set_defaults(fn=cmd_archive)
    p = sub.add_parser('reassign'); p.add_argument('id'); p.add_argument('attempt_id', help='新派工代际 attempt_id（编排者生成）'); p.add_argument('--owner'); add_write_args(p); p.set_defaults(fn=cmd_reassign)
    p = sub.add_parser('set_dependencies'); p.add_argument('id'); p.add_argument('--dep', required=True, help='逗号分隔的依赖任务ID（整体替换）'); add_write_args(p); p.set_defaults(fn=cmd_set_dependencies)
    p = sub.add_parser('verify'); p.add_argument('id'); p.add_argument('files', nargs='*', help='文件范围清单；缺省=重算既有回执输出 fresh/stale'); add_write_args(p); p.set_defaults(fn=cmd_verify)
    p = sub.add_parser('replay'); p.set_defaults(fn=cmd_replay,
                                                 help='显式从事件流重放折叠状态并重写视图文件（幂等；崩溃演练/人工核对）')
    p = sub.add_parser('_hook-check', help=argparse.SUPPRESS)  # commit-msg hook 内部入口，非用户命令
    p.add_argument('msgfile'); p.set_defaults(fn=cmd_hook_check)

    a = ap.parse_args()
    if (a.install_hook or a.uninstall_hook) and a.cmd:
        ap.error('--install-hook/--uninstall-hook 不与任务板子命令同时使用')
    if a.install_hook:
        cmd_install_hook(a)
        return
    if a.uninstall_hook:
        cmd_uninstall_hook(a)
        return
    if not a.cmd:
        ap.error('the following arguments are required: cmd（或 --install-hook / --uninstall-hook）')
    try:
        if a.cmd == 'boards':
            a.fn(a)
            return
        path = a.board or default_board()
        with board_lock(path):  # 进程互斥：load -> CAS 校验 -> 写入整体原子（TOCTOU 防护）
            data = load(path)
            check_revision(a, data)  # 写命令的 CAS 校验，锁内针对最新落盘状态（读命令无该参数，透传为不校验）
            _arm_event_ctx(a, data)  # 事件溯源：写命令派发前武装事件上下文（pre 快照/收编种子）
            a.fn(a, data, path)
            if a.cmd not in ('archive', '_hook-check'):
                print(f"revision={data.get('revision', 0)}")
    except BoardError as e:
        payload = {'error': e.code}
        payload.update(e.fields)
        if e.code == 'unrecoverable':
            payload['unrecoverable'] = True
        print(json.dumps(payload, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:  # 兜底：深层结构异常等绝不裸 traceback，统一具名 unrecoverable JSON
        print(json.dumps({'error': 'unrecoverable', 'unrecoverable': True,
                          'reason': f'命令执行异常: {type(e).__name__}: {e}'}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
