#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert-orchestrator 任务板：状态机 + 依赖 DAG + 崩溃恢复。

状态文件默认 <cwd>/.expert-taskboard.json，可用 --board 覆盖。
状态流转：pending（依赖未满足）-> ready -> running -> done | failed
  claim: ready -> running；done: running -> done（依赖它的任务自动转 ready）
  fail:  running -> failed；retry: failed -> ready；recover: 所有 running -> ready
依赖：create 时 --dep T1,T2 声明；引用不存在的任务会报错。
检查点：progress <id> "<说明>" 向任务追加带时间戳的检查点记录（新字段 checkpoints，旧板无此字段兼容）；长任务/多阶段委派每完成一个阶段记一次，专家失败重试前编排者先读取它组装续跑任务书，禁止无检查点直接从头重跑。
"""
import argparse, collections, datetime, glob, json, os, sys, time


def now_ms():
    return int(time.time() * 1000)


def load(path):
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return {'tasks': {}, 'seq': 0}


def save(path, data):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


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


def show(t):
    dep = (' dep=' + ','.join(t['dep'])) if t['dep'] else ''
    owner = (f" owner={t['owner']}") if t['owner'] else ''
    print(f"{t['id']} [{t['status']}] {t['title']}{owner}{dep}")


def cmd_create(a, data, path):
    tid = f"T{data['seq'] + 1}"
    data['seq'] += 1
    deps = [d.strip() for d in (a.dep or '').split(',') if d.strip()]
    for d in deps:
        if d not in data['tasks']:
            sys.exit(f"错误：依赖任务 {d} 不存在")
    data['tasks'][tid] = {
        'id': tid, 'title': a.title, 'owner': a.owner or '', 'dep': deps,
        'desc': a.desc or '', 'status': 'pending', 'created': now_ms(),
        'updated': now_ms(), 'summary': '', 'fail': '',
    }
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
    ok, why = deps_state(t, data['tasks'])
    if t['dep'] and not ok:
        print(f"  依赖未满足（{why}）")


def cmd_claim(a, data, path):
    t = get_task(data, a.id)
    if t['status'] != 'ready':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 ready 可认领")
    t['status'] = 'running'
    if a.owner:
        t['owner'] = a.owner
    t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_done(a, data, path):
    t = get_task(data, a.id)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可完成")
    t['status'] = 'done'
    t['summary'] = a.summary or ''
    t['updated'] = now_ms()
    promoted = refresh(data)
    save(path, data)
    show(t)
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


def cmd_fail(a, data, path):
    t = get_task(data, a.id)
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
        except Exception:
            print(f'{os.path.relpath(p)} （损坏）')
            continue
        tasks = data.get('tasks', {})
        st = collections.Counter(t['status'] for t in tasks.values())
        upd = max([t.get('updated', 0) for t in tasks.values()] or [0])
        ts = datetime.datetime.fromtimestamp(upd / 1000).strftime('%m-%d %H:%M') if upd else '-'
        dist = ' '.join(f'{k}={v}' for k, v in sorted(st.items())) or '空'
        print(f"{os.path.relpath(p)} | {len(tasks)} 任务 | {dist} | 最近更新 {ts}")


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
    ap.add_argument('--board', help='状态文件路径，默认 <cwd>/.expert-taskboard.json')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('create')
    p.add_argument('title')
    p.add_argument('--owner')
    p.add_argument('--dep', help='逗号分隔的依赖任务ID')
    p.add_argument('--desc', help='完成标准')
    p.set_defaults(fn=cmd_create)

    p = sub.add_parser('list')
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser('show'); p.add_argument('id'); p.set_defaults(fn=cmd_show)
    p = sub.add_parser('claim'); p.add_argument('id'); p.add_argument('owner', nargs='?'); p.set_defaults(fn=cmd_claim)
    p = sub.add_parser('done'); p.add_argument('id'); p.add_argument('summary', nargs='?'); p.set_defaults(fn=cmd_done)
    p = sub.add_parser('fail'); p.add_argument('id'); p.add_argument('reason', nargs='?'); p.set_defaults(fn=cmd_fail)
    p = sub.add_parser('retry'); p.add_argument('id'); p.set_defaults(fn=cmd_retry)
    p = sub.add_parser('progress'); p.add_argument('id'); p.add_argument('note'); p.set_defaults(fn=cmd_progress)

    p = sub.add_parser('recover'); p.set_defaults(fn=cmd_recover)
    p = sub.add_parser('deps'); p.add_argument('id'); p.set_defaults(fn=cmd_deps)
    p = sub.add_parser('status'); p.set_defaults(fn=cmd_status)
    p = sub.add_parser('boards'); p.set_defaults(fn=cmd_boards)
    p = sub.add_parser('archive'); p.add_argument('--force', action='store_true'); p.set_defaults(fn=cmd_archive)

    a = ap.parse_args()
    if a.cmd == 'boards':
        a.fn(a)
        return
    path = a.board or default_board()
    data = load(path)
    a.fn(a, data, path)


if __name__ == '__main__':
    main()
