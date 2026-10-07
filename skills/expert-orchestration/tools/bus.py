#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert-orchestrator 消息总线：专家与协调官之间的落盘信箱。

信箱目录默认 <cwd>/.expert-bus/，每封信一个 JSON 文件（可 --root 覆盖）。
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
    派工代际）；read 时与任务板当前代际对账（--board 指定板文件，默认解析规则同 taskboard.py：
    遗留 .expert-taskboard.json 优先，否则 .expert-taskboards/default.json），attempt 已撤销/
    非当前代际/任务无此代际的消息读取时直接归档到 _archive/<信箱>/，不进收件箱；板缺失/损坏/
    结构非法返回 {"error":"unrecoverable","unrecoverable":true,...}，不做静默假设。过滤是读取
    时点快照：与 reassign 并发时，刚被撤销代际的消息可能被放行一次，下轮读取再归档。
  ③ skip-round：信箱本轮可见消息为空（--unread 时已读消息不计入可见）且本轮归档了过期消息时，
    输出 "SKIP_ROUND：…" 显式提示（供编排模型据此跳过该轮，省一次模型调用）；真空信箱仍输出
    原有「无消息」文案。
测试注入：环境变量 BUS_CRASH_AFTER_DELIVER=1 时，投递落盘后、游标推进前以退出码 70 终止
  （模拟投递中途崩溃；未设置时零影响）。
铁律：发必署名、读必确认；并行专家把完整产出 send 到 coordinator 信箱，最终回复只留摘要。
"""
import argparse, json, os, random, sys, time

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
    return f"m{int(time.time() * 1000)}{random.randint(100, 999)}"


# ── ① at-least-once 游标：发件箱 + 投递游标 ─────────────────────────────────

def outbox_dir(a, sender):
    return os.path.join(root(a), OUTBOX_DIR, sender)


def save_cursor(d, name):
    write_json_atomic(os.path.join(d, 'cursor.json'), {'cursor': name})


def load_cursor(d):
    p = os.path.join(d, 'cursor.json')
    if not os.path.exists(p):
        return ''
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f).get('cursor', '') or ''
    except Exception:
        return ''  # 游标损坏按安全侧处理：视为未推进，全部重投（只会多投不会丢）


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
    """投递发件箱中游标之后的全部条目；每封投递成功（收件箱原子落盘）后才推进游标（at-least-once）。
    投递后、游标推进前崩溃 → 重启后同一条消息按同 id 原子重投（幂等）。
    截断残件自愈：发件箱里的截断 JSON 只可能是旧版裸 open('w') 崩溃窗口的中间态（本版原子写不产生），
    内容不可恢复且从未持久化成功——改名 .corrupt 隔离并告警后继续，保证该发送者后续 send 不被毒丸。
    取舍：宁可丢这封从未完整落盘的消息，不让整个发送者信箱永久 exit 1（收件箱残件不走此路径，
    见 read_box——收件箱是已投递消息的唯一副本，静默丢弃违反 at-least-once，故显式报错）。"""
    d = outbox_dir(a, sender)
    if not os.path.isdir(d):
        return
    cursor = load_cursor(d)
    for name in sorted(n for n in os.listdir(d) if n.endswith('.json') and n != 'cursor.json'):
        if name <= cursor:
            continue
        path = os.path.join(d, name)
        try:
            with open(path, encoding='utf-8') as f:
                msg = json.load(f)
        except Exception as e:
            os.replace(path, path + '.corrupt')  # 自愈：移出 .json 投递队列，不再反复触碰
            print(f'警告：发件箱截断残件已隔离（{name}: {type(e).__name__}: {e}），该消息从未完整落盘，已跳过。',
                  file=sys.stderr)
            continue
        deliver(a, msg)
        if os.environ.get('BUS_CRASH_AFTER_DELIVER'):
            os._exit(70)  # 测试注入：模拟投递成功后、游标推进前进程崩溃
        cursor = name  # 游标仅在成功回执后前进
        save_cursor(d, cursor)


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
    """与 taskboard.py 一致的默认板解析：遗留 .expert-taskboard.json 优先，否则 .expert-taskboards/default.json。"""
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


def get_board(a):
    """板数据按路径缓存（--all-boxes 多信箱只读一次板）。"""
    path = a.board or default_board()
    cache = a.__dict__.setdefault('_bus_board_cache', {})
    if path not in cache:
        cache[path] = load_board_data(a)
    return cache[path]


def attempt_state(data, tid, att):
    """与 taskboard.py 代际语义对账：仅当任务存在、attempt_id 等于消息携带值且未撤销时为开放。"""
    t = data['tasks'].get(tid)
    if t is not None and not isinstance(t, dict):
        raise BusError('unrecoverable', reason=f'结构非法：任务 {tid} 条目不是对象')
    if not isinstance(t, dict):
        return False, '任务不存在'
    revoked = t.get('attempt_revoked') or []
    if not isinstance(revoked, list):
        raise BusError('unrecoverable', reason=f'结构非法：任务 {tid} 的 attempt_revoked 不是列表')
    if att in revoked:
        return False, 'attempt 已撤销'
    if t.get('attempt_id') != att:
        return False, 'attempt 非当前代际'
    return True, ''


def archive_expired(a, box, name, m, why):
    """过期消息移入 _archive/<信箱>/（同盘 os.replace），不进收件箱。"""
    d = os.path.join(root(a), ARCHIVE_DIR, box)
    os.makedirs(d, exist_ok=True)
    os.replace(os.path.join(box_dir(a, box), name), os.path.join(d, name))
    print(f"已归档过期消息 {m['id']}（{why}；task={m.get('task')} attempt={m['attempt_id']}）")


def read_box(a, box):
    d = box_dir(a, box)
    if not os.path.isdir(d):
        return
    entries = []
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(d, name), encoding='utf-8') as f:
            entries.append((name, json.load(f)))
    # ② 过代过滤（默认开启）：携带 attempt 的消息先与任务板对账，过期者直接归档不进收件箱
    archived = 0
    if not a.no_attempt_filter and any(m.get('attempt_id') for _, m in entries):
        data = get_board(a)
        kept = []
        for name, m in entries:
            if m.get('attempt_id'):
                ok, why = attempt_state(data, m.get('task'), m['attempt_id'])
                if ok:
                    kept.append((name, m))
                else:
                    archive_expired(a, box, name, m, why)
                    archived += 1
            else:
                kept.append((name, m))
        entries = kept
    shown = 0
    for _name, m in entries:
        if a.unread and m.get('read'):
            continue
        shown += 1
        flag = '已读' if m.get('read') else '未读'
        ref = f" task={m['task']} attempt={m['attempt_id']}" if m.get('attempt_id') else ''
        print(f"--- {m['id']} [{flag}] from={m['from']} subject={m['subject']} ts={m['ts']}{ref}")
        if m['body']:
            print(m['body'])
        for fp in m.get('files', []):
            print(f"附件: {fp}")
    if shown == 0:
        if archived:
            # ③ skip-round：本轮可见消息为空（--unread 时已读消息不计入可见），供编排模型跳过该轮（省一次模型调用）。
            # 措辞与判定对齐：不说「全部过期」——archived 只统计本轮归档数，--unread 下可见为空也可能因消息已读。
            print(f"SKIP_ROUND：信箱 {box} 本轮无可见消息（本轮已归档 {archived} 封过期消息）；无待处理消息，可跳过该轮。")
        else:
            print(f"（信箱 {box} 无{'未读' if a.unread else ''}消息）")


def cmd_read(a, _data=None):
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
    ap.add_argument('--root', help='总线目录，默认 <cwd>/.expert-bus')
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
