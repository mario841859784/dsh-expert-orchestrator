// test/mutation-gate.selftest.mjs — taskboard.py/bus.py 门禁逻辑变异测试族（v2.13 T4，node:test，零依赖）。
// 署名：qa-test-engineer
//
// 目标：证明关键门禁不是「装饰性 if」。对 29 个安全/一致性锚点各注入一个语义变异
// （mutant），随后运行针对性 probe——probe 只断言「正确行为」；变异被注入后 probe 翻红
// （抛 AssertionError）即门禁有效（变异被捕获），probe 仍绿即变异逃逸（门禁失效，测试失败）。
//
// 执行形态：默认整文件 skip（不拖慢基线跑批）；显式 DSH_EXPERT_MUTANTS=1 时启用。
// 注入方式：pristine 源文件复制进 os.tmpdir() 临时目录后做单点字符串替换（anchor→mutant，
// 注入前校验 anchor 恰出现 1 次），probe 以 tmp 副本为被测程序、cwd=临时目录——
// 主树文件零污染、禁止 git 写操作的红线在测试自身内闭环。
// 顶层另有「登记表锚点校验」子测试：pristine 源文件内 anchor 唯一、mutant≠anchor、行号存在，
// 防止源码演化后登记表悄悄失配（失配即红，逼登记表随源码同步维护）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'expert-orchestration', 'tools')
const TB = join(TOOLS_DIR, 'taskboard.py')
const BUS = join(TOOLS_DIR, 'bus.py')

const GATED = process.env.DSH_EXPERT_MUTANTS === '1'

