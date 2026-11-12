// test/taskboard-tags-capability.selftest.mjs — T8 能力标签自测（node:test，零依赖）。
// 覆盖验收 a–d：a) 不带 --tags 的 create/claim/claim_idle 与固定基线 ca91bda（T7 已交付版）逐字节一致
//    （双版本同输入回归实测 + 事件 args 键集一致）；b) tag_mismatch 拒绝面：claim 无声明/
//    无交集具名拒绝零写零事件、claim_idle 逐候选跳过（skipped.reason=tag_mismatch）、
//    全跳过仍走 claim_idle_noop；c) 事件 args 携带 tags/claimant tags 留档（未声明形状不变），
//    show/list 展示 tags（人读面新增属预期，仅带 tags 字段的任务变化）；d) M1（--created-by/
//    --of）与 --tags 正交：同传成功、M1 校验链照常执法、tags 不参与 scope 校验。
// 全部用例跑在 tmp 隔离目录（mkdtemp），不触碰本仓任务板。署名：backend-engineer
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。tb 可覆盖为 HEAD 基线副本。 */
const runTb = (cwd, args, tb = TASKBOARD) => {
  const r = spawnSync('python3', [tb, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t8-tags-cap-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
// exposure-crypto 收口轮（N2）显式 additive 契约增量：写命令 --json 信封顶层 event_seq（事件流
// 对账锚点）与 create 的 data.task（创建后任务审计快照）——旧基线（ca91bda）无此二键；比对前
// 双版本同函数剥除，其余输出（含人读面与 show 的 data.task）仍逐字节一致。
const stripAuditAdditions = (s) => s
  .replace(/, "event_seq": \d+\}/g, '}')
  .replace(/("cmd": "create", "data": )\{"task": \{.*?\}\}, ("revision")/g, '$1{}, $2')
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l))

