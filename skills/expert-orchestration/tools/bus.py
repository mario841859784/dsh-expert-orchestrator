#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert-orchestrator 消息总线：专家与协调官之间的落盘信箱。

信箱目录默认 <cwd>/.expert-bus/，每封信一个 JSON 文件（可 --root 覆盖）。
用法：
  bus.py send --from 前端工程师 --to coordinator --subject "登录页完成" --body "…" [--file 路径]…
  bus.py read --box coordinator [--unread]
  bus.py read --all-boxes [--unread]
  bus.py ack --box coordinator --id <id> | bus.py ack --box coordinator --all
  bus.py broadcast --from 协调官 --subject "…" --body "…"
  bus.py stats
铁律：发必署名、读必确认；并行专家把完整产出 send 到 coordinator 信箱，最终回复只留摘要。
"""
import argparse, json, os, random, sys, time


def root(a):
    return a.root or os.path.join(os.getcwd(), '.expert-bus')


def box_dir(a, name):
    return os.path.join(root(a), name)


def write_msg(a, to, msg):
    d = box_dir(a, to)
    os.makedirs(d, exist_ok=True)
    name = f"{msg['ts']:013d}-{msg['id']}.json"
    path = os.path.join(d, name)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(msg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return path


def make_id():
    return f"m{int(time.time() * 1000)}{random.randint(100, 999)}"


def cmd_send(a, _data=None):
    if not a.body and not a.file:
        sys.exit('错误：--body 与 --file 至少给一个')
    files = [os.path.abspath(f) for f in (a.file or [])]
    msg = {
        'id': make_id(), 'from': a.sender, 'to': a.to,
        'subject': a.subject or '', 'body': a.body or '',
        'files': files, 'ts': int(time.time() * 1000), 'read': False,
    }
    write_msg(a, a.to, msg)
    print(f"已投递 {msg['id']} -> {a.to}（来自 {a.sender}）：{msg['subject']}")


def cmd_broadcast(a, _data=None):
    r = root(a)
    boxes = [n for n in os.listdir(r) if os.path.isdir(os.path.join(r, n))] if os.path.isdir(r) else []
    boxes = [b for b in boxes if b != a.sender]
    if not boxes:
        print('（尚无其他信箱；消息仍存入 _broadcast 存档）')
    for b in boxes:
        a.to = b
        cmd_send(a)
    a.to = '_broadcast'
    cmd_send(a)


def read_box(a, box):
    d = box_dir(a, box)
    if not os.path.isdir(d):
        return
    shown = 0
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(d, name), encoding='utf-8') as f:
            m = json.load(f)
        if a.unread and m.get('read'):
            continue
        shown += 1
        flag = '已读' if m.get('read') else '未读'
        print(f"--- {m['id']} [{flag}] from={m['from']} subject={m['subject']} ts={m['ts']}")
        if m['body']:
            print(m['body'])
        for fp in m.get('files', []):
            print(f"附件: {fp}")
    if shown == 0:
        print(f"（信箱 {box} 无{'未读' if a.unread else ''}消息）")


def cmd_read(a, _data=None):
    if a.all_boxes:
        r = root(a)
        boxes = sorted(n for n in os.listdir(r) if os.path.isdir(os.path.join(r, n))) if os.path.isdir(r) else []
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
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(m, f, ensure_ascii=False, indent=2)
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
        if not os.path.isdir(d):
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
    p.set_defaults(fn=cmd_read)

    p = sub.add_parser('ack')
    p.add_argument('--box', required=True)
    p.add_argument('--id')
    p.add_argument('--all', action='store_true')
    p.set_defaults(fn=cmd_ack)

    p = sub.add_parser('stats')
    p.set_defaults(fn=cmd_stats)

    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
