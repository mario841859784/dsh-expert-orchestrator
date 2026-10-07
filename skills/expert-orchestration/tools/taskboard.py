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
"""
import argparse, collections, contextlib, datetime, glob, json, os, sys, time, uuid

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


def show(t):
    dep = (' dep=' + ','.join(t['dep'])) if t['dep'] else ''
    owner = (f" owner={t['owner']}") if t['owner'] else ''
    print(f"{t['id']} [{t['status']}] {t['title']}{owner}{dep}")


def cmd_create(a, data, path):
    deps = [d.strip() for d in (a.dep or '').split(',') if d.strip()]
    for d in deps:
        if d not in data['tasks']:
            sys.exit(f"错误：依赖任务 {d} 不存在")
    tid = f"T{data['seq'] + 1}"
    ensure_acyclic(data['tasks'], tid, deps)  # 全图环检测（写入前）
    data['seq'] += 1
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
    rework = t.get('rework') or 0
    switched = t.get('switched') or False
    if rework or switched:
        print(f"  返工 {rework} 次" + ('，已换人' if switched else ''))
    exs = t.get('executors') or []
    if exs:
        print('  实际执行者: ' + ', '.join(f"{e['name']}[{e['time']}]" for e in exs))
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
    ap.add_argument('--board', help='状态文件路径，默认 <cwd>/.expert-taskboard.json')
    sub = ap.add_subparsers(dest='cmd', required=True)

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

    a = ap.parse_args()
    try:
        if a.cmd == 'boards':
            a.fn(a)
            return
        path = a.board or default_board()
        with board_lock(path):  # 进程互斥：load -> CAS 校验 -> 写入整体原子（TOCTOU 防护）
            data = load(path)
            check_revision(a, data)  # 写命令的 CAS 校验，锁内针对最新落盘状态（读命令无该参数，透传为不校验）
            a.fn(a, data, path)
            if a.cmd != 'archive':
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