// ── a) 缺省兼容：不带 --tags 双版本（HEAD vs 当前）同输入逐字节回归 ──────────
test('T8-a 缺省兼容：create/claim/claim_idle 不带 --tags 与 HEAD 逐字节一致；事件 args 键集一致', (t) => {
  // 固定基线副本（T7 交付版 commit ca91bda）落 tmp，双版本跑同一不含 --tags 的命令脚本。
  // T12 评审🟡1：原用 `git show HEAD:`，HEAD 落 T8/T9 后 HEAD blob==工作树文件，退化为恒真空转，故钉固定 commit。
  const head = spawnSync('git', ['show', 'ca91bda:skills/expert-orchestration/tools/taskboard.py'],
    { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, 'git show ca91bda 基线可读')
  const headPy = join(mkdtempSync(join(tmpdir(), 't8-head-')), 'taskboard_head.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const dirCur = makeBoardDir(t, 'a-cur')
  const dirHead = makeBoardDir(t, 'a-head')
  const script = [
    ['create', '任务A', '--owner', '甲'],
    ['create', '任务B'],
    ['--json', 'create', '任务C', '--owner', '丁', '--scope', 'src'],
    ['claim', 'T1', '甲'],
    ['--json', 'claim_idle', '编排者', 'T2', 'T3'],
  ]
  const outs = script.map((args) => ({
    args,
    cur: runTb(dirCur, args),
    old: runTb(dirHead, args, headPy),
  }))
  for (const { args, cur, old } of outs) {
    assert.equal(stripAuditAdditions(cur.stdout), stripAuditAdditions(old.stdout), `缺省输出逐字节一致（N2 additive 键剥除后）：${args.join(' ')}`)
    assert.equal(cur.code, old.code)
    if (args[0] === '--json') {
      // --json data 键集一致（T3 任务对象无 tags 字段、claim_idle data 键集一致；error 信封无 data
      // 双版本同形）——create 的 data.task 为 N2 审计回显 additive 键，双版本不对称属预期，过滤后比。
      const curKeys = Object.keys(cur.json.data || {}).filter((k) => !(args[1] === 'create' && k === 'task'))
      assert.deepEqual(curKeys, Object.keys(old.json.data || {}))
      if (cur.json.data?.task && old.json.data?.task) assert.deepEqual(Object.keys(cur.json.data.task), Object.keys(old.json.data.task))
    }
  }
  // 事件 args 键集一致（双版本全部事件逐条比对 type 与 args 键集）
  const evCur = eventsOf(dirCur)
  const evOld = eventsOf(dirHead)
  assert.equal(evCur.length, evOld.length)
  for (let i = 0; i < evCur.length; i++) {
    assert.equal(evCur[i].type, evOld[i].type)
    assert.deepEqual(Object.keys(evCur[i].args || {}).sort(), Object.keys(evOld[i].args || {}).sort())
  }
})

// ── b) create --tags：落 tags 数组、去重保序、show/list 展示、事件留档、无效声明拒绝 ──
test('T8-b create --tags：逗号解析去重保序、任务 JSON 落 tags、show/list 展示、事件 args.tags 留档、空声明拒绝', (t) => {
  const dir = makeBoardDir(t, 'create')
  const py = (...args) => runTb(dir, args)
  assert.equal(py('create', '任务A', '--tags', 'python, backend ,python,').stdout,
    'T1 [ready] 任务A tags=python,backend\n依赖已满足，自动转 ready: T1\nrevision=1\n')
  assert.deepEqual(boardOf(dir).tasks.T1.tags, ['python', 'backend'])
  // --json data.task 携带 tags
  const j = py('--json', 'show', 'T1')
  assert.deepEqual(j.json.data.task.tags, ['python', 'backend'])
  // 缺省 create 不落 tags 字段（输出逐字节不变+JSON 无 tags 键）
  assert.equal(py('create', '任务B', '--owner', '乙').stdout,
    'T2 [ready] 任务B owner=乙\n依赖已满足，自动转 ready: T2\nrevision=2\n')
  assert.equal(py('--json', 'show', 'T2').json.data.task.tags, undefined)
  // 事件留档：带 --tags 的 create args 携带 tags（归一后值）；缺省 create args 无 tags 键
  const ev = eventsOf(dir)
  assert.deepEqual(ev[0].args.tags, ['python', 'backend'])
  assert.equal('tags' in ev[1].args, false)
  // 无效声明（空串/纯逗号）具名拒绝，零写零事件
  const rev = boardOf(dir).revision
  const evN = ev.length
  const bad = py('--json', 'create', '任务C', '--tags', ' , ')
  assert.equal(bad.code, 1)
  // --json 下 sys.exit 文本拒绝被 main 收编为 command_failed 信封（message 原文保留，与既有拒绝同形态）
  assert.equal(bad.json.error, 'command_failed')
  assert.match(bad.json.message, /--tags 须为至少一个非空标签/)
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
})

// ── c) claim tag_mismatch 拒绝面 ────────────────────────────────────────
test('T8-c claim --tags：无声明/无交集 tag_mismatch 拒绝零写零事件；交集成功；无 tags 任务不受影响', (t) => {
  const dir = makeBoardDir(t, 'claim')
  const py = (...args) => runTb(dir, args)
  py('create', '任务A', '--tags', 'python,ml')
  py('create', '任务B')
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  // 任务带 tags 而声明缺失 → 拒（宁拒勿猜 Q3）
  let r = py('--json', 'claim', 'T1', '丙')
  assert.equal(r.json.error, 'tag_mismatch')
  assert.deepEqual(r.json.task_tags, ['python', 'ml'])
  assert.equal(r.json.claimant_tags, null)
  // 声明无交集 → 拒
  r = py('--json', 'claim', 'T1', '丙', '--tags', 'go,rust')
  assert.equal(r.json.error, 'tag_mismatch')
  assert.deepEqual(r.json.claimant_tags, ['go', 'rust'])
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)  // 两次拒绝均零写零事件
  // 交集成功；声明值随事件 args 留档
  assert.equal(py('claim', 'T1', '丙', '--tags', 'rust,python').stdout,
    'T1 [running] 任务A owner=丙 tags=python,ml\nrevision=' + (rev + 1) + '\n')
  const ev = eventsOf(dir).at(-1)
  assert.equal(ev.type, 'claim')
  assert.deepEqual(ev.args, { owner: '丙', attempt: null, tags: ['rust', 'python'] })
  // 任务无 tags：不带 --tags 认领不受影响（向后兼容）
  assert.equal(py('claim', 'T2', '甲').stdout, 'T2 [running] 任务B owner=甲\nrevision=' + (rev + 2) + '\n')
  assert.equal('tags' in eventsOf(dir).at(-1).args, false)  // 未声明时事件形状不变
})

// ── d) claim_idle --tags 过滤：逐候选跳过 + noop 语义不破坏 + 事件留档 ─────────
test('T8-d claim_idle --tags：不匹配逐个跳过（skipped.reason=tag_mismatch）、不带 --tags 时 tagged 一律跳过、全跳过仍 claim_idle_noop', (t) => {
  // 场景 1：不带 --tags——tagged 候选一律跳过（宁漏勿错），无 tags 候选照常认领
  const dir = makeBoardDir(t, 'idle-nodeclare')
  const py = (...args) => runTb(dir, args)
  py('create', '任务A')
  py('create', '任务B', '--tags', 'ml')
  py('create', '任务C', '--tags', 'go')
  let r = py('--json', 'claim_idle', '编排者', 'T1', 'T2', 'T3')
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.data.claimed, ['T1'])
  assert.deepEqual(r.json.data.skipped, [
    { id: 'T2', reason: 'tag_mismatch' },
    { id: 'T3', reason: 'tag_mismatch' },
  ])
  assert.equal('tags' in eventsOf(dir).at(-1).args, false)  // 未声明时事件形状不变

  // 场景 2：带 --tags——匹配候选认领、不匹配跳过；声明随事件 args 留档
  const dir2 = makeBoardDir(t, 'idle-declare')
  const py2 = (...args) => runTb(dir2, args)
  py2('create', '任务A', '--tags', 'ml')
  py2('create', '任务B', '--tags', 'go')
  py2('create', '任务C')
  r = py2('--json', 'claim_idle', '编排者', 'T1', 'T2', 'T3', '--tags', 'ml,py')
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.data.claimed, ['T1', 'T3'])
  assert.deepEqual(r.json.data.skipped, [{ id: 'T2', reason: 'tag_mismatch' }])
  const ev = eventsOf(dir2).at(-1)
  assert.equal(ev.type, 'claim')
  assert.deepEqual(ev.args.tags, ['ml', 'py'])

  // 场景 3：全跳过 → claim_idle_noop 语义不破坏（零写零事件）
  const dir3 = makeBoardDir(t, 'idle-noop')
  const py3 = (...args) => runTb(dir3, args)
  py3('create', '任务A', '--tags', 'ml')
  const rev = boardOf(dir3).revision
  const evN = eventsOf(dir3).length
  r = py3('--json', 'claim_idle', '编排者', 'T1')
  assert.equal(r.json.error, 'claim_idle_noop')
  assert.deepEqual(r.json.skipped, [{ id: 'T1', reason: 'tag_mismatch' }])
  r = py3('--json', 'claim_idle', '编排者', 'T1', '--tags', 'go')
  assert.equal(r.json.error, 'claim_idle_noop')
  assert.deepEqual(r.json.skipped, [{ id: 'T1', reason: 'tag_mismatch' }])
  assert.equal(boardOf(dir3).revision, rev)
  assert.equal(eventsOf(dir3).length, evN)
})

