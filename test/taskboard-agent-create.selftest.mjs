// test/taskboard-agent-create.selftest.mjs — 代理 scoped 自建任务自测（M1，node:test，零依赖）。
// 覆盖验收 a–f：a) 不带新参数 create 逐字节兼容（输出格式精确断言 + 任务 JSON/事件 args 形状不变）；
// b) scope 越权创建具名拒绝 scope_out_of_violation；c) --of 非本人 owner 具名拒绝 not_task_owner；
// d) 创建成功任务 JSON 含 created_by 且 replay 复现该字段、事件流 type=create args 携带 created_by；
// e) 代理 draft claim 被拒、approve 后走通既有流程（reject 终态路径同验）；
// f) 本文件全部用例通过（npm test 收口）。
// T15 增补：受限免审批创建 --auto-ready（Q2 显式参数；Q3 ⑥ open-cap 前置恒生效不依赖执法
//    开关）——a-T15) 缺省路径与基线 T15_BASELINE 双版本逐字节+事件 args 键集；b-T15) 前置
//    ⑥⑦⑧ 全过直达 ready（单事件 args 含 auto_ready+open_count、checkpoint 免审证据注记、
//    claim/done E2E）；c-T15) 三前置任一不过具名拒零写零事件（agent_create_open_cap/
//    agent_create_parent_closed/agent_create_dep_cross_owner）+hint 指路 draft 回退可用；
//    d-T15) --kind review 同传仍拒（review 永不免审）+误用面（缺代理身份/与 --draft 互斥）。
//    e-T22) 免审前置⑧加严（dep 全部本人名下且全部 done）：dep 未 done 具名拒
//    agent_create_dep_open（零写零事件不静默降级）+ dep 全 done 后重试直达 ready。
// 全部用例跑在 tmp 隔离目录（mkdtemp），不触碰本仓任务板。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。
 * opts.extraEnv 逐键注入环境（T15 cap 阈值覆盖等）；opts.tb 覆盖脚本路径（双版本基线回归）。 */
