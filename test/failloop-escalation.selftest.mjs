// 方向 3 连续失败循环升级自测（dev/orchestration-economics-345，node:test，零依赖）。
// 覆盖面：
// - taskboard.py fail-loop 升级（opt-in 执法）：a) 执法关闭与改动前基线（HEAD=c2ddb31，
//   fail-loop 改动未入）同输入逐字节一致（stdout+exit+任务 JSON 无 fail_streak 键）；
//   b) 执法开启：fail_streak 跨 retry 累计、达限 fail 自动转 escalated（事件 args 携
//   auto_escalated/fail_streak）、唯一出口=用户 retry（重置计数）；c) done 成功清零；
//   d) DSH_EXPERT_FAILLOOP_LIMIT 覆盖与非法值 fail-open（执法禁用+stderr 告警）；
// - lib/fail-loop.js 召唤失败循环告警：检测器语义（累计/达阈告警/成功清零/阈值 env）+
//   summon_expert 真链路（连续 3 次召唤失败第 3 次错误尾部附【升级｜连续失败｜告警】信封行、成功重置、
//   DSH_EXPERT_SUMMON_FAILLOOP='0' 关闭零变化）。
// R1 口径如实声明：fail_streak 为板面事件溯源计数（防误用非防伪造），升级=状态机迁移
// 非消息送达——用户处置仍以任务板 status 盘点为入口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { createSummonFailLoopDetector, summonFailLoopEnabled, summonFailLoopThreshold } from '../lib/fail-loop.js'
import { registerExpertTools } from '../lib/tools.js'
import { msg } from '../lib/messages.js'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'
const ENFORCE = 'DSH_EXPERT_FAILLOOP_ENFORCE'
const LIMIT = 'DSH_EXPERT_FAILLOOP_LIMIT'

