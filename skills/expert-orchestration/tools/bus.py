#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert-orchestrator 消息总线：专家与协调官之间的落盘信箱。

信箱目录默认 <cwd>/.expert-bus/，每封信一个 JSON 文件（可 --root 覆盖）。
全局信箱根约定（v2.8 S3 成文，T17；教训池 L128「信箱根随 cwd 漂移」与 v2.6 D1 事故放大器的根治面）：
  解析规则单一且全部消费方同规——信箱根 = 显式 --root 参数，缺省 <cwd>/.expert-bus（cwd 相对）。
  所有 bus 消费方（编排者/专家的 shell 调用、taskboard.py watchdog --bus-root 缺省值、
  lib/tools.js collectResumeProgress 与 trustedBusMessages 的收件箱目录解析）都必须锚定同一
  cwd（=会话工作区根）或显式传同一 --root；在子目录/其他 cwd 下调用会散落出多个互不相通的
  信箱根——发送落 A 根、读取看 B 根，消息「已发未收」且无任何报错（v2.6 D1 过代误判的放大器）。
  约定：bus 调用一律在会话工作区根 cwd 执行；跨根疑云先用 `stats` 对账两边根再排查投递。
用法（既有命令与参数行为全部不变）：
  bus.py send --from 前端工程师 --to coordinator --subject "登录页完成" --body "…" [--file 路径]…
  bus.py read --box coordinator [--unread]
  bus.py read --all-boxes [--unread]
  bus.py ack --box coordinator --id <id> | bus.py ack --box coordinator --all
  bus.py broadcast --from 协调官 --subject "…" --body "…"
  bus.py stats
投递语义（v2.6，默认开启；read 带 --no-attempt-filter 可关闭②③，回到旧版读取行为）：
  ① at-least-once 游标：send 先落发件箱 _outbox/<发送者>/，随后投递——收件箱原子落盘（成功
    回执）才推进游标 _outbox/<发送者>/cursor.json；投递中途崩溃重启后同一条消息按同 id 原子
    重投（幂等），已 ack 消息的重投不复活未读标记；游标文件损坏按安全侧处理：视为未推进、
    全部重投（at-least-once 只会多投不会丢）。发件箱/收件箱/游标/ack 回写均唯一 tmp + os.replace
    原子落盘（ack 复用 write_json_atomic，中途崩溃只留无害 .tmp 残件，不产生收件箱截断毒丸）；旧版遗留的发件箱截断残件在投递时自愈（隔离 .corrupt 并告警后跳过），不毒丸该发送者；
    收件箱截断残件读取时显式 unrecoverable 报错（唯一副本不静默丢）。
  ② 过代过滤：send 可携带 --task <任务id> --attempt <attempt_id>（成对，对接 taskboard.py 的
    派工代际）；read 时与任务板当前代际对账。对账板集合：--board 指定时单板严格（缺失/损坏/结构非法
    返回 {"error":"unrecoverable","unrecoverable":true,...}，不做静默假设）；未指定时按 taskboard.py
    默认规则解析主解析板（遗留 .expert-taskboard.json 优先，否则 .expert-taskboards/default.json，
    存在则严格），并纳入同工作区其余候选板（顶层 *.json，损坏仅 stderr 告警跳过）做多板确认裁决——
    任一候选板确认 attempt 为当前代际且未撤销则保留（修复多板共存工作区下陈旧 default.json 把合法
    当前代际消息误判归档的 S1a 缺陷，跨板救援附 stderr 提示，措辞区分「主解析板缺失」与「主解析板
    不匹配」两种中间态），任一候选板记录撤销则仍归档（撤销权威优先）。attempt 已撤销/非当前代际/
    任务无此代际的消息读取时归档到 _archive/<信箱>/，不进收件箱。
    归档权威（T11 编排者裁决）：归档动作仅在权威板（显式 --board，或默认解析选中的主解析板）在场时
    发生；主解析板缺失但兄弟板在场的降级中间态一律「只确认不归档」——兄弟板确认则保留，未确认（含
    兄弟板记录撤销）同样原样留在收件箱，留待权威板恢复后的全量读处置（堵住陈旧兄弟板把合法消息归档
    的洞：无权威板在场，兄弟板不具归档权威）。威胁模型：能写工作区文件的攻击者本就可伪造兄弟板确认
    或直改主板——伪造板确认=与直改主板同信任级别，接受为非目标；本机制防的是陈旧快照误杀，不防主动
    篡改。过滤是读取时点快照：与 reassign 并发时，刚被撤销代际的消息可能被放行一次，下轮读取再归档。
  ③ skip-round：信箱本轮可见消息为空（--unread 时已读消息不计入可见）且本轮归档了过期消息时，
    输出 "SKIP_ROUND：…" 显式提示（供编排模型据此跳过该轮，省一次模型调用）；真空信箱仍输出
    原有「无消息」文案。
  ④ seq 增量推送（S1b）：send 给消息写入发件人单调 seq（下界=游标 seq 与发件箱全部既有条目 seq 的
    最大值，发件箱条目持久保留故崩溃安全——游标损坏时新消息 seq 也不回退）；投递游标 cursor.json
    随投递同步记 seq（仍仅在投递成功回执后前进，at-least-once 语义不变，重投幂等同 seq）。read
    --box --since-seq N 增量读取：只显示 seq>N 的消息（旧版无 seq 消息按 0 计，仅全量读可见），
    读取输出在消息头展示 seq= 供游标推进；可与 --unread/过代过滤/skip-round 叠加，需与 --box 搭配
    （seq 按发送者单调，跨信箱无全局序）。增量轮询下无新消息输出「无 seq>N 的新消息」（区别于
    真空信箱文案）；seq≤N 的旧消息本轮不参与对账归档（过滤是读取时点快照，留待全量读处置）。
    同发送者并发正确性（T11 回炉 M3/M4）：seq 分配经发件箱锁文件互斥（fcntl.flock，无 fcntl 平台
    降级无锁，写入仍原子）——「扫描下界+条目落盘」在同一临界区内，并发 send 不会扫出重复 seq
    （重复 seq 会让增量游标静默跳过被顶掉的消息）；投递序按 (seq, 文件名) 升序——同毫秒双发时
    文件名序（ts+随机 id）与 seq 序可倒置，按名称序先投高 seq 会让低 seq 永久落后游标、增量消费
    静默漏消息；游标仍记最后投递条目 (name, seq)，续投判定同步按 (seq, name) 字典序（旧版无 seq
    条目按 0 排前，行为兼容）。