// ── e) M1 正交：--tags 与 --created-by/--of 同传成功；M1 校验链照常执法；tags 不参与 scope 校验 ──
test('T8-e M1 组合：tags 与 created-by/of 正交同传成功、M1 缺 scope 照常拒绝、代理任务 tags 认领面照常', (t) => {
  const dir = makeBoardDir(t, 'm1')
  const py = (...args) => runTb(dir, args)
  let r
  // 父任务（owner=甲 scope=src）供代理创建核实
  py('create', '父任务', '--owner', '甲', '--scope', 'src')
  py('claim', 'T1', '甲')
  // 代理 scoped 自建 + --tags 同传：tags 落盘，scope 校验只看 --scope ⊆ 父 scope（tags 不参与）
  r = py('--json', 'create', '子任务', '--created-by', '甲', '--of', 'T1', '--scope', 'src', '--draft', '--tags', 'python')
  assert.equal(r.json.ok, true)
  const sub = boardOf(dir).tasks.T2  // create 无 id 属性，--json data 为空对象——任务对象从板文件断言
  assert.deepEqual(sub.tags, ['python'])
  assert.equal(sub.created_by, '甲')
  assert.deepEqual(eventsOf(dir).at(-1).args.tags, ['python'])
  // M1 校验链照常执法：带 --tags 但缺 --scope → agent_create_requires_scope（tags 不豁免 M1）
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  r = py('--json', 'create', '子任务2', '--created-by', '甲', '--of', 'T1', '--draft', '--tags', 'python')
  assert.equal(r.json.error, 'agent_create_requires_scope')
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  // 代理任务 approve 后照常走 tags 认领面
  py('approve', 'T2')
  r = py('--json', 'claim', 'T2', '乙', '--tags', 'python')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.data.task.status, 'running')
})
