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
验证回执范围指纹（v2.6）：verify <id> <文件...> 对完成汇报附带文件清单逐文件记 SHA-256（整表 digest 存板）；
  verify <id>（无文件）与 show/done 均重算比对，文件一变回执即标 stale（旧验证/旧评审自动失效），done 时 stale 仅告警不阻塞。
"""
import argparse, collections, contextlib, datetime, glob, hashlib, json, os, re, subprocess, sys, time, uuid

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


def load(path):
    if not os.path.exists(path):
        return {'tasks': {}, 'seq': 0, 'revision': 0}
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        raise _unrecoverable(path, f'JSON 解析失败: {e}')
    if not isinstance(data, dict):
        raise _unrecoverable(path, '结构非法：板文件顶层不是对象')
    data.setdefault('revision', 0)  # 旧板无 revision 字段兼容
    _validate_board(data, path)
    return data


def save(path, data):
    """原子落盘：revision 自增后写入唯一 tmp（含 pid+uuid 后缀，多进程共用板不互截），os.replace 原子替换。
    须在 board_lock 锁内调用（POSIX），保证 CAS 校验-写入原子。"""
    data['revision'] = int(data.get('revision', 0)) + 1  # CAS：每次写自增
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f'{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


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
    save(path, data)
    show(t)
    print(f"  最新检查点({len(t['checkpoints'])}): [{ts}] {a.note}")


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


def cmd_archive(a, data, path):
    open_tasks = [t for t in data['tasks'].values() if t['status'] not in ('done', 'failed')]
    if open_tasks and not a.force:
        listing = ', '.join(f"{t['id']}[{t['status']}]" for t in open_tasks)
        sys.exit(f'拒绝归档：还有未收口任务 {listing}；先 done/fail，或确认放弃用 --force')
    os.makedirs('.expert-taskboards/archive', exist_ok=True)
    name = time.strftime('%Y%m%d-%H%M%S') + '-' + os.path.basename(path)
    os.replace(path, os.path.join('.expert-taskboards', 'archive', name))
    print(f'已归档 {os.path.relpath(path)} -> .expert-taskboards/archive/{name}')


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
    p = sub.add_parser('metrics'); p.set_defaults(fn=cmd_metrics)

    p = sub.add_parser('recover'); add_write_args(p); p.set_defaults(fn=cmd_recover)
    p = sub.add_parser('deps'); p.add_argument('id'); p.set_defaults(fn=cmd_deps)
    p = sub.add_parser('status'); p.set_defaults(fn=cmd_status)
    p = sub.add_parser('boards'); p.set_defaults(fn=cmd_boards)
    p = sub.add_parser('archive'); p.add_argument('--force', action='store_true'); p.set_defaults(fn=cmd_archive)
    p = sub.add_parser('reassign'); p.add_argument('id'); p.add_argument('attempt_id', help='新派工代际 attempt_id（编排者生成）'); p.add_argument('--owner'); add_write_args(p); p.set_defaults(fn=cmd_reassign)
    p = sub.add_parser('set_dependencies'); p.add_argument('id'); p.add_argument('--dep', required=True, help='逗号分隔的依赖任务ID（整体替换）'); add_write_args(p); p.set_defaults(fn=cmd_set_dependencies)
    p = sub.add_parser('verify'); p.add_argument('id'); p.add_argument('files', nargs='*', help='文件范围清单；缺省=重算既有回执输出 fresh/stale'); add_write_args(p); p.set_defaults(fn=cmd_verify)
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