测试注入：环境变量 BUS_CRASH_AFTER_DELIVER=1 时，投递落盘后、游标推进前以退出码 70 终止
  （模拟投递中途崩溃；未设置时零影响）。
铁律：发必署名、读必确认；并行专家把完整产出 send 到 coordinator 信箱，最终回复只留摘要。
"""
import argparse, glob, json, os, random, sys, time

try:
    # POSIX 标准库；Windows 等无 fcntl 平台降级（见 send_seq_lock）
    import fcntl
except ImportError:
    fcntl = None

OUTBOX_DIR = '_outbox'  # 发件箱（投递游标持久化所在）
ARCHIVE_DIR = '_archive'  # 过期消息归档
INTERNAL_DIRS = (OUTBOX_DIR, ARCHIVE_DIR)  # 内部目录：不作为信箱列出/广播/统计


class BusError(Exception):
    """具名错误：main 统一以 JSON（stdout）输出并退出码 1，机器可解析（同 taskboard.BoardError 风格）。"""

    def __init__(self, code, **fields):
        super().__init__(code)
        self.code = code
        self.fields = fields


def root(a):
    # 全局信箱根约定（v2.8 S3 成文，见文件头）：显式 --root 优先，缺省 <cwd>/.expert-bus；
    # 全部消费方必须同 cwd（会话工作区根）或同 --root，跨 cwd 调用会散落互不相通的信箱根。
    return a.root or os.path.join(os.getcwd(), '.expert-bus')


def box_dir(a, name):
    return os.path.join(root(a), name)


def write_json_atomic(path, obj):
    """原子落盘（同 taskboard.py save）：唯一 tmp（pid+随机后缀，并发 send 不互截）写入后 os.replace 原子替换。
    tmp 名唯一是毒丸防线的一半：任一时刻 <path> 要么不存在要么是完整 JSON，崩溃只会留下无害的 .tmp 残件。"""
    tmp = f'{path}.{os.getpid()}.{random.randint(0, 0xffffffff):08x}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_msg(a, to, msg):
    d = box_dir(a, to)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{msg['ts']:013d}-{msg['id']}.json")
    write_json_atomic(path, msg)
    return path


def make_id():
    # pid 入 id（T11/M3 配套）：同毫秒跨进程并发 send 不再产生同 id 文件名互覆（后写 os.replace
    # 顶掉先写条目=丢信）；进程内同毫秒极小概率撞随机段为既有窗口，不另行加码。
    return f"m{int(time.time() * 1000)}{os.getpid()}{random.randint(100, 999)}"


# ── ① at-least-once 游标：发件箱 + 投递游标 ─────────────────────────────────

def outbox_dir(a, sender):
    return os.path.join(root(a), OUTBOX_DIR, sender)


def save_cursor(d, name, seq):
    write_json_atomic(os.path.join(d, 'cursor.json'), {'cursor': name, 'seq': seq})


def msg_seq(m):
    """消息 seq 取值（S1b 增量推送）：发件人单调序号；旧版无 seq 的消息按 0 计。"""
    s = m.get('seq')
    return s if isinstance(s, int) and not isinstance(s, bool) and s > 0 else 0


def load_cursor(d):
    """游标 = (最后投递成功的发件箱条目名, 该条目 seq)。损坏按安全侧处理：视为未推进、全部重投
    （at-least-once 只会多投不会丢）；seq 下界随之丢失，但 outbox_next_seq 的文件扫描兜底保证
    新消息 seq 仍单调不回退。"""
    p = os.path.join(d, 'cursor.json')
    if not os.path.exists(p):
        return '', 0
    try:
        with open(p, encoding='utf-8') as f:
            c = json.load(f)
        seq = c.get('seq', 0)
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
            seq = 0
        return c.get('cursor', '') or '', seq
    except Exception:
        return '', 0  # 游标损坏按安全侧处理：视为未推进，全部重投（只会多投不会丢）


def outbox_next_seq(d):
    """下一封消息的 seq（S1b 增量推送游标锚点）：游标记录 seq 与发件箱全部既有条目 seq 的最大值 +1。
    发件箱条目投递后仍持久保留（at-least-once 簿记），文件扫描是崩溃安全的下界——游标损坏/丢失时
    新消息 seq 依旧单调不回退，增量消费方游标（--since-seq）永不重放旧消息；旧版无 seq 条目按 0 计，
    不可解析残件跳过（flush 时自愈隔离，从未完整落盘的消息 seq 视为未占用，最坏产生无害空号）。
    规模预期（T11 建议⑥，本轮不改代码）：本扫描与 flush_outbox 均为发件箱全量 O(n) 文件扫描；条目
    持久保留，预期单发送者量级=每委派数封×项目任务数（千级以内），成本可忽略；单发送者预期达万级
    须先引入 seq 索引再扩展，勿直接沿用本实现。"""
    _name, seq = load_cursor(d)
    if os.path.isdir(d):
        for name in os.listdir(d):
            if not name.endswith('.json') or name == 'cursor.json':
                continue
            try:
                with open(os.path.join(d, name), encoding='utf-8') as f:
                    seq = max(seq, msg_seq(json.load(f)))
            except Exception:
                continue  # 残件：flush 自愈路径处置，这里只求不出 seq 下界
    return seq + 1


def deliver(a, msg):
    """投递一封消息到收件箱（tmp + os.replace 原子落盘）；重投遇到已 ack 的同 id 消息不复活未读标记。"""
    path = os.path.join(box_dir(a, msg['to']), f"{msg['ts']:013d}-{msg['id']}.json")
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                old = json.load(f)
            if old.get('read') and not msg.get('read'):
                msg['read'] = True
        except Exception:
            pass  # 既有收件损坏时按新消息覆盖
    write_msg(a, msg['to'], msg)


def flush_outbox(a, sender):
    """投递发件箱中游标之后的全部条目；每封投递成功（收件箱原子落盘）后才推进游标（at-least-once），
    游标随投递同步记下该条目 (name, seq)（S1b：seq 为增量锚点）。
    投递序 = (seq, 文件名) 升序（T11/M4）：同毫秒双发时文件名（ts+随机 id）序与 seq 序可倒置，按
    名称序先投高 seq 会让低 seq 永久落后游标、增量消费（--since-seq）静默漏消息——seq 是投递权威
    序，文件名仅作同 seq 平局的稳定排序（旧版无 seq 条目按 0 排前，仍先于新版条目投递）。续投判定
    分支：旧版无 seq 条目（s=0）保持旧版「name <= cursor_name」名称序语义（WP-2 (f) 补投契约不回归）；
    seq 条目按 (seq, name) 字典序比较（游标文件格式不变），顺带修复时钟回拨场景：seq 更大但名称更小
    的未投条目旧版会被「name <= cursor_name」误跳过，现按 seq 权威补投。
    投递后、游标推进前崩溃 → 重启后同一条消息按同 id 原子重投（幂等，seq 不变）。
    截断残件自愈：发件箱里的截断 JSON 只可能是旧版裸 open('w') 崩溃窗口的中间态（本版原子写不产生），
    内容不可恢复且从未持久化成功——改名 .corrupt 隔离并告警后继续，保证该发送者后续 send 不被毒丸。
    取舍：宁可丢这封从未完整落盘的消息，不让整个发送者信箱永久 exit 1（收件箱残件不走此路径，
    见 read_box——收件箱是已投递消息的唯一副本，静默丢弃违反 at-least-once，故显式报错）。"""
    d = outbox_dir(a, sender)
    if not os.path.isdir(d):
        return
    cursor_name, cursor_seq = load_cursor(d)
    entries = []
    for name in os.listdir(d):
        if not name.endswith('.json') or name == 'cursor.json':
            continue
        path = os.path.join(d, name)
        try:
            with open(path, encoding='utf-8') as f:
                entries.append((name, json.load(f)))
        except Exception as e:
            os.replace(path, path + '.corrupt')  # 自愈：移出 .json 投递队列，不再反复触碰
            print(f'警告：发件箱截断残件已隔离（{name}: {type(e).__name__}: {e}），该消息从未完整落盘，已跳过。',
                  file=sys.stderr)
            continue
    entries.sort(key=lambda ne: (msg_seq(ne[1]), ne[0]))  # M4：投递序=(seq, 文件名)，名称序仅作平局稳定排序
    for name, msg in entries:
        s = msg_seq(msg)
        if s == 0:
            # 旧版无 seq 条目：保持旧版名称序续投语义（WP-2 (f) 契约——游标推进后追加的无 seq 挂起
            # 条目照常按名称序补投；seq 纪元游标不因旧版条目前移，s>0 分支不受其影响）。
            if name <= cursor_name:
                continue
        elif s < cursor_seq or (s == cursor_seq and name <= cursor_name):
            continue  # seq 条目续投判定：(seq, name) 字典序，与投递序一致（游标文件格式不变）
        deliver(a, msg)
        if os.environ.get('BUS_CRASH_AFTER_DELIVER'):
            os._exit(70)  # 测试注入：模拟投递成功后、游标推进前进程崩溃
        cursor_name, cursor_seq = name, s  # 游标仅在成功回执后前进（按投递序单调）
        save_cursor(d, cursor_name, cursor_seq)


class _SendSeqLock:
    """fcntl.flock 独占锁（同 taskboard.py board_lock 形态）：内核保证进程死亡即释放。
    无 fcntl 平台降级为无锁——写入仍是唯一 tmp + os.replace 原子（不互截），强一致仅 POSIX 保证。"""

    def __init__(self, path):
        self.path = path
        self.f = None

    def __enter__(self):
        # 追加模式打开（锁文件不写任何内容，无截断语义）；不用写入模式打开——WP-2 (g) 静态守卫
        # 锁定全文件唯一「按写入模式打开」的落盘点=write_json_atomic 的唯一 tmp，锁文件不属该口径。
        self.f = open(self.path, 'a')
        if fcntl is not None:
            fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        if fcntl is not None:
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        self.f.close()
        self.f = None
        return False


def send_seq_lock(d):
    """同发送者并发 send 的 seq 分配互斥（T11/M3）：锁文件 <发件箱>/.send.lock（非 .json，不参与
    任何信箱枚举/扫描/投递）。包裹「outbox_next_seq 扫描 + 发件箱条目落盘」临界区——无锁时两个并发
    send 各自扫到同一 seq 下界、写出重复 seq，增量消费（--since-seq）按游标单调推进会静默漏掉其中
    一条。条目落盘在锁内完成（先 fsync 再出临界区），后继 send 的扫描必能看到前序 seq，这是互斥
    成立的前提。"""
    return _SendSeqLock(os.path.join(d, '.send.lock'))


def cmd_send(a, _data=None):
    if not a.body and not a.file:
        sys.exit('错误：--body 与 --file 至少给一个')
    if bool(getattr(a, 'task', None)) != bool(getattr(a, 'attempt', None)):
        sys.exit('错误：--task 与 --attempt 必须成对提供')  # broadcast 复用本函数时无此二参，均为 None
    files = [os.path.abspath(f) for f in (a.file or [])]
    msg = {
        'id': make_id(), 'from': a.sender, 'to': a.to,
        'subject': a.subject or '', 'body': a.body or '',
        'files': files, 'ts': int(time.time() * 1000), 'read': False,
    }
    if getattr(a, 'task', None):  # broadcast 复用本函数时无 task/attempt 属性，均按缺省 None 处理
        msg['task'] = a.task
        msg['attempt_id'] = a.attempt
    # 先落发件箱（持久化，原子写：崩溃只留 .tmp 残件，不产生截断毒丸），再投递；游标仅在投递成功回执后推进（at-least-once）
    d = outbox_dir(a, a.sender)
    os.makedirs(d, exist_ok=True)
    with send_seq_lock(d):  # T11/M3：同发送者并发 send 的「seq 扫描+落盘」临界区（落盘在锁内，后继扫描必见前序 seq）
        msg['seq'] = outbox_next_seq(d)  # S1b：发件人单调 seq，增量读取（--since-seq）的游标锚点
        write_json_atomic(os.path.join(d, f"{msg['ts']:013d}-{msg['id']}.json"), msg)
    flush_outbox(a, a.sender)
    print(f"已投递 {msg['id']} -> {a.to}（来自 {a.sender}）：{msg['subject']}")


def cmd_broadcast(a, _data=None):
    r = root(a)
    boxes = [n for n in os.listdir(r)
             if os.path.isdir(os.path.join(r, n)) and n not in INTERNAL_DIRS] if os.path.isdir(r) else []
    boxes = [b for b in boxes if b != a.sender]
    if not boxes:
        print('（尚无其他信箱；消息仍存入 _broadcast 存档）')
    for b in boxes:
        a.to = b
        cmd_send(a)
    a.to = '_broadcast'
    cmd_send(a)


# ── ②③ 过代过滤 + skip-round：与 taskboard.py 代际对账 ─────────────────────

def default_board():
    """与 taskboard.py 一致的默认板解析：遗留 .expert-taskboard.json 优先，否则 .expert-taskboards/default.json。
    多板共存工作区（如历史遗留 default.json 与当前 expert-orchestrator-v26.json 并存）下该解析可能选中
    陈旧无关板——读取对账不再单板定生死，见 candidate_boards / attempt_verdict。"""
    legacy = os.path.join(os.getcwd(), '.expert-taskboard.json')
    if os.path.exists(legacy):
        return legacy
    return os.path.join(os.getcwd(), '.expert-taskboards', 'default.json')


def load_board_data(a):
    """读取任务板用于代际对账；板缺失/损坏/结构非法一律 unrecoverable，不做静默假设。"""
    path = a.board or default_board()
    if not os.path.exists(path):
        raise BusError('unrecoverable', path=path,
                       reason='任务板文件不存在，无法核对消息携带的派工代际（--board 指定板文件，或 --no-attempt-filter 关闭过滤）')
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        raise BusError('unrecoverable', path=path, reason=f'JSON 解析失败: {e}')
    if not isinstance(data, dict) or not isinstance(data.get('tasks'), dict):
        raise BusError('unrecoverable', path=path, reason='结构非法：缺少 tasks 对象')
    return data


def candidate_boards(a):
    """对账候选板集合（S1a 误判修复）：返回 [(path, data, strict)]，按权威度排序。
    - 显式 --board：单板严格（缺失/损坏/结构非法 unrecoverable，与旧版语义一致）——调用方显式指定的板
      即权威，不做跨板增权确认（真过期消息仍归档）。
    - 默认解析：主解析板（default_board() 路径，存在则严格——损坏仍 unrecoverable，板缺失/损坏语义
      不回归）+ 同工作区其余候选板（遗留板 + .expert-taskboards/*.json 顶层；宽松解析：损坏/结构非法
      仅 stderr 告警跳过——损坏板无法确认任何代际，跨板只做「确认」不做「否决」，绝不因坏板多杀消息）。
      任一候选板确认消息代际为当前且未撤销 → 不归档（修复：多板共存工作区里陈旧无关的 default.json
      携同名任务旧代际，把合法当前代际消息误判「attempt 非当前代际」归档——T10 两条真实汇报即被如此
      错杀）；任一候选板记录撤销 → 仍归档（撤销权威优先，防陈旧快照复活已撤销代际；attempt_id 含派工
      时刻毫秒戳，跨板出现同代际实际只可能是同源快照，撤销板是更进一步的一代，权威）。
      归档权威裁决（T11 编排者裁决）：strict=True 标记权威板（显式 --board 或在场的主解析板）——归档
      动作仅当候选集合含权威板时发生；主解析板缺失的降级中间态（集合全为宽松板）由调用方只确认不归档。"""
    primary = a.board or default_board()
    if a.board:
        return [(primary, load_board_data(a), True)]
    candidates = []
    if os.path.exists(primary):
        candidates.append((primary, load_board_data(a), True))  # 主解析板严格：损坏 unrecoverable 不回归
    seen = {os.path.abspath(primary)}
    extra = []
    legacy = os.path.join(os.getcwd(), '.expert-taskboard.json')
    if os.path.exists(legacy):
        extra.append(legacy)
    gdir = os.path.join(os.getcwd(), '.expert-taskboards')
    if os.path.isdir(gdir):
        extra.extend(sorted(glob.glob(os.path.join(gdir, '*.json'))))
    for p in extra:
        if os.path.abspath(p) in seen:
            continue
        seen.add(os.path.abspath(p))
        try:
            with open(p, encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, dict) or not isinstance(data.get('tasks'), dict):
                raise ValueError('缺少 tasks 对象')
        except Exception as e:
            print(f'警告：候选任务板 {p} 不可读（{type(e).__name__}: {e}），跳过该板的对账确认。', file=sys.stderr)
            continue
        candidates.append((p, data, False))
    if not candidates:
        raise BusError('unrecoverable', path=primary,
                       reason='任务板文件不存在，无法核对消息携带的派工代际（--board 指定板文件，或 --no-attempt-filter 关闭过滤）')
    return candidates


def get_board(a):
    """候选板集合按主板路径缓存（--all-boxes 多信箱只枚举一次板）。"""
    path = a.board or default_board()
    cache = a.__dict__.setdefault('_bus_board_cache', {})
    if path not in cache:
        cache[path] = candidate_boards(a)
    return cache[path]


def attempt_verdict(boards, tid, att):
    """多板代际裁决：返回 (ok, why, rescuer)。
    - 任一候选板记录撤销 → (False, 'attempt 已撤销', '')（撤销权威优先；单严格板场景与旧版逐字一致）；
    - 任一候选板确认 attempt_id 等于消息携带值 → (True, '', rescuer)：rescuer 为确认板路径（主解析板
      确认时为空串；跨板救援时供调用方补一条 stderr 可观测提示）；
    - 任务在所有候选板都不存在 → (False, '任务不存在', '')；任务存在但 attempt 既非任何板的当前代际
      也未被撤销 → (False, 'attempt 非当前代际', '')（与旧版单板语义逐字一致）。
    严格板（strict=True）的深层结构非法仍 unrecoverable（任务条目非对象 / attempt_revoked 非列表，
    与旧版一致）；宽松候选板只跳过对应条目。"""
    revoked_anywhere, confirmed_by, task_seen = False, '', False
    for path, data, strict in boards:
        tasks = data.get('tasks')
        t = tasks.get(tid) if isinstance(tasks, dict) else None
        if strict and t is not None and not isinstance(t, dict):
            raise BusError('unrecoverable', path=path, reason=f'结构非法：任务 {tid} 条目不是对象')
        if not isinstance(t, dict):
            continue
        task_seen = True
        revoked = t.get('attempt_revoked')
        if strict and revoked is not None and not isinstance(revoked, list):
            raise BusError('unrecoverable', path=path, reason=f'结构非法：任务 {tid} 的 attempt_revoked 不是列表')
        if isinstance(revoked, list) and att in revoked:
            revoked_anywhere = True
        if t.get('attempt_id') == att and not confirmed_by:
            confirmed_by = path
    if revoked_anywhere:
        return False, 'attempt 已撤销', ''
    if confirmed_by:
        return True, '', confirmed_by
    return False, ('attempt 非当前代际' if task_seen else '任务不存在'), ''


def archive_expired(a, box, name, m, why):
    """过期消息移入 _archive/<信箱>/（同盘 os.replace），不进收件箱。"""
    d = os.path.join(root(a), ARCHIVE_DIR, box)
    os.makedirs(d, exist_ok=True)
    os.replace(os.path.join(box_dir(a, box), name), os.path.join(d, name))
    print(f"已归档过期消息 {m['id']}（{why}；task={m.get('task')} attempt={m['attempt_id']}）")


def read_box(a, box):
    d = box_dir(a, box)
    if not os.path.isdir(d):
        if getattr(a, 'since_seq', None) is not None:
            print(f"（信箱 {box} 无 seq>{a.since_seq} 的新消息）")
        return
    entries = []
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(d, name), encoding='utf-8') as f:
            entries.append((name, json.load(f)))
    # S1b 增量读取：--since-seq N 只保留 seq > N 的消息（发件人单调序号；旧版无 seq 消息按 0 计，
    # 仅全量读可见）。先于过代过滤执行：seq≤N 的旧消息本轮不参与对账归档，留待全量读处置
    # （过滤本就是读取时点快照，语义不变）。
    if getattr(a, 'since_seq', None) is not None:
        entries = [(name, m) for name, m in entries if msg_seq(m) > a.since_seq]
    # ② 过代过滤（默认开启）：携带 attempt 的消息先与任务板对账，过期者直接归档不进收件箱
    archived = 0
    if not a.no_attempt_filter and any(m.get('attempt_id') for _, m in entries):
        boards = get_board(a)
        # T11 编排者裁决：归档权威 = 显式 --board 或默认解析选中的主解析板在场（候选集合中的严格板）。
        # 主解析板缺失、仅兄弟板在场的降级中间态只确认不归档（兄弟板不具归档权威，陈旧板不杀消息）。
        has_authority = any(strict for _, _, strict in boards)
        primary_path = os.path.abspath(a.board or default_board())
        kept = []
        for name, m in entries:
            if m.get('attempt_id'):
                ok, why, rescuer = attempt_verdict(boards, m.get('task'), m['attempt_id'])
                if ok:
                    if rescuer and os.path.abspath(rescuer) != primary_path:
                        # 跨板救援（S1a 误判修复的可观测性）：主解析板未确认、由候选板确认当前代际。
                        # 措辞区分两种中间态：权威板在场=「主解析板不匹配」；主解析板缺失=「主解析板缺失」。
                        if has_authority:
                            print(f"提示：消息 {m['id']} 的 attempt 在主解析板不匹配，已由候选板 "
                                  f"{os.path.basename(rescuer)} 确认为当前代际，保留不归档。", file=sys.stderr)
                        else:
                            print(f"提示：消息 {m['id']} 的主解析板缺失，已由候选板 "
                                  f"{os.path.basename(rescuer)} 确认为当前代际，保留不归档。", file=sys.stderr)
                    kept.append((name, m))
                elif has_authority:
                    archive_expired(a, box, name, m, why)
                    archived += 1
                else:
                    # 降级中间态：只确认不归档（含兄弟板记录撤销的否决——无权威板在场，一律留待
                    # 权威板恢复后的全量读处置），不进归档、不触发 skip-round 的归档计数。
                    kept.append((name, m))
            else:
                kept.append((name, m))
        entries = kept
    shown = 0
    for _name, m in entries:
        if a.unread and m.get('read'):
            continue
        shown += 1
        flag = '已读' if m.get('read') else '未读'
        seqref = f" seq={m['seq']}" if msg_seq(m) else ''  # S1b：seq 展示（增量游标推进依据），旧消息无此字段零变化
        ref = f" task={m['task']} attempt={m['attempt_id']}" if m.get('attempt_id') else ''
        print(f"--- {m['id']} [{flag}] from={m['from']} subject={m['subject']} ts={m['ts']}{seqref}{ref}")
        if m['body']:
            print(m['body'])
        for fp in m.get('files', []):
            print(f"附件: {fp}")
    if shown == 0:
        if archived:
            # ③ skip-round：本轮可见消息为空（--unread 时已读消息不计入可见），供编排模型跳过该轮（省一次模型调用）。
            # 措辞与判定对齐：不说「全部过期」——archived 只统计本轮归档数，--unread 下可见为空也可能因消息已读。
            print(f"SKIP_ROUND：信箱 {box} 本轮无可见消息（本轮已归档 {archived} 封过期消息）；无待处理消息，可跳过该轮。")
        elif getattr(a, 'since_seq', None) is not None:
            print(f"（信箱 {box} 无 seq>{a.since_seq} 的新消息）")  # S1b：增量轮询无新消息（区别于真空信箱文案）
        else:
            print(f"（信箱 {box} 无{'未读' if a.unread else ''}消息）")


def cmd_read(a, _data=None):
    if getattr(a, 'since_seq', None) is not None and a.since_seq < 0:
        a.since_seq = 0  # T11 建议①：下界 clamp——负 N 会把「旧版无 seq 消息按 0、仅全量读可见」的文档语义破坏掉
    if getattr(a, 'since_seq', None) is not None and a.all_boxes:
        sys.exit('错误：--since-seq 需与 --box 搭配（seq 按发送者单调，跨信箱无全局序）')
    if a.all_boxes:
        r = root(a)
        boxes = sorted(n for n in os.listdir(r)
                       if os.path.isdir(os.path.join(r, n)) and n not in INTERNAL_DIRS) if os.path.isdir(r) else []
        for b in boxes:
            print(f"== 信箱 {b} ==")
            read_box(a, b)
    else:
        if not a.box:
            sys.exit('错误：--box 与 --all-boxes 必须给一个')
        read_box(a, a.box)


def cmd_ack(a, _data=None):
    d = box_dir(a, a.box)
    if not os.path.isdir(d):
        sys.exit(f'错误：信箱 {a.box} 不存在')
    n = 0
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(d, name)
        with open(path, encoding='utf-8') as f:
            m = json.load(f)
        if a.all or m['id'] == a.id:
            m['read'] = True
            write_json_atomic(path, m)  # 原子写：ack 中途崩溃只留无害 .tmp 残件，绝不截断收件箱消息（截断一封即整箱 read/stats 永久 unrecoverable）
            n += 1
            if not a.all and m['id'] == a.id:
                break
    print(f"已确认 {n} 封消息已读")


def cmd_stats(a, _data=None):
    r = root(a)
    if not os.path.isdir(r):
        print('（总线为空）')
        return
    for b in sorted(os.listdir(r)):
        d = os.path.join(r, b)
        if not os.path.isdir(d) or b in INTERNAL_DIRS:
            continue
        msgs = [json.load(open(os.path.join(d, n), encoding='utf-8')) for n in os.listdir(d) if n.endswith('.json')]
        unread = sum(1 for m in msgs if not m.get('read'))
        print(f"{b}: 共 {len(msgs)} 封，未读 {unread}")


def main():
    ap = argparse.ArgumentParser(description='expert-orchestrator 消息总线')
    ap.add_argument('--root', help='总线目录，默认 <cwd>/.expert-bus（全局信箱根约定见文件头：全部消费方须锚定同一 cwd 或显式传同一 --root）')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('send')
    p.add_argument('--from', dest='sender', required=True)
    p.add_argument('--to', required=True)
    p.add_argument('--subject')
    p.add_argument('--body')
    p.add_argument('--file', action='append')
    p.add_argument('--task', help='关联任务 id（与 --attempt 成对；供读取时按派工代际过滤）')
    p.add_argument('--attempt', help='派工代际 attempt_id（与 --task 成对；对接 taskboard.py 代际）')
    p.set_defaults(fn=cmd_send)

    p = sub.add_parser('broadcast')
    p.add_argument('--from', dest='sender', required=True)
    p.add_argument('--subject')
    p.add_argument('--body')
    p.add_argument('--file', action='append')
    p.set_defaults(fn=cmd_broadcast)

    p = sub.add_parser('read')
    p.add_argument('--box')
    p.add_argument('--all-boxes', action='store_true')
    p.add_argument('--unread', action='store_true')
    p.add_argument('--since-seq', type=int, default=None,
                   help='增量读取（S1b）：只显示 seq 大于 N 的消息（seq 为发件人单调序号，随 send 写入并在'
                        '读取输出展示；游标按消费进度推进即可只看新消息）。旧版无 seq 的消息视为 0，仅在'
                        '不传该参数的全量读中可见；需与 --box 搭配，与 --unread/过代过滤/skip-round 可叠加')
    p.add_argument('--board', help='代际对账用任务板文件，默认解析规则同 taskboard.py')
    p.add_argument('--no-attempt-filter', action='store_true',
                   help='关闭过代过滤与 skip-round，回到旧版读取行为（既有调用方式不受影响）')
    p.set_defaults(fn=cmd_read)

    p = sub.add_parser('ack')
    p.add_argument('--box', required=True)
    p.add_argument('--id')
    p.add_argument('--all', action='store_true')
    p.set_defaults(fn=cmd_ack)

    p = sub.add_parser('stats')
    p.set_defaults(fn=cmd_stats)

    a = ap.parse_args()
    try:
        a.fn(a)
    except BusError as e:
        payload = {'error': e.code}
        payload.update(e.fields)
        if e.code == 'unrecoverable':
            payload['unrecoverable'] = True
        print(json.dumps(payload, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:  # 兜底：绝不裸 traceback，统一具名 unrecoverable JSON（同 taskboard.py）
        print(json.dumps({'error': 'unrecoverable', 'unrecoverable': True,
                          'reason': f'命令执行异常: {type(e).__name__}: {e}'}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