const runTb = (cwd, args, { tb = TASKBOARD, extraEnv = {}, omitEnv = [] } = {}) => {
  const env = { ...process.env }
  for (const k of omitEnv) delete env[k]
  Object.assign(env, extraEnv)
  const r = spawnSync('python3', [tb, ...args], { cwd, encoding: 'utf-8', env })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `d3-failloop-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const taskOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8')).tasks.T1
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l))

/** 场景驱动：建任务+claim 后按脚本执行 fail/retry 序列（fail 需 running 态）。 */
const drive = (dir, tb, steps, env = {}) => {
  runTb(dir, ['create', '任务A', '--owner', '甲'], { tb })
  const py = (args) => runTb(dir, args, { tb, extraEnv: env })
  py(['claim', 'T1', '甲'])
  for (const s of steps) py(s)
  return py
}

// ── a) 执法关闭：与改动前基线逐字段一致 ──────────────────────────────────────
test('方向3-a 执法关闭：fail/retry 序列与基线 c2ddb31 行为一致（终态字段+检查点全文+无 fail_streak 键）', (t) => {
  const head = spawnSync('git', ['show', 'c2ddb31:skills/expert-orchestration/tools/taskboard.py'], { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, 'git show c2ddb31 基线可读（fail-loop 改动前的 taskboard.py）')
  const headPy = join(mkdtempSync(join(tmpdir(), 'd3-base-')), 'taskboard_base.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const OPTS = { omitEnv: [ENFORCE, LIMIT] }
  const steps = [
    ['fail', 'T1', '失败一'], ['retry', 'T1'],
    ['claim', 'T1', '甲'], ['fail', 'T1', '失败二'], ['retry', 'T1'],
    ['claim', 'T1', '甲'], ['fail', 'T1', '失败三'],
  ]
  const dirA = makeBoardDir(t, 'base')
  const dirB = makeBoardDir(t, 'work')
  drive(dirA, headPy, steps, {})
  drive(dirB, TASKBOARD, steps, {})
  // 时间戳（created/updated/checkpoints[].time）随跑随变，逐字节比对只在稳定面：
  // 终态字段集合、status/fail/checkpoints 注记全文、事件类型与 args 序列。
  const stable = (t0) => ({
    keys: Object.keys(t0).sort(),
    status: t0.status, fail: t0.fail, owner: t0.owner,
    notes: (t0.checkpoints ?? []).map((c) => c.note),
  })
  const a = taskOf(dirA)
  const b = taskOf(dirB)
  assert.deepEqual(stable(b), stable(a), '终态稳定面逐字段一致')
  assert.equal('fail_streak' in b, false, '执法关闭不落 fail_streak 字段')
  const evA = eventsOf(dirA).map((e) => [e.type, JSON.stringify(e.args)])
  const evB = eventsOf(dirB).map((e) => [e.type, JSON.stringify(e.args)])
  assert.deepEqual(evB, evA, '事件类型与 args 序列逐字节一致')
})

// ── b) 执法开启：累计/达限升级/唯一出口 ──────────────────────────────────────
test('方向3-b 执法开启：streak 跨 retry 累计，第 3 次 fail 自动 escalated（事件 args 留痕），用户 retry 重置', (t) => {
  const dir = makeBoardDir(t, 'enforce')
  const py = drive(dir, TASKBOARD, [
    ['fail', 'T1', '失败一'], ['retry', 'T1'],           // streak=1 → failed → ready（failed 重试不清零）
    ['claim', 'T1', '甲'], ['fail', 'T1', '失败二'], ['retry', 'T1'], // streak=2
  ], { [ENFORCE]: '1' })
  const t1 = taskOf(dir)
  assert.equal(t1.status, 'ready', '未达限：failed→retry→ready')
  assert.equal(t1.fail_streak, 2, '跨 retry 累计（failed 重试不清零=循环检测关键）')
  // 第 3 次 fail → 自动 escalated
  py(['claim', 'T1', '甲'])
  const r3 = py(['fail', 'T1', '失败三'])
  assert.equal(r3.code, 0)
  assert.equal(taskOf(dir).status, 'escalated', '第 3 次 fail 自动转 escalated')
  assert.equal(taskOf(dir).fail_streak, 3)
  assert.ok(r3.stdout.includes('【升级｜连续失败｜升级】') && r3.stdout.includes('唯一出口') && r3.stdout.includes('升级报告三要素'), r3.stdout)
  const failEvents = eventsOf(dir).filter((e) => e.type === 'fail')
  const last = failEvents[failEvents.length - 1]
  assert.equal(last.args.auto_escalated, true, '事件 args 携 auto_escalated 留痕')
  assert.equal(last.args.fail_streak, 3)
  // escalated 后 progress 被拒（终态语义复用）
  const pr = py(['progress', 'T1', '应被拒'])
  assert.notEqual(pr.code, 0, 'escalated 任务不可 progress')
  // 用户 retry = 唯一出口：ready + 计数重置（字段移除）
  const rr = py(['retry', 'T1'])
  assert.equal(rr.code, 0)
  const t2 = taskOf(dir)
  assert.equal(t2.status, 'ready')
  assert.equal('fail_streak' in t2, false, '用户 retry 重置 fail_streak（显式重给一轮预算）')
  assert.ok(t2.checkpoints.some((c) => c.note.includes('fail-loop 连续失败计数已重置（原 3）')))
})

// ── c) done 成功清零 ─────────────────────────────────────────────────────────
test('方向3-c done 成功清零 streak：成功完成后新一轮失败从 0 起算', (t) => {
  const dir = makeBoardDir(t, 'done-reset')
  const env = { [ENFORCE]: '1' }
  runTb(dir, ['create', '任务A', '--owner', '甲'], { extraEnv: env })
  const py = (args) => runTb(dir, args, { extraEnv: env })
  py(['claim', 'T1', '甲'])
  py(['fail', 'T1', '失败一'])
  py(['retry', 'T1'])
  py(['claim', 'T1', '甲'])
  py(['done', 'T1', '终于完成'])
  assert.equal(taskOf(dir).status, 'done')
  assert.equal('fail_streak' in taskOf(dir), false, 'done 清零（字段移除）')
  // 终态任务不可再 claim——开新任务验证清零后的预算从 0 起
  py(['create', '任务B', '--owner', '乙'])
  py(['claim', 'T2', '乙'])
  py(['fail', 'T2', '新任务失败一'])
  py(['retry', 'T2'])
  py(['claim', 'T2', '乙'])
  py(['fail', 'T2', '新任务失败二'])
  assert.equal(JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8')).tasks.T2.status, 'failed', '两次失败未升级（预算从 0 起算）')
  assert.equal(JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8')).tasks.T2.fail_streak, 2)
})

// ── d) 限额覆盖与非法值 fail-open ────────────────────────────────────────────
test('方向3-d DSH_EXPERT_FAILLOOP_LIMIT：覆盖生效（=2 时第 2 次 fail 升级）、非法值 fail-open 禁用+stderr 告警', (t) => {
  const dir = makeBoardDir(t, 'limit2')
  const py = drive(dir, TASKBOARD, [
    ['fail', 'T1', '失败一'], ['retry', 'T1'],
    ['claim', 'T1', '甲'], ['fail', 'T1', '失败二'],
  ], { [ENFORCE]: '1', [LIMIT]: '2' })
  assert.equal(taskOf(dir).status, 'escalated', '限额 2：第 2 次 fail 即升级')
  // 非法值：执法禁用（不升级、不落 streak）+ stderr 告警（沿 budget_thresholds 先例）
  const dir2 = makeBoardDir(t, 'badlimit')
  runTb(dir2, ['create', '任务A', '--owner', '甲'], { extraEnv: { [ENFORCE]: '1', [LIMIT]: 'abc' } })
  const env2 = { [ENFORCE]: '1', [LIMIT]: 'abc' }
  const py2 = (args) => runTb(dir2, args, { extraEnv: env2 })
  py2(['claim', 'T1', '甲'])
  py2(['fail', 'T1', '失败一'])
  py2(['retry', 'T1'])
  py2(['claim', 'T1', '甲'])
  const last = py2(['fail', 'T1', '失败二'])
  assert.equal(taskOf(dir2).status, 'failed', '非法限额=执法禁用（不升级）')
  assert.equal('fail_streak' in taskOf(dir2), false, '执法禁用不落 streak 字段')
  assert.ok(last.stderr.includes('DSH_EXPERT_FAILLOOP_LIMIT 非法'), last.stderr)
})

// ── lib/fail-loop.js 检测器 ──────────────────────────────────────────────────

test('方向3-lib 检测器：累计达阈告警、每次达阈失败都告警、成功清零、阈值 env 解析', () => {
  assert.equal(summonFailLoopThreshold({}), 3, '缺省 3')
  assert.equal(summonFailLoopThreshold({ DSH_EXPERT_SUMMON_FAILLOOP_N: '5' }), 5)
  assert.equal(summonFailLoopThreshold({ DSH_EXPERT_SUMMON_FAILLOOP_N: '1' }), 3, '<2 回默认')
  assert.equal(summonFailLoopThreshold({ DSH_EXPERT_SUMMON_FAILLOOP_N: 'x' }), 3, '非法回默认')
  assert.equal(summonFailLoopEnabled({}), true)
  assert.equal(summonFailLoopEnabled({ DSH_EXPERT_SUMMON_FAILLOOP: '0' }), false)
  assert.equal(summonFailLoopEnabled({ DSH_EXPERT_SUMMON_FAILLOOP: '' }), false)

  const d = createSummonFailLoopDetector({ threshold: 3 })
  assert.equal(d.recordFailure('甲'), null, '第 1 次：静默累计')
  assert.equal(d.recordFailure('甲'), null, '第 2 次：静默累计')
  const w3 = d.recordFailure('甲')
  assert.ok(w3 && w3.includes('【升级｜连续失败｜告警】') && w3.includes('甲') && w3.includes('不阻断'), w3)
  assert.ok(d.recordFailure('甲'), '第 4 次仍告警（每次失败都是新事件）')
  d.recordSuccess('甲')
  assert.equal(d.recordFailure('甲'), null, '成功清零后重新累计')
  const d2 = createSummonFailLoopDetector({ threshold: 2 })
  assert.equal(d2.recordFailure('乙'), null)
  assert.ok(d2.recordFailure('乙').includes('2 次'), '阈值 2 生效')
})

// ── 升级信封形状契约（方向 3 收口 #4）────────────────────────────────────────

test('方向3-信封形状契约：四通道提示级键统一【升级｜通道｜级别】现状：…建议：…+不阻断尾行', () => {
  // 提示级通道（尾行恒「本提示不阻断。」）；执行级（fail-loop 工具升级行，taskboard.py
  // print）不带尾行，由方向3-b 用例断言 stdout。
  const ENVELOPE_KEYS = [
    ['oscillation.warning', { a: 'A', b: 'B', roundTrips: 3, threshold: 3, run: 7 }, '振荡', '告警'],
    ['failloop.summon', { name: '甲', count: 3, threshold: 3 }, '连续失败', '告警'],
    ['budget.alarm', { who: '甲', count: 11, threshold: 10 }, '预算', '告警档'],
    ['budget.wrapup', { who: '甲', count: 24, threshold: 24 }, '预算', '收尾档'],
    ['budget.interrupt', { who: '甲', count: 31, threshold: 30 }, '预算', '中断档'],
    ['cost.budgetExceeded', { used: '5K', budget: '3K' }, '成本', '熔断'],
  ]
  for (const [key, params, channel, level] of ENVELOPE_KEYS) {
    for (const lang of ['zh', 'en']) {
      const line = msg(key, lang, params)
      assert.ok(line.startsWith(`【升级｜${channel}｜${level}】`), `${key}/${lang} tag 形状：${line}`)
      assert.ok(line.includes('现状：'), `${key}/${lang} 现状槽位在列：${line}`)
      assert.ok(line.includes('建议：'), `${key}/${lang} 建议槽位在列：${line}`)
      assert.ok(line.endsWith('本提示不阻断。'), `${key}/${lang} 提示级尾行：${line}`)
    }
  }
  // 非升级行不进信封（契约违规提示与遥测行维持既有形态）
  assert.ok(msg('budget.contractViolation', 'zh', { id: 'T1', hint: 'h' }).startsWith('【预算】'))
  assert.ok(msg('cost.batchSummary', 'zh', { summons: 1, ok: 1, fail: 0, sum: '5K', budget: '10 tok' }).startsWith('【成本】'))
})

test('方向3-lib summon 真链路：同一专家连续 3 次召唤失败第 3 次附【升级｜连续失败｜告警】信封行，成功重置，开关关闭零变化', async (t) => {
  const saved = process.env.DSH_EXPERT_SUMMON_FAILLOOP
  delete process.env.DSH_EXPERT_SUMMON_FAILLOOP
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_EXPERT_SUMMON_FAILLOOP
    else process.env.DSH_EXPERT_SUMMON_FAILLOOP = saved
  })
  const root = mkdtempSync(join(tmpdir(), 'd3-summon-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dst = join(root, 'dst')
  mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({
    core: [{ source: 'bundled-core', file: 'a.md', name: '甲' }, { source: 'bundled-core', file: 'b.md', name: '乙' }],
  }))
  const descriptors = []
  const ctx = {
    tools: { register: (d) => descriptors.push(d) },
    subagents: {
      getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
      start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }),
    },
  }
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: root })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  // 「不存在」触发解析失败（召唤失败，不消耗 run）；前两次静默，第三次附告警
  const failOnce = async (expert = '不存在专家') => {
    try {
      await summon.execute({ expert, task: '任务' }, { agent: {} })
      return null
    } catch (error) {
      return String(error.message)
    }
  }
  const e1 = await failOnce()
  const e2 = await failOnce()
  const e3 = await failOnce()
  assert.ok(!e1.includes('【升级｜连续失败｜告警】') && !e2.includes('【升级｜连续失败｜告警】'), '前两次静默')
  assert.ok(e3.includes('【升级｜连续失败｜告警】') && e3.includes('不存在专家'), `第三次达阈附告警：${e3}`)
  const e4 = await failOnce()
  assert.ok(e4.includes('【升级｜连续失败｜告警】'), '达阈后每次失败都告警（每次都是新事件）')
  // 成功召唤甲 → 清零的是甲的 streak；不存在专家无成功，streak 保持达阈（继续告警）
  await summon.execute({ expert: '甲', task: '正常任务' }, { agent: {} })
  const f1 = await failOnce()
  assert.ok(f1.includes('【升级｜连续失败｜告警】'), '未成功过的专家 streak 不被他人成功清零')
  // 甲自身循环：空任务=召唤失败（task 必填，解析后失败）×3 → 告警；成功一次 → 清零；再失败从 0 起算
  const failA = async () => {
    try {
      await summon.execute({ expert: '甲', task: '' }, { agent: {} })
      return null
    } catch (error) {
      return String(error.message)
    }
  }
  const a1 = await failA()
  const a2 = await failA()
  const a3 = await failA()
  assert.ok(!a1.includes('【升级｜连续失败｜告警】') && !a2.includes('【升级｜连续失败｜告警】'), '甲：前两次静默')
  assert.ok(a3.includes('【升级｜连续失败｜告警】') && a3.includes('甲'), '甲：第三次达阈告警')
  await summon.execute({ expert: '甲', task: '正常任务' }, { agent: {} })
  const a4 = await failA()
  assert.ok(!a4.includes('【升级｜连续失败｜告警】'), '甲成功重置后再失败从 0 起算（首次静默）')
  // 开关关闭（沿振荡告警先例：enabled 在 register 时读取——须全新注册实例验证零变化）
  process.env.DSH_EXPERT_SUMMON_FAILLOOP = '0'
  const descriptors2 = []
  const ctx2 = {
    tools: { register: (d) => descriptors2.push(d) },
    subagents: ctx.subagents,
  }
  registerExpertTools(ctx2, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: root })
  const summon2 = descriptors2.find((d) => d.name === 'summon_expert')
  for (let i = 0; i < 4; i++) {
    try {
      await summon2.execute({ expert: '不存在专家', task: '任务' }, { agent: {} })
      assert.fail('应当失败')
    } catch (error) {
      assert.ok(!String(error.message).includes('【升级｜连续失败｜告警】'), `关闭态第 ${i + 1} 次失败零告警`)
    }
  }
})