// ---------------------------------------------------------------------------
// 变异登记表：29 点 = taskboard 22 + bus 7。每点：
//   id/file/line/anchor/mutant/target/assertion（assertion = probe 断言的门禁名，
//   变异注入后 probe 抛 AssertionError 即「该门禁被该 probe 捕获」）。
// ---------------------------------------------------------------------------
const REGISTRY = [
  // === taskboard.py（22 点）===
  {
    id: 'TB-cas-stale-revision', file: 'taskboard.py', line: 832,
    anchor: "if er is not None and er != cur:", mutant: "if er is not None and er == cur:",
    target: 'check_revision CAS：expected-revision 与板头不符必须 stale_revision 拒写',
    assertion: 'stale_revision：过期修订号的写请求被 CAS 拒绝',
  },
  {
    id: 'TB-attempt-no-attempt', file: 'taskboard.py', line: 842,
    anchor: "    if att is None:\n        return", mutant: "    if att is not None:\n        return",
    target: 'check_attempt：无派工代际的 done 必须拒绝（无 attempt 不得完单）',
    assertion: 'no_attempt：未携带 attempt 的完成请求被拒绝',
  },
  {
    id: 'TB-attempt-stale', file: 'taskboard.py', line: 852,
    anchor: "    if att != cur:", mutant: "    if False:",
    target: 'check_attempt：过期代际（非当前 attempt）必须 stale_attempt 拒绝',
    assertion: 'stale_attempt：过期代际的完成请求被拒绝',
  },
  {
    id: 'TB-cycle-detect', file: 'taskboard.py', line: 868,
    anchor: "if color[v] == 1:", mutant: "if color[v] == 3:",
    target: 'find_cycle：依赖环 DFS 灰色节点命中必须 dependency_cycle 拒绝',
    assertion: 'dependency_cycle：依赖环建立被拒绝',
  },
  {
    id: 'TB-refresh-promotion', file: 'taskboard.py', line: 908,
    anchor: "            ok, _ = deps_state(t, data['tasks'])\n            if ok:",
    mutant: "            ok, _ = deps_state(t, data['tasks'])\n            if not ok:",
    target: 'refresh：依赖未满足不得提前晋升 ready',
    assertion: '依赖未满足的任务保持 pending（不提前 ready）',
  },
  {
    id: 'TB-claim-ready-only', file: 'taskboard.py', line: 1246,
    anchor: "    if t['status'] != 'ready':\n        sys.exit(f\"错误：{a.id} 状态为 {t['status']}，只有 ready 可认领\")",
    mutant: "    if t['status'] == 'ready':\n        sys.exit(f\"错误：{a.id} 状态为 {t['status']}，只有 ready 可认领\")",
    target: 'cmd_claim：只有 ready 可认领',
    assertion: 'ready 任务可正常认领',
  },
  {
    id: 'TB-approve-draft-only', file: 'taskboard.py', line: 1371,
    anchor: "    if t['status'] != 'draft':\n        sys.exit(f\"错误：{a.id} 状态为 {t['status']}，只有 draft 可批准\")",
    mutant: "    if t['status'] == 'draft':\n        sys.exit(f\"错误：{a.id} 状态为 {t['status']}，只有 draft 可批准\")",
    target: 'cmd_approve：只有 draft 可批准',
    assertion: 'draft 任务可正常批准',
  },
  {
    id: 'TB-done-running-only', file: 'taskboard.py', line: 1534,
    anchor: "    if t['status'] != 'running':\n        sys.exit(f\"错误：{a.id} 状态为 {t['status']}，只有 running 可完成\")",
    mutant: "    if t['status'] == 'running':\n        sys.exit(f\"错误：{a.id} 状态为 {t['status']}，只有 running 可完成\")",
    target: 'cmd_done：只有 running 可完成',
    assertion: 'running 任务可正常完成',
  },
  {
    id: 'TB-verdict-whitelist', file: 'taskboard.py', line: 1391,
    anchor: "        if a.verdict not in ('pass', 'needs_revision'):", mutant: "        if False:",
    target: '_validate_done_verdict：review 结论白名单（pass|needs_revision 之外拒绝）',
    assertion: 'bogus 结论被白名单拒绝',
  },
  {
    id: 'TB-quorum-pass-gate', file: 'taskboard.py', line: 1407,
    anchor: "            if a.verdict == 'pass' and not (p >= t['quorum_m'] and f == 0):",
    mutant: "            if a.verdict == 'pass' and not (p >= 0 and f == 0):",
    target: '_validate_done_verdict：pass 结论须 p>=quorum_m 且 0 张 fail 票',
    assertion: 'quorum_not_met：陪审团未达标的 pass 结论被拒绝',
  },
  {
    id: 'TB-vote-fail-effect', file: 'taskboard.py', line: 1714,
    anchor: "    if f >= m:", mutant: "    if f >= m + 1:",
    target: 'cmd_vote：fail 票数达 m 即生效（自动生成 repair）',
    assertion: 'fail 票达 m 后自动生成 repair 任务',
  },
  {
    id: 'TB-vote-duplicate', file: 'taskboard.py', line: 1691,
    anchor: "    if any(v.get('by') == by for v in votes):", mutant: "    if False:",
    target: 'cmd_vote：同一评审员重复投票必须 duplicate_vote 拒绝',
    assertion: 'duplicate_vote：重复投票被拒绝',
  },
  {
    id: 'TB-watchdog-window', file: 'taskboard.py', line: 1857,
    anchor: "        if now - activity <= window_ms:", mutant: "        if True:",
    target: 'watchdog：滑动窗口内视为健康（不 nudge/reclaim）',
    assertion: '窗口外任务被 watchdog nudge',
  },
  {
    id: 'TB-watchdog-nudge-threshold', file: 'taskboard.py', line: 1861,
    anchor: "        if nudges < max_nudges:", mutant: "        if False:",
    target: 'watchdog：nudge 次数未达上限前只 nudge 不升级',
    assertion: '首轮 watchdog 只 nudge（任务保持 running）',
  },
  {
    id: 'TB-watchdog-review-no-adopt', file: 'taskboard.py', line: 1875,
    anchor: "        if m is not None and t.get('kind') != 'review':", mutant: "        if m is not None:",
    target: 'watchdog：review 任务即便有完成报告信也只 reclaim 不 adopt',
    assertion: 'review 任务被 reclaim（回 ready 而非 adopt 成 done）',
  },
  {
    id: 'TB-adopt-evidence-negative-words', file: 'taskboard.py', line: 1824,
    anchor: "                if any(w in body for w in negative_words):",
    mutant: "                if False:",
    target: 'adopt 证据：body 含负向过程词（进行中等）不得采信为完成证据',
    assertion: '含负向词的证据被拒（任务被 reclaim 而非 adopt）',
  },
  {
    id: 'TB-reclaim-revoke-attempt', file: 'taskboard.py', line: 1903,
    anchor: "            if att:\n                t.setdefault('attempt_revoked', []).append(att)",
    mutant: "            if False:\n                t.setdefault('attempt_revoked', []).append(att)",
    target: 'watchdog reclaim：孤儿代际必须撤销并入 revoked（迟到汇报 stale_attempt）',
    assertion: 'reclaim 后旧 attempt 的完成请求被拒绝',
  },
  {
    id: 'TB-claim-revoke-old-attempt', file: 'taskboard.py', line: 1265,
    anchor: "        if old and old != a.attempt:", mutant: "        if False:",
    target: 'cmd_claim：认领换代必须撤销旧代际（旧代不得复活）',
    assertion: 'stale_attempt：已撤销代际不能重新认领',
  },
  {
    id: 'TB-event-hash-chain', file: 'taskboard.py', line: 459,
    anchor: "ev.get('hash') == _event_hash(ev)", mutant: "True or ev.get('hash') == _event_hash(ev)",
    target: 'read_events：事件 hash 链校验（篡改即 unrecoverable）',
    assertion: 'unrecoverable：被篡改的事件流拒绝读取',
  },
  {
    id: 'TB-receipt-contract', file: 'taskboard.py', line: 2784,
    anchor: "    missing = [k for k in required if k not in payload]\n    if missing:",
    mutant: "    if False:",
    target: '_receipt_check：生产回执缺必备字段必须 receipt_invalid + 非零退出',
    assertion: 'receipt_invalid：残缺回执触发 SystemExit(1)',
  },
  {
    id: 'TB-revision-increment', file: 'taskboard.py', line: 659,
    anchor: "    new_rev = int(data.get('revision', 0)) + 1\n    data['revision'] = new_rev\n    pre = ctx.get('pre_tasks') or {}",
    mutant: "    new_rev = int(data.get('revision', 0)) + 0\n    data['revision'] = new_rev\n    pre = ctx.get('pre_tasks') or {}",
    target: 'commit_event：板修订号每次写必须 +1（乐观锁语义的序号来源）',
    assertion: 'list 尾行 revision=1（修订号随写递增）',
  },
  {
    id: 'TB-needs-revision-escalation', file: 'taskboard.py', line: 1453,
    anchor: "    if count > limit:", mutant: "    if False:",
    target: '_review_needs_revision：返工超上限必须 escalated 终态（不再无限 repair）',
    assertion: 'escalated：返工超上限后任务进入终态',
  },
  // === bus.py（7 点）===
  {
    id: 'BUS-msg-required-fields', file: 'bus.py', line: 88,
    anchor: "MSG_REQUIRED_FIELDS = ('id', 'from', 'to', 'ts')", mutant: "MSG_REQUIRED_FIELDS = ('id',)",
    target: 'validate_msg：消息必备字段缺失必须 message_invalid 拒读',
    assertion: 'message_invalid：缺 ts 的消息被拒绝读取',
  },
  {
    id: 'BUS-deliver-preserve-read', file: 'bus.py', line: 217,
    anchor: "            if old.get('read') and not msg.get('read'):", mutant: "            if False:",
    target: 'deliver：重投不复活已读标记（at-least-once 幂等语义）',
    assertion: '重投后已读消息不出现在 --unread',
  },
  {
    id: 'BUS-cursor-advance', file: 'bus.py', line: 282,
    anchor: "        cursor_name, cursor_seq = name, s  # 游标仅在成功回执后前进（按投递序单调）",
    mutant: "        pass  # 游标仅在成功回执后前进（按投递序单调）",
    target: 'flush_outbox：游标仅在成功回执后前进并持久化',
    assertion: 'cursor.json 记录最后成功投递的 (name, seq)',
  },
  {
    id: 'BUS-seq-monotonic', file: 'bus.py', line: 207,
    anchor: "    return seq + 1", mutant: "    return seq",
    target: 'outbox_next_seq：同一发送者 seq 严格单调递增',
    assertion: '两次发送的 seq=[1,2] 单调递增',
  },
  {
    id: 'BUS-since-seq-filter', file: 'bus.py', line: 516,
    anchor: "msg_seq(m) > a.since_seq", mutant: "msg_seq(m) >= a.since_seq",
    target: 'read --since-seq：增量边界为严格大于（已消费消息不得重出）',
    assertion: '--since-seq 1 过滤掉 seq=1 的已读消息',
  },
  {
    id: 'BUS-revoked-authority', file: 'bus.py', line: 465,
    anchor: "    if revoked_anywhere:\n        return False, 'attempt 已撤销', ''",
    mutant: "    if False:\n        return False, 'attempt 已撤销', ''",
    target: 'attempt_verdict：撤销权威优先（任一板记录撤销即归档过期消息）',
    assertion: '已撤销代际的消息被归档（撤销权威优先于兄弟板确认）',
  },
  {
    id: 'BUS-corrupt-quarantine', file: 'bus.py', line: 254,
    anchor: "            os.replace(path, path + '.corrupt')  # 自愈：移出 .json 投递队列，不再反复触碰",
    mutant: "            pass",
    target: 'flush_outbox：发件箱截断残件自愈隔离 .corrupt（不毒丸投递）',
    assertion: '损坏条目被隔离为 .corrupt',
  },
]

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
const PRISTINE = { 'taskboard.py': readFileSync(TB, 'utf-8'), 'bus.py': readFileSync(BUS, 'utf-8') }