const runTb = (cwd, args, { extraEnv = {}, omitEnv = [], tb = TASKBOARD } = {}) => {
  const env = { ...process.env }
  for (const k of omitEnv) delete env[k]
  Object.assign(env, extraEnv)
  const r = spawnSync('python3', [tb, ...args], { cwd, encoding: 'utf-8', env })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

// 时间戳归一（双版本逐字节比对用）：created/updated 毫秒值、checkpoint time/ts、人类面 [日期时间]
const norm = (s) => s.replace(/"(created|updated)": \d+/g, '"$1": T')
  .replace(/"(time|ts)": "[^"]*"/g, '"$1": "T"')
  .replace(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g, '[T]')

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
  // --json 信封：create 回执自 exposure-crypto 收口轮（N2）起带创建后任务审计快照——
  // 恰键集扩展为 {ok,cmd,data,revision,event_seq}，data.task 快照可对账（additive 契约）；
  // 人读面（上方断言）逐字节不变。
  const j = runTb(dir, ['--json', 'create', '任务B', '--dep', 'T1'])
  assert.equal(j.code, 0)
  assert.deepEqual(Object.keys(j.json), ['ok', 'cmd', 'data', 'revision', 'event_seq'])
  assert.equal(j.json.ok, true)
  assert.equal(j.json.cmd, 'create')
  assert.equal(j.json.revision, 2)
  assert.equal(j.json.event_seq, 2)
  assert.equal(j.json.data.task.id, 'T2')
  assert.equal(j.json.data.task.status, 'pending', '依赖 T1 未 done → 不提升，最终态如实回显')
  assert.equal(j.json.data.task.title, '任务B')
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

// ── T6/B1 回归：--created-by 空串/纯空白绕过校验链①（''!='' 恒过无主父任务）——入口归一 ──
test('T6-B1 入口归一：空串/纯空白视同缺参 → created_by_of_pair_required（含无主父任务旁路实证拒绝 + 双空串不走 lead 路径 + 零落盘零事件）', (t) => {
  const dir = makeBoardDir(t, 'b1')
  // 无主父任务（owner=''）：评审 B1 的原始旁路形态——旧代码 --created-by "" --of T1 以 ''!=''=False 恒过
  assert.equal(runTb(dir, ['create', '无主父']).code, 0)
  const before = readFileSync(join(dir, BOARD_REL))
  const evBefore = readFileSync(join(dir, EVENTS_REL), 'utf-8')
  // 空串 + --of：不再落入校验链①，成对性归一后具名拒绝
  const empty = runTb(dir, ['--json', 'create', '子', '--created-by', '', '--of', 'T1', '--scope', 'a', '--draft'])
  assert.equal(empty.code, 1)
  assert.equal(empty.json.error, 'created_by_of_pair_required')
  // 归一边界：纯空白串视同空（空格/Tab 混排）
  for (const blank of ['   ', '\t', ' \t ']) {
    const rej = runTb(dir, ['--json', 'create', '子', '--created-by', blank, '--of', 'T1', '--scope', 'a', '--draft'])
    assert.equal(rej.code, 1, JSON.stringify(blank))
    assert.equal(rej.json.error, 'created_by_of_pair_required', JSON.stringify(blank))
  }
  // 只给其一但给的也是空白 → 同一具名成对错误（不得静默按缺参走 lead 路径）
  for (const args of [['create', '子', '--created-by', '  '], ['create', '子', '--of', '\t']]) {
    const one = runTb(dir, ['--json', ...args])
    assert.equal(one.code, 1, args.join(' '))
    assert.equal(one.json.error, 'created_by_of_pair_required', args.join(' '))
  }
  // 双空串/双空白：不得归一成双缺参后冒充 lead 派发成功创建（同样成对错误拒绝）
  for (const args of [['--created-by', '', '--of', ''], ['--created-by', ' ', '--of', '\t']]) {
    const both = runTb(dir, ['--json', 'create', '子', ...args, '--draft'])
    assert.equal(both.code, 1, args.join(' '))
    assert.equal(both.json.error, 'created_by_of_pair_required', args.join(' '))
  }
  // 零落盘零事件（板文件与事件流字节级不变；上述拒绝无任何写入）
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
  assert.equal(readFileSync(join(dir, EVENTS_REL), 'utf-8'), evBefore)
  // 归一正向边界：空白包夹的合法名 ' be ' 归一为 'be'，与 owner 精确匹配后可创建
  assert.equal(runTb(dir, ['create', '有主父', '--owner', 'be', '--scope', 'a']).code, 0)
  const ok = runTb(dir, ['create', '子', '--created-by', ' be ', '--of', 'T2', '--scope', 'a', '--draft'])
  assert.equal(ok.code, 0)
  const task = boardOf(dir).tasks.T3
  assert.equal(task.created_by, 'be') // 落盘为归一后值（非 ' be '）
  const createEvents = eventsOf(dir).filter((e) => e.type === 'create')
  assert.equal(createEvents.at(-1).args.created_by, 'be') // 事件流留档与落盘字段一致
  assert.equal(createEvents.at(-1).args.of, 'T2')
})

// ── T6/I1 回归：代理创建空/缺 scope 穿过链② → approve 后 commit 门禁第三查 fail-open ──
test('T6-I1 scope 必填：不带 --scope / 空串 / 纯空白逗号串 → agent_create_requires_scope（不继承父 scope，零落盘）', (t) => {
  const dir = makeBoardDir(t, 'i1')
  assert.equal(runTb(dir, ['create', '父', '--owner', 'be', '--scope', 'a']).code, 0)
  const before = readFileSync(join(dir, BOARD_REL))
  const evBefore = readFileSync(join(dir, EVENTS_REL), 'utf-8')
  // 缺 --scope：旧代码 agent_scope 空列表 out_of 恒空空泛穿链②
  const noScope = runTb(dir, ['--json', 'create', '子', '--created-by', 'be', '--of', 'T1', '--draft'])
  assert.equal(noScope.code, 1)
  assert.equal(noScope.json.error, 'agent_create_requires_scope')
  assert.equal(noScope.json.of, 'T1')
  // 空串 / 纯空白逗号串（归一后等价空列表）同样拒绝
  for (const scope of ['', '   ', ' , , ', ',']) {
    const rej = runTb(dir, ['--json', 'create', '子', '--created-by', 'be', '--of', 'T1', '--scope', scope, '--draft'])
    assert.equal(rej.code, 1, JSON.stringify(scope))
    assert.equal(rej.json.error, 'agent_create_requires_scope', JSON.stringify(scope))
  }
  // 不继承父 scope：拒绝而非默认落父 scope（显式性裁定）
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
  assert.equal(readFileSync(join(dir, EVENTS_REL), 'utf-8'), evBefore) // 零落盘零事件
  // 显式非空 scope 且 ⊆ 父 scope → 照常创建（链②原有语义不变）
  const ok = runTb(dir, ['create', '子', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft'])
  assert.equal(ok.code, 0)
  assert.deepEqual(boardOf(dir).tasks.T2.scope, ['a'])
})

// ── T6/I2 回归：--owner 与 --created-by 无一致性校验 → 预派他人任务 ──
test('T6-I2 自建自领：显式 --owner ≠ --created-by → agent_owner_mismatch（含纯空白 owner）；--owner 空或缺省行为不变；--owner == created-by 允许', (t) => {
  const dir = makeBoardDir(t, 'i2')
  assert.equal(runTb(dir, ['create', '父', '--owner', 'be', '--scope', 'a']).code, 0)
  const before = readFileSync(join(dir, BOARD_REL))
  // 预派他人：旧代码产出 owner=别人/created_by=be 的任务（评审 I2 实证形态）
  const foreign = runTb(dir, ['--json', 'create', '子', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft', '--owner', '别人'])
  assert.equal(foreign.code, 1)
  assert.equal(foreign.json.error, 'agent_owner_mismatch')
  assert.equal(foreign.json.owner, '别人')
  assert.equal(foreign.json.created_by, 'be')
  // 归一边界：纯空白 owner ≠ created-by，同样拒绝
  const blank = runTb(dir, ['--json', 'create', '子', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft', '--owner', '  '])
  assert.equal(blank.code, 1)
  assert.equal(blank.json.error, 'agent_owner_mismatch')
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before) // 零落盘
  // --owner 缺省：行为不变（owner 不落、claim 时再定）
  assert.equal(runTb(dir, ['create', '子1', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft']).code, 0)
  assert.equal(boardOf(dir).tasks.T2.owner, '')
  assert.equal(boardOf(dir).tasks.T2.created_by, 'be')
  // --owner 空串：为空（ruling「a.owner 为空或 == created_by」）→ 允许，owner 不落
  assert.equal(runTb(dir, ['create', '子2', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft', '--owner', '']).code, 0)
  assert.equal(boardOf(dir).tasks.T3.owner, '')
  // --owner == created-by：自建自领允许，owner 落 created-by 本身
  assert.equal(runTb(dir, ['create', '子3', '--created-by', 'be', '--of', 'T1', '--scope', 'a', '--draft', '--owner', 'be']).code, 0)
  assert.equal(boardOf(dir).tasks.T4.owner, 'be')
  assert.equal(boardOf(dir).tasks.T4.created_by, 'be')
  // approve → claim（自建自领后归属展示一致）
  assert.equal(runTb(dir, ['approve', 'T4']).code, 0)
  const claimed = runTb(dir, ['claim', 'T4', 'be'])
  assert.equal(claimed.code, 0)
  assert.equal(boardOf(dir).tasks.T4.owner, 'be')
})

// ── T15) 受限免审批创建 --auto-ready（Q2 显式参数；Q3 open-cap 前置恒生效不依赖执法开关）──

const T15_BASELINE = '57bb21c' // T20 交付版（T15 动工前固定基线，HEAD 推进后仍钉此 commit）

test('T15-a 缺省逐字节：不带 --auto-ready 的 lead/代理 draft 脚本与基线 T15_BASELINE 双版本一致（stdout+exit+事件 args 键集）', (t) => {
  const head = spawnSync('git', ['show', `${T15_BASELINE}:skills/expert-orchestration/tools/taskboard.py`],
    { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, `git show ${T15_BASELINE} 基线可读`)
  const headPy = join(mkdtempSync(join(tmpdir(), 't15-head-')), 'taskboard_head.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const script = [
    ['create', '父任务', '--owner', '甲', '--scope', 'src'],
    ['create', '草稿', '--created-by', '甲', '--of', 'T1', '--scope', 'src', '--draft'],
    ['approve', 'T2'],
    ['claim', 'T1', '甲'],
    ['--json', 'show', 'T1'],
  ]
  const dirCur = makeBoardDir(t, 't15a-cur')
  const dirOld = makeBoardDir(t, 't15a-old')
  const rc = script.map((args) => runTb(dirCur, args))
  const ro = script.map((args) => runTb(dirOld, args, { tb: headPy }))
  for (let i = 0; i < script.length; i++) {
    assert.equal(norm(rc[i].stdout), norm(ro[i].stdout), `逐字节一致：${script[i].join(' ')}`)
    assert.equal(rc[i].code, ro[i].code, `exit code 一致：${script[i].join(' ')}`)
  }
  // 事件 args 键集逐事件一致（缺省路径事件形状不因 T15 改动）
  const kc = eventsOf(dirCur).map((e) => Object.keys(e.args).sort().join(','))
  const ko = eventsOf(dirOld).map((e) => Object.keys(e.args).sort().join(','))
  assert.deepEqual(kc, ko)
})

test('T15-b 前置全过直达 ready：单事件 type=create args 含 auto_ready=true+open_count 免审证据；checkpoint 注记可审计；claim/done 全链 E2E', (t) => {
  const dir = makeBoardDir(t, 't15-ready')
  const py = (args, opts) => runTb(dir, args, opts)
  py(['create', '父任务', '--owner', '甲', '--scope', 'src'])
  py(['claim', 'T1', '甲'])
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  const r = py(['create', '免审任务', '--created-by', '甲', '--of', 'T1', '--scope', 'src', '--auto-ready'])
  assert.equal(r.code, 0)
  const t2 = py(['--json', 'show', 'T2']).json.data.task
  assert.equal(t2.status, 'ready', '⑥⑦⑧ 全过直达 ready（跳过 draft 待批面）')
  assert.equal(t2.created_by, '甲')
  assert.equal(boardOf(dir).revision, rev + 1, '单事件单写：revision 恰 +1')
  assert.equal(eventsOf(dir).length, evN + 1, '事件零新增 type：仍单条 create')
  const evt = eventsOf(dir).at(-1)
  assert.equal(evt.type, 'create')
  assert.equal(evt.args.auto_ready, true)
  assert.equal(evt.args.open_count, 1, '免审证据：判定时 created_by 名下 open 计数（T1 running）')
  assert.match(t2.checkpoints.at(-1).note, /免审批创建（--auto-ready）/)
  assert.match(t2.checkpoints.at(-1).note, /open_count=1（创建后 2 ≤ cap=2）/)
  assert.match(t2.checkpoints.at(-1).note, /父 T1 状态 running/)
  // E2E：CAS claim → progress → done（既有链零改动，免审任务与常规任务同生命周期）
  const c = py(['claim', 'T2', '乙', '--expected-revision', String(boardOf(dir).revision)])
  assert.equal(c.code, 0, 'CAS claim 走通')
  assert.equal(py(['--json', 'show', 'T2']).json.data.task.status, 'running')
  py(['progress', 'T2', '推进'])
  py(['done', 'T2', '收口'])
  assert.equal(py(['--json', 'show', 'T2']).json.data.task.status, 'done')
})

test('T15-c 前置任一不过具名拒零写零事件：⑥ agent_create_open_cap（cap 恒生效，仅设阈值 env 不设执法开关）/ ⑦ agent_create_parent_closed / ⑧ agent_create_dep_cross_owner；hint 均指路 draft 回退且回退路径可用', (t) => {
  // ⑥：cap=1（仅 DSH_EXPERT_PEER_OPEN_CAP=1，无 DSH_EXPERT_ANTISTORM_ENFORCE——Q3 恒生效实证）
  const dir = makeBoardDir(t, 't15-cap')
  const py = (args, extraEnv = {}) => runTb(dir, args, { extraEnv })
  py(['create', '父任务', '--owner', '甲', '--scope', 'src'])
  py(['claim', 'T1', '甲'])
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  let r = py(['--json', 'create', '超限', '--created-by', '甲', '--of', 'T1', '--scope', 'src', '--auto-ready'],
    { DSH_EXPERT_PEER_OPEN_CAP: '1' })
  assert.equal(r.json.error, 'agent_create_open_cap')
  assert.equal(r.json.open_count, 1)
  assert.equal(r.json.cap, 1)
  assert.match(r.json.hint, /去掉 --auto-ready/)
  assert.equal(boardOf(dir).revision, rev, '零写')
  assert.equal(eventsOf(dir).length, evN, '零事件')
  // ⑦：父任务终态（done）→ 免审链不可挂靠
  const dir2 = makeBoardDir(t, 't15-closed')
  const py2 = (args) => runTb(dir2, args)
  py2(['create', '父任务', '--owner', '甲', '--scope', 'src'])
  py2(['claim', 'T1', '甲'])
  py2(['done', 'T1', '收口'])
  const rev2 = boardOf(dir2).revision
  const evN2 = eventsOf(dir2).length
  r = py2(['--json', 'create', '挂终态', '--created-by', '甲', '--of', 'T1', '--scope', 'src', '--auto-ready'])
  assert.equal(r.json.error, 'agent_create_parent_closed')
  assert.equal(r.json.parent_status, 'done')
  assert.match(r.json.hint, /去掉 --auto-ready/)
  assert.equal(boardOf(dir2).revision, rev2)
  assert.equal(eventsOf(dir2).length, evN2)
  // ⑧：dep 跨 owner（T2 他人 pending）→ 具名拒；同参去掉 --auto-ready 加 --draft 回退成功
  const dir3 = makeBoardDir(t, 't15-cross')
  const py3 = (args) => runTb(dir3, args)
  py3(['create', '父任务', '--owner', '甲', '--scope', 'src'])
  py3(['claim', 'T1', '甲'])
  py3(['create', '他人任务', '--owner', '乙'])
  const rev3 = boardOf(dir3).revision
  const evN3 = eventsOf(dir3).length
  r = py3(['--json', 'create', '跨依赖', '--created-by', '甲', '--of', 'T1', '--scope', 'src',
           '--dep', 'T2', '--auto-ready'])
  assert.equal(r.json.error, 'agent_create_dep_cross_owner')
  assert.deepEqual(r.json.dep, ['T2'])
  assert.match(r.json.hint, /去掉 --auto-ready/)
  assert.equal(boardOf(dir3).revision, rev3)
  assert.equal(eventsOf(dir3).length, evN3)
  const fb = py3(['create', '回draft', '--created-by', '甲', '--of', 'T1', '--scope', 'src',
                  '--dep', 'T2', '--draft'])
  assert.equal(fb.code, 0, 'hint 指路的 draft 回退路径可用')
  assert.equal(py3(['--json', 'show', 'T3']).json.data.task.status, 'draft')
})

test('T15-d --kind review+--auto-ready 同传仍 agent_create_kind_rejected（review 永不免审）；误用面：--auto-ready 缺代理身份 / 与 --draft 同传 → 误用拒绝', (t) => {
  const dir = makeBoardDir(t, 't15-review')
  const py = (args) => runTb(dir, args)
  py(['create', '父任务', '--owner', '甲', '--scope', 'src'])
  py(['claim', 'T1', '甲'])
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  let r = py(['--json', 'create', '评审', '--created-by', '甲', '--of', 'T1', '--scope', 'src',
              '--kind', 'review', '--auto-ready'])
  assert.equal(r.json.error, 'agent_create_kind_rejected', 'review 永不免审（①-⑤ 链 ④ 先于免审前置）')
  r = py(['--json', 'create', 'lead误用', '--auto-ready'])
  assert.equal(r.json.error, 'command_failed')
  assert.match(r.json.message, /--auto-ready 仅支持代理自建路径/)
  r = py(['--json', 'create', '互斥', '--created-by', '甲', '--of', 'T1', '--scope', 'src',
          '--draft', '--auto-ready'])
  assert.equal(r.json.error, 'command_failed')
  assert.match(r.json.message, /互斥/)
  assert.equal(boardOf(dir).revision, rev, '三条拒绝路径零写')
  assert.equal(eventsOf(dir).length, evN, '三条拒绝路径零事件')
})

// ── T22 repair：免审前置⑧加严为 dep 全部本人名下且全部 done（ready 蕴含依赖已满足不变量）──
test('T15-e（T22）dep 未 done 具名拒 agent_create_dep_open（零写零事件，不静默降级 draft）+ dep 全 done 后重试直达 ready 成功', (t) => {
  const dir = makeBoardDir(t, 't22-dep-open')
  const py = (args, extraEnv = {}) => runTb(dir, args, { extraEnv })
  py(['create', '父任务', '--owner', '甲', '--scope', 'src'])
  py(['claim', 'T1', '甲'])
  py(['create', '依赖任务', '--owner', '甲'])              // T2 pending（本人名下，未 done）
  py(['create', '依赖任务2', '--owner', '甲'])             // T3：走完整生命周期到 done
  py(['claim', 'T3', '甲'])
  py(['done', 'T3', '收口'])
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  // 例一：dep 含未 done（T2 pending）→ 具名拒 agent_create_dep_open，仅具名 open 的依赖；
  // cap 阈值覆盖为 99 使 ⑥ 不先触发（⑥ 先于 ⑧ 的次序既有语义不变）
  let r = py(['--json', 'create', '免审任务', '--created-by', '甲', '--of', 'T1', '--scope', 'src',
              '--dep', 'T2,T3', '--auto-ready'], { DSH_EXPERT_PEER_OPEN_CAP: '99' })
  assert.equal(r.json.error, 'agent_create_dep_open')
  assert.deepEqual(r.json.dep, ['T2'], '仅具名未 done 的依赖')
  assert.deepEqual(r.json.dep_status, { T2: 'ready' }, '无依赖 pending 创建即被 refresh 提升为 ready（open 但未 done 仍拒）')
  assert.match(r.json.hint, /去掉 --auto-ready/)
  assert.equal(boardOf(dir).revision, rev, '拒绝路径零写')
  assert.equal(eventsOf(dir).length, evN, '拒绝路径零事件')
  const missing = py(['--json', 'show', 'T4'])
  assert.equal(missing.json.error, 'command_failed', '不静默降级：任务未创建')
  assert.match(missing.json.message, /任务 T4 不存在/)
  // 例二：dep 全 done 后重试 → 成功直达 ready（免审证据注记如实声明加严后口径）
  py(['claim', 'T2', '甲'])
  py(['done', 'T2', '收口'])
  r = py(['--json', 'create', '免审重试', '--created-by', '甲', '--of', 'T1', '--scope', 'src',
          '--dep', 'T2,T3', '--auto-ready'])
  assert.equal(r.json.ok, true, 'dep 全 done 后重试成功')
  const t4 = py(['--json', 'show', 'T4']).json.data.task
  assert.equal(t4.status, 'ready', '⑧ 加严后前置全过仍直达 ready')
  assert.deepEqual(t4.dep, ['T2', 'T3'])
  assert.match(t4.checkpoints.at(-1).note, /dep 全部本人名下且已 done（T2 T3）/)
})
