// test/taskboard-agent-create.selftest.mjs — 代理 scoped 自建任务自测（M1，node:test，零依赖）。
// 覆盖验收 a–f：a) 不带新参数 create 逐字节兼容（输出格式精确断言 + 任务 JSON/事件 args 形状不变）；
// b) scope 越权创建具名拒绝 scope_out_of_violation；c) --of 非本人 owner 具名拒绝 not_task_owner；
// d) 创建成功任务 JSON 含 created_by 且 replay 复现该字段、事件流 type=create args 携带 created_by；
// e) 代理 draft claim 被拒、approve 后走通既有流程（reject 终态路径同验）；
// f) 本文件全部用例通过（npm test 收口）。
// 全部用例跑在 tmp 隔离目录（mkdtemp），不触碰本仓任务板。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。 */
const runTb = (cwd, args) => {
  const r = spawnSync('python3', [TASKBOARD, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t2-agent-create-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .map((l) => JSON.parse(l))

// ── a) 不带新参数 create 逐字节兼容 ────────────────────────────────
test('T2-a 逐字节兼容：不带新参数 create 人类面输出精确不变；--json 信封 data 形状不变；任务 JSON 无 created_by', (t) => {
  const dir = makeBoardDir(t, 'compat')
  // 人类面：完整 stdout 逐字节断言（含依赖提升行与 revision 尾行）
  const r = runTb(dir, ['create', '任务A', '--owner', '甲', '--desc', 'd1', '--scope', 'src'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'T1 [ready] 任务A owner=甲 scope=src\n依赖已满足，自动转 ready: T1\nrevision=1\n')
  assert.equal(r.stderr, '')
  // --json 信封：create 既有 data={} 形状不变
  const j = runTb(dir, ['--json', 'create', '任务B', '--dep', 'T1'])
  assert.equal(j.code, 0)
  assert.deepEqual(j.json, { ok: true, cmd: 'create', data: {}, revision: 2 })
  // 任务 JSON：无 created_by 键；事件流 type=create args 形状与旧版逐键一致
  for (const tid of ['T1', 'T2']) assert.ok(!('created_by' in boardOf(dir).tasks[tid]), tid)
  const createEvents = eventsOf(dir).filter((e) => e.type === 'create')
  assert.deepEqual(createEvents.map((e) => e.args), [
    { title: '任务A', owner: '甲', dep: [], desc: 'd1', scope: 'src', draft: false, kind: null },
    { title: '任务B', owner: '', dep: ['T1'], desc: '', scope: '', draft: false, kind: null },
  ])
})

// ── b) scope 越权创建具名拒绝 ────────────────────────────────────
test('T2-b scope 越权：新任务 scope 逐项 ⊆ --of 任务 scope（_scope_match 语义），越权具名拒绝且零落盘', (t) => {
  const dir = makeBoardDir(t, 'scope')
  assert.equal(runTb(dir, ['create', '父', '--owner', 'be', '--scope', 'skills,test']).code, 0)
  const before = readFileSync(join(dir, BOARD_REL))
  const evBefore = readFileSync(join(dir, EVENTS_REL))
  // 逐项语义：一项越权即整体拒绝；越权项清单如实回显
  for (const [badScope, expectOutOf] of [['lib', ['lib']], ['docs,test', ['docs']], ['skillsx', ['skillsx']]]) {
    const rej = runTb(dir, ['create', '子', '--created-by', 'be', '--of', 'T1', '--scope', badScope, '--draft'])
    assert.equal(rej.code, 1, badScope)
    assert.equal(rej.json.error, 'scope_out_of_violation', badScope)
    assert.deepEqual(rej.json.scope, expectOutOf, badScope)
  }
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before) // 零落盘
  assert.equal(readFileSync(join(dir, EVENTS_REL), 'utf-8'), evBefore.toString('utf-8')) // 零事件
  // 合法：前缀子域 + 精确项
  const ok = runTb(dir, ['create', '子', '--created-by', 'be', '--of', 'T1', '--scope', 'skills/x,test', '--draft'])
  assert.equal(ok.code, 0)
})

// ── c) --of 任务非本人 owner 拒绝 ─────────────────────────────────
test('T2-c not_task_owner：--of 不存在 / owner 不符 → 具名拒绝；成对性单独违反 → created_by_of_pair_required', (t) => {
  const dir = makeBoardDir(t, 'owner')
  assert.equal(runTb(dir, ['create', '父', '--owner', 'be']).code, 0)
  const before = readFileSync(join(dir, BOARD_REL))
  // --of 指向不存在任务
  const missing = runTb(dir, ['create', '子', '--created-by', 'be', '--of', 'T99', '--draft'])
  assert.equal(missing.code, 1)
  assert.equal(missing.json.error, 'not_task_owner')
  assert.equal(missing.json.of, 'T99')
  // owner != --created-by（认领关系不成立）
  const foreign = runTb(dir, ['create', '子', '--created-by', 'someone-else', '--of', 'T1', '--draft'])
  assert.equal(foreign.code, 1)
  assert.equal(foreign.json.error, 'not_task_owner')
  assert.equal(foreign.json.owner, 'be')
  assert.equal(foreign.json.created_by, 'someone-else')
  // 成对性：只给其一 → created_by_of_pair_required
  for (const args of [['create', '子', '--created-by', 'be'], ['create', '子', '--of', 'T1']]) {
    const pair = runTb(dir, args)
    assert.equal(pair.code, 1, args.join(' '))
    assert.equal(pair.json.error, 'created_by_of_pair_required', args.join(' '))
  }
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
})

// ── d) created_by 落字段 + replay 复现 + 事件流携带 ───────────────
test('T2-d created_by：任务 JSON 单键字符串字段；replay 复现该字段；事件流 type=create args 携带 created_by/of', (t) => {
  const dir = makeBoardDir(t, 'field')
  assert.equal(runTb(dir, ['create', '父', '--owner', 'be', '--scope', 'a']).code, 0)
  const ok = runTb(dir, ['create', '子', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft'])
  assert.equal(ok.code, 0)
  assert.ok(ok.stdout.includes('created_by=be'), ok.stdout)
  const task = boardOf(dir).tasks.T2
  assert.equal(task.created_by, 'be') // 单键字符串字段
  assert.equal(task.status, 'draft') // 代理创建强制 draft
  const createEvents = eventsOf(dir).filter((e) => e.type === 'create')
  assert.equal(createEvents[1].args.created_by, 'be') // 事件流携带 created_by
  assert.equal(createEvents[1].args.of, 'T1')
  // replay：显式从事件流重放折叠状态后 created_by 仍在（事件流权威可复现）
  const rp = runTb(dir, ['replay'])
  assert.equal(rp.code, 0)
  assert.equal(boardOf(dir).tasks.T2.created_by, 'be')
  assert.equal(runTb(dir, ['show', 'T2']).stdout.includes('created_by=be'), true)
})

// ── e) 代理 draft 待批面 + 既有流程走通 ───────────────────────────
test('T2-e 待批面：代理 draft claim 被拒（既有语义零改动）；approve→claim→done 走通；reject 终态路径同验', (t) => {
  const dir = makeBoardDir(t, 'flow')
  assert.equal(runTb(dir, ['create', '父', '--owner', 'be', '--scope', 'a']).code, 0)
  assert.equal(runTb(dir, ['create', '子', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft']).code, 0)
  // draft claim 被拒：零事件零落盘
  const before = readFileSync(join(dir, BOARD_REL))
  const rej = runTb(dir, ['claim', 'T2', 'be'])
  assert.equal(rej.code, 1)
  assert.ok(rej.stderr.includes('draft'), rej.stderr)
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
  // 非显式 draft（缺 --draft）在创建期即被拒
  const nodraft = runTb(dir, ['create', '子2', '--created-by', 'be', '--of', 'T1', '--scope', 'a'])
  assert.equal(nodraft.code, 1)
  assert.equal(nodraft.json.error, 'agent_create_requires_draft')
  // --kind review 与代理创建同传 → 具名拒绝（Q5 裁决）
  const kind = runTb(dir, ['create', '子3', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft', '--kind', 'review'])
  assert.equal(kind.code, 1)
  assert.equal(kind.json.error, 'agent_create_kind_rejected')
  // approve → ready → claim → done：既有命令与语义零改动
  assert.equal(runTb(dir, ['approve', 'T2']).code, 0)
  assert.equal(runTb(dir, ['claim', 'T2', 'be']).code, 0)
  assert.equal(runTb(dir, ['done', 'T2', '完成', '--by', 'be']).code, 0)
  assert.equal(boardOf(dir).tasks.T2.status, 'done')
  assert.equal(boardOf(dir).tasks.T2.created_by, 'be') // 终态字段不丢
  // reject 路径：代理 draft → rejected 终态
  assert.equal(runTb(dir, ['create', '子4', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft']).code, 0)
  assert.equal(runTb(dir, ['reject', 'T3']).code, 0)
  assert.equal(boardOf(dir).tasks.T3.status, 'rejected')
  const rejClaim = runTb(dir, ['claim', 'T3', 'be'])
  assert.equal(rejClaim.code, 1) // rejected 不可 claim
})

// ── json 错误信封：具名错误在 --json 模式归一为 {"ok":false,error,...} ──
test('T2-json 错误信封：代理创建具名拒绝在 --json 模式为 {"ok":false,...} 且退出码 1', (t) => {
  const dir = makeBoardDir(t, 'jsonerr')
  const r = runTb(dir, ['--json', 'create', '子', '--created-by', 'be'])
  assert.equal(r.code, 1)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.error, 'created_by_of_pair_required')
  assert.ok(!existsSync(join(dir, BOARD_REL)) || !('T1' in boardOf(dir).tasks)) // 零落盘
})