/** 临时目录（os.tmpdir，主树零污染；t.after 自动清理）。 */
const makeDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t4-mutation-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 把 pristine 两文件复制进 dir（taskboard watchdog/收件箱检索不 import bus，但一并拷贝零成本）。 */
const deployPristine = (dir) => {
  for (const [name, text] of Object.entries(PRISTINE)) writeFileSync(join(dir, name), text)
  return { tb: join(dir, 'taskboard.py'), bus: join(dir, 'bus.py') }
}

/** 注入：anchor 恰出现 1 次 → 单点替换为 mutant，写回 tmp 副本。 */
const inject = (dir, m) => {
  const path = join(dir, m.file)
  const text = readFileSync(path, 'utf-8')
  const n = text.split(m.anchor).length - 1
  assert.equal(n, 1, `注入前置：${m.id} anchor 在 ${m.file} 副本中应恰出现 1 次，实为 ${n}`)
  writeFileSync(path, text.replace(m.anchor, m.mutant))
}

/** 执行 tmp 副本 taskboard.py（cwd=dir）。 */
const runTb = (dir, tbPath, args, opts = {}) => {
  const r = spawnSync('python3', [tbPath, ...args], { cwd: dir, encoding: 'utf-8', input: opts.input })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 人类面输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

/** 执行 tmp 副本 bus.py（cwd=dir）。 */
const runBus = (dir, busPath, args) => {
  const r = spawnSync('python3', [busPath, ...args], { cwd: dir, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 人类面输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const showStatus = (ctx, id) => {
  const m = runTb(ctx.dir, ctx.tb, ['show', id]).stdout.match(/^[^\s]+ \[([^\]]+)\]/m)
  return m ? m[1] : null
}

/** 手写一封投递消息（供 watchdog 证据/收件箱用例）。 */
const writeInboxMsg = (dir, msg) => {
  const box = join(dir, '.expert-bus', 'coordinator')
  mkdirSync(box, { recursive: true })
  writeFileSync(join(box, `${msg.id}.json`), JSON.stringify(msg))
}

/** 手写遗留单板（bus 默认板解析：.expert-taskboard.json 优先）。 */
const writeLegacyBoard = (dir, task) => {
  writeFileSync(join(dir, '.expert-taskboard.json'), JSON.stringify({ seq: 1, revision: 1, tasks: { [task.id]: task } }))
}

/** 解析实际任务板路径：默认 .expert-taskboards/default.json；遗留 .expert-taskboard.json 仅当已存在才优先。
 *  事件流 = 任务板路径 + '.events.jsonl'（默认板即 .expert-taskboards/default.json.events.jsonl）。 */
const boardPath = (dir) =>
  existsSync(join(dir, '.expert-taskboard.json')) ? join(dir, '.expert-taskboard.json') : join(dir, '.expert-taskboards', 'default.json')

/** 手写一个损坏的发件箱残件。 */
const writeCorruptOutbox = (dir, name) => {
  const outbox = join(dir, '.expert-bus', '_outbox', 'qa')
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(outbox, name), '{截断的 JSON 残件')
}

// ---------------------------------------------------------------------------
// probe 组装：每个登记点对应一个 probe(ctx)。ctx = { dir, tb, bus }。
// probe 内只断言「正确行为」；变异注入后若 probe 不再翻红 → 变异逃逸 → 子测试失败。
// ---------------------------------------------------------------------------

/** 正常生命周期基元：create → (claim) → 状态推进。 */
const lifecycle = {
  create: (ctx, id, extra = []) => runTb(ctx.dir, ctx.tb, ['create', `title-${id}`, ...extra]),
  claim: (ctx, id, attempt, extra = []) =>
    runTb(ctx.dir, ctx.tb, ['claim', id, 'qa', ...(attempt ? ['--attempt', attempt] : []), ...extra]),
  done: (ctx, id, extra = []) => runTb(ctx.dir, ctx.tb, ['done', id, 'summary', ...extra]),
  list: (ctx) => runTb(ctx.dir, ctx.tb, ['list']),
}

const PROBES = {
  'TB-cas-stale-revision': (ctx) => {
    lifecycle.create(ctx, 'T1')
    const r = lifecycle.create(ctx, 'T2', ['--expected-revision', '999'])
    assert.equal(r.json?.error, 'stale_revision', 'T4-A-cas：越权 CAS 写应 stale_revision')
  },
  'TB-attempt-no-attempt': (ctx) => {
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', null)
    const r = lifecycle.done(ctx, 'T1', ['--attempt', 'att-x'])
    assert.equal(r.json?.error, 'no_attempt', 'T4-A-attempt：无代际完单应 no_attempt')
  },
  'TB-attempt-stale': (ctx) => {
    // 注：reassign 撤销过的 attempt 会被 check_attempt 的 revoked 第一道闸拦下（走不到
    // L808 的 cur 比对），故用「未撤销但非当前」代际直击本锚点：claim a2 后汇报 a1。
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', 'a2')
    const r = lifecycle.done(ctx, 'T1', ['--attempt', 'a1'])
    assert.equal(r.json?.error, 'stale_attempt', 'T4-A-attempt-stale：过期代际完单应 stale_attempt')
  },
  'TB-cycle-detect': (ctx) => {
    lifecycle.create(ctx, 'T1')
    runTb(ctx.dir, ctx.tb, ['create', 'title-T2', '--dep', 'T1'])
    const r = runTb(ctx.dir, ctx.tb, ['set_dependencies', 'T1', '--dep', 'T2'])
    assert.equal(r.json?.error, 'dependency_cycle', 'T4-A-cycle：依赖环应被拒绝')
  },
  'TB-refresh-promotion': (ctx) => {
    lifecycle.create(ctx, 'T1')
    runTb(ctx.dir, ctx.tb, ['create', 'title-T2', '--dep', 'T1'])
    assert.equal(showStatus(ctx, 'T2'), 'pending', 'T4-A-refresh：依赖未满足应保持 pending')
  },
  'TB-claim-ready-only': (ctx) => {
    lifecycle.create(ctx, 'T1')
    const r = lifecycle.claim(ctx, 'T1', null)
    assert.equal(r.code, 0, `T4-A-claim：ready 应可认领（stderr=${r.stderr.trim()}）`)
  },
  'TB-approve-draft-only': (ctx) => {
    lifecycle.create(ctx, 'T1', ['--draft'])
    const r = runTb(ctx.dir, ctx.tb, ['approve', 'T1'])
    assert.equal(r.code, 0, `T4-A-approve：draft 应可批准（stderr=${r.stderr.trim()}）`)
  },
  'TB-done-running-only': (ctx) => {
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', null)
    const r = lifecycle.done(ctx, 'T1')
    assert.equal(r.code, 0, `T4-A-done：running 应可完成（stderr=${r.stderr.trim()}）`)
  },
  'TB-verdict-whitelist': (ctx) => {
    lifecycle.create(ctx, 'T1', ['--kind', 'review', '--quorum-m', '2'])
    lifecycle.claim(ctx, 'T1', null)
    const r = lifecycle.done(ctx, 'T1', ['--verdict', 'bogus'])
    assert.notEqual(r.code, 0, 'T4-A-verdict：bogus 结论应被白名单拒绝')
  },
  'TB-quorum-pass-gate': (ctx) => {
    lifecycle.create(ctx, 'T1', ['--kind', 'review', '--quorum-m', '2'])
    lifecycle.claim(ctx, 'T1', null)
    runTb(ctx.dir, ctx.tb, ['vote', 'T1', '--by', 'r1', '--score', '0.5'])
    runTb(ctx.dir, ctx.tb, ['vote', 'T1', '--by', 'r2', '--score', '0.5'])
    const r = lifecycle.done(ctx, 'T1', ['--verdict', 'pass'])
    assert.equal(r.json?.error, 'quorum_not_met', 'T4-A-quorum：未达标 pass 应 quorum_not_met')
  },
  'TB-vote-fail-effect': (ctx) => {
    lifecycle.create(ctx, 'T1', ['--kind', 'review', '--quorum-m', '2'])
    lifecycle.claim(ctx, 'T1', null)
    runTb(ctx.dir, ctx.tb, ['vote', 'T1', '--by', 'r1', '--score', '0'])
    runTb(ctx.dir, ctx.tb, ['vote', 'T1', '--by', 'r2', '--score', '0'])
    const out = lifecycle.list(ctx).stdout
    assert.match(out, /repair/, 'T4-A-vote-fail：fail 生效应自动生成 repair 任务')
  },
  'TB-vote-duplicate': (ctx) => {
    lifecycle.create(ctx, 'T1', ['--kind', 'review', '--quorum-m', '2'])
    lifecycle.claim(ctx, 'T1', null)
    runTb(ctx.dir, ctx.tb, ['vote', 'T1', '--by', 'r1', '--score', '1'])
    const r = runTb(ctx.dir, ctx.tb, ['vote', 'T1', '--by', 'r1', '--score', '1'])
    assert.equal(r.json?.error, 'duplicate_vote', 'T4-A-dup：重复投票应 duplicate_vote')
  },
  'TB-watchdog-window': (ctx) => {
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', null)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30) // 防同毫秒：确保 activity 落在窗口外
    const r = runTb(ctx.dir, ctx.tb, ['watchdog', '--window-sec', '0', '--max-nudges', '1'])
    assert.match(r.stdout, /已 nudge/, `T4-A-wd-window：窗口外任务应被 nudge（stdout=${r.stdout.trim()}）`)
  },
  'TB-watchdog-nudge-threshold': (ctx) => {
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', null)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
    runTb(ctx.dir, ctx.tb, ['watchdog', '--window-sec', '0', '--max-nudges', '2'])
    assert.equal(showStatus(ctx, 'T1'), 'running', 'T4-A-wd-threshold：首轮应只 nudge 不 reclaim')
  },
  'TB-watchdog-review-no-adopt': (ctx) => {
    lifecycle.create(ctx, 'T1', ['--kind', 'review', '--quorum-m', '2'])
    lifecycle.claim(ctx, 'T1', 'a1')
    writeInboxMsg(ctx.dir, {
      id: 'm1', from: 'qa', to: 'coordinator', ts: '2026-01-01T00:00:00.000Z',
      task: 'T1', attempt_id: 'a1', subject: '[交付] 评审完成', body: '产物: 评审意见已归档',
    })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
    runTb(ctx.dir, ctx.tb, ['watchdog', '--window-sec', '0', '--max-nudges', '0'])
    assert.equal(showStatus(ctx, 'T1'), 'ready', 'T4-A-wd-adopt：review 任务应 reclaim 而非 adopt')
  },
  'TB-adopt-evidence-negative-words': (ctx) => {
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', 'a1')
    writeInboxMsg(ctx.dir, {
      id: 'm1', from: 'qa', to: 'coordinator', ts: '2026-01-01T00:00:00.000Z',
      task: 'T1', attempt_id: 'a1', subject: '已完成主体', body: '产物已生成，进行中收尾',
    })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
    runTb(ctx.dir, ctx.tb, ['watchdog', '--window-sec', '0', '--max-nudges', '0'])
    assert.equal(showStatus(ctx, 'T1'), 'ready', 'T4-A-negative：含负向词证据应被拒（reclaim）')
  },
  'TB-reclaim-revoke-attempt': (ctx) => {
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', 'a1')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
    runTb(ctx.dir, ctx.tb, ['watchdog', '--window-sec', '0', '--max-nudges', '0'])
    // 注：reclaim 后任务回 ready，done 会被 running-only 门禁先拦（无法经此观察代际撤销），
    // 故直断板状态：孤儿代际 a1 必须记入 attempt_revoked 且 attempt_id 被 pop
    //（迟到汇报被拒的行为面由 TB-attempt-stale / TB-claim-revoke-old-attempt 覆盖）。
    const board = JSON.parse(readFileSync(boardPath(ctx.dir), 'utf-8'))
    const t1 = board.tasks.T1
    assert.ok((t1.attempt_revoked ?? []).includes('a1'),
      `T4-A-reclaim：reclaim 应将孤儿代际 a1 记入 attempt_revoked，实为 ${JSON.stringify(t1.attempt_revoked)}`)
    assert.ok(!t1.attempt_id, `T4-A-reclaim：reclaim 应 pop attempt_id，实为 ${JSON.stringify(t1.attempt_id)}`)
  },
  'TB-claim-revoke-old-attempt': (ctx) => {
    // 注：done --verdict needs_revision 仅限 review 任务（普通任务拒绝）；且行为面 stale_attempt
    // 会被 check_attempt 的 revoked 第一道闸拦下（无法区分本锚点），故状态面直断：
    // 换代认领必须把旧代际写入 attempt_revoked（旧代不得继续无痕存活）。
    lifecycle.create(ctx, 'T1'); lifecycle.claim(ctx, 'T1', 'a1')
    const bp = boardPath(ctx.dir)
    const board = JSON.parse(readFileSync(bp, 'utf-8'))
    board.tasks.T1.status = 'ready' // 手工回 ready（保留 attempt_id=a1、attempt_revoked 不含 a1）
    writeFileSync(bp, JSON.stringify(board))
    const r = lifecycle.claim(ctx, 'T1', 'a2') // 换代认领：a1 应被撤销入 revoked
    assert.equal(r.code, 0, `T4-A-claim-revoke：换代认领应成功（stderr=${r.stderr.trim()}）`)
    const after = JSON.parse(readFileSync(bp, 'utf-8')).tasks.T1
    assert.equal(after.attempt_id, 'a2', `T4-A-claim-revoke：当前代际应为 a2，实为 ${JSON.stringify(after.attempt_id)}`)
    assert.ok((after.attempt_revoked ?? []).includes('a1'),
      `T4-A-claim-revoke：旧代际 a1 应记入 attempt_revoked，实为 ${JSON.stringify(after.attempt_revoked)}`)
  },
  'TB-event-hash-chain': (ctx) => {
    lifecycle.create(ctx, 'T1')
    const eventsPath = `${boardPath(ctx.dir)}.events.jsonl`
    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    lines[0].args = { ...lines[0].args, reason: 'tampered-by-T4' } // 篡改首事件载荷（seq/prev 链不动）
    writeFileSync(eventsPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const r = runTb(ctx.dir, ctx.tb, ['show', 'T1'])
    assert.equal(r.json?.error, 'unrecoverable', `T4-A-hash：篡改事件流应 unrecoverable（stdout=${r.stdout.trim()}）`)
  },
  'TB-receipt-contract': (ctx) => {
    // 直接 importlib 加载 tmp 副本模块，单测 _receipt_check 契约（模块顶层无副作用，main 有守卫）。
    const script = [
      'import importlib.util, sys, io, contextlib',
      `spec = importlib.util.spec_from_file_location('tb_mut', ${JSON.stringify(ctx.tb)})`,
      'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
      'buf = io.StringIO()',
      'try:',
      "    with contextlib.redirect_stdout(buf): mod._receipt_check({'ok': True}, ('ok', 'cmd', 'data'), True)",
      'except SystemExit as e:',
      "    assert e.code == 1, f'应 SystemExit(1)，实为 {e.code}'",
      "    assert 'receipt_invalid' in buf.getvalue(), f'应输出 receipt_invalid，实为 {buf.getvalue()!r}'",
      '    sys.exit(7)',  // 7 = probe 自证翻红成功（断言全过）
      "raise AssertionError(f'残缺回执未被拒绝：stdout={buf.getvalue()!r}')",
    ].join('\n')
    const r = spawnSync('python3', ['-c', script], { cwd: ctx.dir, encoding: 'utf-8' })
    assert.equal(r.status, 7, `T4-A-receipt：_receipt_check 应拒绝残缺回执（stderr=${(r.stderr ?? '').trim()})`)
  },
  'TB-revision-increment': (ctx) => {
    lifecycle.create(ctx, 'T1')
    const out = lifecycle.list(ctx).stdout.trimEnd().split('\n').pop()
    assert.match(out, /revision=1\s*$/, `T4-A-revision：list 尾行应 revision=1，实为 ${out}`)
  },
  'TB-needs-revision-escalation': (ctx) => {
    // 注：done --verdict needs_revision 仅限 review 任务；review --quorum-m 1 可无票直接 nr
    //（实测：4 轮 claim→done nr，round1-3 回 ready，round4 count=3>2 → escalated）。
    lifecycle.create(ctx, 'T1', ['--kind', 'review', '--quorum-m', '1'])
    for (let i = 0; i < 4; i++) {
      lifecycle.claim(ctx, 'T1', `a${i + 1}`)
      lifecycle.done(ctx, 'T1', ['--verdict', 'needs_revision', '--findings', `f${i}`])
    }
    assert.equal(showStatus(ctx, 'T1'), 'escalated', 'T4-A-escalate：第 4 轮返工应 escalated 终态')
  },
  'BUS-msg-required-fields': (ctx) => {
    writeInboxMsg(ctx.dir, { id: 'm1', from: 'qa', to: 'coordinator' }) // 缺 ts
    const r = runBus(ctx.dir, ctx.bus, ['read', '--box', 'coordinator'])
    assert.equal(r.json?.error, 'message_invalid', 'T4-A-bus-fields：缺 ts 消息应 message_invalid')
  },
  'BUS-deliver-preserve-read': (ctx) => {
    const s1 = runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'first', '--body', 'T4'])
    const id1 = (s1.stdout.match(/已投递 (\S+) ->/) ?? [])[1] // send 输出为人读文本（非 JSON 信封）
    runBus(ctx.dir, ctx.bus, ['ack', '--box', 'coordinator', '--id', id1])
    rmSync(join(ctx.dir, '.expert-bus', '_outbox', 'qa', 'cursor.json'), { force: true }) // 强制重投
    runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'second', '--body', 'T4'])
    const out = runBus(ctx.dir, ctx.bus, ['read', '--box', 'coordinator', '--unread']).stdout
    assert.ok(!out.includes(id1), 'T4-A-preserve-read：重投不得复活已读标记')
  },
  'BUS-cursor-advance': (ctx) => {
    runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'm1', '--body', 'T4'])
    const cur = JSON.parse(readFileSync(join(ctx.dir, '.expert-bus', '_outbox', 'qa', 'cursor.json'), 'utf-8'))
    assert.equal(cur.seq, 1, `T4-A-cursor：游标应推进到 seq=1，实为 ${JSON.stringify(cur)}`)
    assert.ok(cur.cursor, 'T4-A-cursor：游标应记录最后投递条目名（save_cursor 键名 cursor）')
  },
  'BUS-seq-monotonic': (ctx) => {
    runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'm1', '--body', 'T4'])
    runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'm2', '--body', 'T4'])
    const seqs = [...runBus(ctx.dir, ctx.bus, ['read', '--box', 'coordinator']).stdout.matchAll(/seq=(\d+)/g)].map((m) => Number(m[1]))
    assert.deepEqual(seqs, [1, 2], `T4-A-seq：两次发送 seq 应 [1,2]，实为 ${JSON.stringify(seqs)}`)
  },
  'BUS-since-seq-filter': (ctx) => {
    runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'm1', '--body', 'T4'])
    const out = runBus(ctx.dir, ctx.bus, ['read', '--box', 'coordinator', '--since-seq', '1']).stdout
    assert.ok(!out.includes('--- '), `T4-A-since-seq：seq<=1 应被过滤，实为 ${out.trim()}`)
  },
  'BUS-revoked-authority': (ctx) => {
    writeLegacyBoard(ctx.dir, {
      id: 'T1', status: 'running', attempt_id: 'a1', attempt_revoked: ['a1'],
      title: 't', owner: 'qa', dep: [], scope: [],
    })
    writeInboxMsg(ctx.dir, {
      id: 'm1', from: 'qa', to: 'coordinator', ts: '2026-01-01T00:00:00.000Z',
      task: 'T1', attempt_id: 'a1', subject: '过期代际消息',
    })
    const out = runBus(ctx.dir, ctx.bus, ['read', '--box', 'coordinator']).stdout
    assert.match(out, /已归档过期消息/, `T4-A-revoked：撤销权威应归档过期消息，实为 ${out.trim()}`)
  },
  'BUS-corrupt-quarantine': (ctx) => {
    writeCorruptOutbox(ctx.dir, 'aaa.json')
    runBus(ctx.dir, ctx.bus, ['send', '--from', 'qa', '--to', 'coordinator', '--subject', 'm1', '--body', 'T4'])
    const outbox = join(ctx.dir, '.expert-bus', '_outbox', 'qa')
    assert.ok(existsSync(join(outbox, 'aaa.json.corrupt')), 'T4-A-quarantine：损坏残件应隔离为 .corrupt')
    assert.ok(!existsSync(join(outbox, 'aaa.json')), 'T4-A-quarantine：损坏残件不应留在投递队列')
  },
}

// ---------------------------------------------------------------------------
// 主测试
// ---------------------------------------------------------------------------
test('T4 变异测试族：taskboard.py/bus.py 门禁逻辑 29 点变异捕获（DSH_EXPERT_MUTANTS=1 启用；署名 qa-test-engineer）',
  { skip: GATED ? false : '未设 DSH_EXPERT_MUTANTS=1：变异测试默认关闭（正常跑批不执行注入）' },
  async (t) => {
    await t.test('T4-R0 登记表锚点校验：pristine 源文件 anchor 唯一、mutant≠anchor、行号在文件范围内', () => {
      assert.equal(REGISTRY.length, 29, '登记表应为 29 点（taskboard 22 + bus 7）')
      const ids = new Set()
      for (const m of REGISTRY) {
        assert.ok(!ids.has(m.id), `登记表 id 重复：${m.id}`); ids.add(m.id)
        assert.notEqual(m.anchor, m.mutant, `${m.id}：mutant 不得与 anchor 相同`)
        assert.equal(PRISTINE[m.file].split(m.anchor).length - 1, 1,
          `${m.id}：anchor 应在 pristine ${m.file} 中恰出现 1 次（源码演化后须同步登记表）`)
        const lines = PRISTINE[m.file].split('\n')
        assert.ok(m.line >= 1 && m.line <= lines.length, `${m.id}：行号 ${m.line} 超出 ${m.file} 范围`)
        assert.ok(lines[m.line - 1].includes(m.anchor.split('\n')[0].trim().slice(0, 24)),
          `${m.id}：行号 ${m.line} 与 anchor 首行失配（登记表须随源码行号同步）`)
      }
    })

    for (const m of REGISTRY) {
      await t.test(`T4-M/${m.id}：${m.target}`, () => {
        const dir = makeDir(t, m.id.toLowerCase())
        const paths = deployPristine(dir)
        inject(dir, m)
        const ctx = { dir, ...paths }
        // probe 契约：抛 AssertionError = 门禁有效（变异被捕获）；不抛 = 变异逃逸。
        assert.throws(() => PROBES[m.id](ctx), (err) => err instanceof assert.AssertionError,
          `变异 ${m.id} 逃逸：门禁「${m.assertion}」被变异后 probe 仍绿——门禁为装饰性 if 或 probe 失配`)
      })
    }
  })
