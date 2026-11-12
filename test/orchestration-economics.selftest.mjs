// 编排经济学 · 方向 2 自测（v2.14 开发线，docs/internal/direction2-orchestration-economics.md）
//
// 覆盖面：
// - lib/cost.js：estimateTokens / formatTokenScale / createCostLedger / tokenBudgetTokens /
//   costBudgetHint（估算口径、封顶、fail-open、提示行零变化纪律）
// - lib/expert-profiles.js 三档偏好路由：resolveRoutePref / parseExpertDefaults.modelByPref /
//   validateExpertProfileDocument 写侧严格 / resolveExpertModel pref 生效层与优先级
// - lib/tools.js 接线：summon_expert 成本提示行（opt-in，未开启零变化）/ summon_experts
//   stagger 预热派发序 / render【分流建议】与成本累计行（返回值结构不变）
// - lib/messages.js：新增 key 双语完整性
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { estimateTokens, formatTokenScale, createCostLedger, tokenBudgetTokens, costBudgetHint } from '../lib/cost.js'
import { parseExpertDefaults, validateExpertProfileDocument, resolveExpertModel, resolveRoutePref, ROUTE_PREFS } from '../lib/expert-profiles.js'
import { registerExpertTools } from '../lib/tools.js'
import { messageKeys, msg } from '../lib/messages.js'

const noopWarn = () => {}

/** 全部本文件涉及的 env 守卫：防部署环境注入干扰断言（沿 guardProfilesEnv 惯例）。 */
const guardEconEnv = (t, keys = ['DSH_EXPERT_TOKEN_BUDGET', 'DSH_EXPERT_ROUTE_PREF', 'DSH_EXPERT_PROFILES']) => {
  const saved = {}
  for (const k of keys) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

/** summon 捕获夹具（沿 tools.selftest makeProfileSummonCtx 同形）：mock 宿主捕获
 *  每次 start 的完整 spec；delayMs 可为逐项延迟（stagger 派发序断言用）。 */
const makeSummonCtx = ({ capabilities = {}, delayMs = null, log = null } = {}) => {
  const descriptors = []
  const specs = []
  const completed = []
  const tools = { register: (d) => descriptors.push(d) }
  return {
    descriptors,
    specs,
    completed,
    ctx: {
      tools,
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true, ...capabilities } }),
        start: async (_provider, opts) => {
          specs.push(opts)
          const index = specs.length - 1
          const delay = Array.isArray(delayMs) ? (delayMs[index] ?? 0) : (delayMs ?? 0)
          if (delay > 0) await new Promise((r) => setTimeout(r, delay))
          const result = { stopReason: 'completed', output: [{ type: 'text', text: `ok${index}` }] }
          if (log) log.push(`done${index}`)
          completed.push(index)
          return { result: Promise.resolve(result), dispose: async () => {} }
        },
      },
    },
  }
}

/** 最小花名册夹具（沿 tools.selftest makeProfileFixture 同形，单专家+可选多专家）。 */
const makeRosterFixture = (t, label, names = ['测试专家']) => {
  const root = mkdtempSync(join(tmpdir(), `econ-${label}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dst = join(root, 'dst')
  mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({
    core: names.map((n, i) => ({ source: 'bundled-core', file: `e${i}.md`, name: n })),
  }))
  const homePath = join(root, 'home', 'expert-profiles.json')
  const projectPath = join(root, 'ws', '.dsh', 'expert-profiles.json')
  return { root, dst, homePath, projectPath }
}

// ── lib/cost.js 纯函数 ────────────────────────────────────────────────────────

test('方向2 estimateTokens：ASCII/CJK/混合/空串口径', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens('abcdefgh'), 2) // 8×0.25=2
  assert.equal(estimateTokens('四个汉字'), 3) // 4×0.75=3
  assert.equal(estimateTokens('abc中文'), 3) // 3×0.25+2×0.75=2.25→ceil 3
  assert.ok(estimateTokens('a'.repeat(1000)) > 0)
})

test('方向2 formatTokenScale：K 与 tok 两档', () => {
  assert.equal(formatTokenScale(999), '999 tok')
  assert.equal(formatTokenScale(1000), '1K')
  assert.equal(formatTokenScale(123456), '123.5K')
  assert.equal(formatTokenScale(0), '0 tok')
})

test('方向2 createCostLedger：记录/累计/封顶丢最旧', () => {
  const ledger = createCostLedger({ maxEntries: 3 })
  for (let i = 0; i < 5; i++) ledger.record({ expert: `e${i}`, model: 'm', ok: i % 2 === 0, taskText: '汉字'.repeat(10), answerText: 'ok' })
  const t = ledger.totals()
  assert.equal(t.summons, 3, '封顶 500→3：只保留最近 3 条')
  assert.equal(t.okCount, 2)
  assert.equal(t.failCount, 1)
  assert.ok(t.estTokens > 0)
})

test('方向2 tokenBudgetTokens：关闭/合法/非法 fail-open', () => {
  const warn = []
  assert.equal(tokenBudgetTokens({}, noopWarn), null, '未设置=关闭')
  assert.equal(tokenBudgetTokens({ DSH_EXPERT_TOKEN_BUDGET: '' }, noopWarn), null)
  assert.equal(tokenBudgetTokens({ DSH_EXPERT_TOKEN_BUDGET: '0' }, noopWarn), null)
  assert.equal(tokenBudgetTokens({ DSH_EXPERT_TOKEN_BUDGET: '500' }, noopWarn), 500000)
  assert.equal(tokenBudgetTokens({ DSH_EXPERT_TOKEN_BUDGET: '0.5' }, noopWarn), 500)
  assert.equal(tokenBudgetTokens({ DSH_EXPERT_TOKEN_BUDGET: 'abc' }, (m) => warn.push(m)), null, '非法=禁用+告警')
  assert.equal(warn.length, 1)
})

test('方向2 costBudgetHint：未达阈值零变化、达阈值出提示、双语', () => {
  const totals = { summons: 2, okCount: 2, failCount: 0, estTokens: 5000 }
  assert.equal(costBudgetHint(totals, 10000, 'zh'), '', '未达阈值=空串（零变化）')
  assert.equal(costBudgetHint(totals, null, 'zh'), '', '未开启=空串')
  const zh = costBudgetHint(totals, 3000, 'zh')
  assert.ok(zh.startsWith('【升级｜成本｜熔断】'), zh)
  assert.ok(zh.includes('5K') && zh.includes('3K'), zh)
  assert.ok(zh.includes('不阻断'), zh)
  const en = costBudgetHint(totals, 3000, 'en')
  assert.ok(en.startsWith('[ESCALATION|cost|circuit-break]') && en.includes('This notice does not block'), en)
})

// ── 三档偏好路由（expert-profiles）───────────────────────────────────────────

test('方向2 resolveRoutePref：合法/非法/未设置', () => {
  const warn = []
  assert.equal(resolveRoutePref({}, noopWarn), null)
  assert.equal(resolveRoutePref({ DSH_EXPERT_ROUTE_PREF: '' }, noopWarn), null)
  assert.equal(resolveRoutePref({ DSH_EXPERT_ROUTE_PREF: ' COST ' }, noopWarn), 'cost', '大小写与空白容忍')
  assert.equal(resolveRoutePref({ DSH_EXPERT_ROUTE_PREF: 'fast' }, (m) => warn.push(m)), null, '非法档位=null+告警')
  assert.equal(warn.length, 1)
  assert.deepEqual([...ROUTE_PREFS], ['quality', 'balanced', 'cost'])
})

test('方向2 parseExpertDefaults：modelByPref 合法/非法值/未知档位', () => {
  const warn = []
  const d = parseExpertDefaults({ model: 'd1', modelByPref: { quality: 'q1', cost: 'c1', balanced: '  ', weird: 'x' } }, (m) => warn.push(m))
  assert.deepEqual(d, { model: 'd1', modelByPref: { quality: 'q1', cost: 'c1' } }, '空值与未知档位丢弃')
  assert.equal(warn.length, 2)
  assert.equal(parseExpertDefaults({ modelByPref: 'quality' }, noopWarn), null, '整体形状非法=null')
})

test('方向2 validateExpertProfileDocument：modelByPref 合法落盘、非法整体拒绝（写侧严格）', () => {
  const ok = validateExpertProfileDocument({ experts: {}, defaults: { model: 'd1', modelByPref: { cost: 'c1' } } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.doc.defaults, { model: 'd1', modelByPref: { cost: 'c1' } })
  const bad1 = validateExpertProfileDocument({ experts: {}, defaults: { modelByPref: { quality: 42 } } })
  assert.equal(bad1.ok, false, '档位值非法=拒绝（不静默降档）')
  const bad2 = validateExpertProfileDocument({ experts: {}, defaults: { modelByPref: { fast: 'x' } } })
  assert.equal(bad2.ok, false, '全未知档位=拒绝')
  const bad3 = validateExpertProfileDocument({ experts: {}, defaults: { speed: 'x' } })
  assert.equal(bad3.ok, false, '未知 defaults 键仍拒绝')
})

test('方向2 resolveExpertModel pref 优先级：per-expert/组层压过偏好，档值优先于 defaults.model，缺档回落', () => {
  const noop = noopWarn
  // ① per-expert 显式配置压过偏好
  assert.equal(resolveExpertModel({ 甲: { model: 'p1' }, defaults: { modelByPref: { cost: 'c1' } } }, '甲', noop, undefined, { pref: 'cost' }), 'p1')
  // ② 组层显式配置压过偏好
  assert.equal(resolveExpertModel({ groups: { g: { model: 'g1', members: ['甲'] } }, defaults: { modelByPref: { cost: 'c1' } } }, '甲', noop, undefined, { pref: 'cost' }), 'g1')
  // ③ pref 激活 + 档位声明 → 档值优先于 defaults.model
  assert.equal(resolveExpertModel({ defaults: { model: 'd1', modelByPref: { cost: 'c1' } } }, '甲', noop, undefined, { pref: 'cost' }), 'c1')
  // ④ pref 激活 + 档位缺声明 → 回落 defaults.model（与既有行为一致）
  assert.equal(resolveExpertModel({ defaults: { model: 'd1', modelByPref: { quality: 'q1' } } }, '甲', noop, undefined, { pref: 'cost' }), 'd1')
  // ⑤ 无 pref / 无 opts → 逐字节既有行为
  assert.equal(resolveExpertModel({ defaults: { model: 'd1', modelByPref: { cost: 'c1' } } }, '甲', noop), 'd1')
  assert.equal(resolveExpertModel({ defaults: { model: 'd1', modelByPref: { cost: 'c1' } } }, '甲', noop, undefined, {}), 'd1')
  assert.equal(resolveExpertModel({ defaults: { modelByPref: { cost: 'c1' } } }, '甲', noop, undefined, { pref: 'cost' }), 'c1', '无 defaults.model 时 pref 档值兜底')
})

// ── lib/tools.js 接线（真 summon 链路）────────────────────────────────────────

test('方向2 summon_expert 成本熔断：DSH_EXPERT_TOKEN_BUDGET 开启达阈值附【升级｜成本｜熔断】信封行，关闭零变化', async (t) => {
  guardEconEnv(t)
  const f = makeRosterFixture(t, 'cost-hint')
  const { descriptors, ctx } = makeSummonCtx({ capabilities: { agentOptions: true } })
  registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  // 阈值 10 token：任务书+回包+origin-chain 标记行（ASCII ≈20 tok）合计首召即达阈
  process.env.DSH_EXPERT_TOKEN_BUDGET = '0.01'
  const r1 = await summon.execute({ expert: '测试专家', task: '这是首次召唤的任务书正文' }, { agent: {} })
  assert.ok(r1.answer.includes('【升级｜成本｜熔断】'), `累计达阈应提示：${r1.answer}`)
  assert.ok(r1.answer.includes('不阻断'), r1.answer)
  assert.ok(r1.answer.startsWith('ok0'), '提示行附在 answer 尾部，正文前置不动')
  // 关闭（删除 env）→ 零变化：无升级信封成本行
  delete process.env.DSH_EXPERT_TOKEN_BUDGET
  const r3 = await summon.execute({ expert: '测试专家', task: '关闭开关后的第三次召唤' }, { agent: {} })
  assert.ok(!r3.answer.includes('【升级｜成本'), '开关关闭=提示行零变化')
})

test('方向2 summon_expert 路由偏好：env 激活按档取 model、per-expert 压过偏好、关闭零变化', async (t) => {
  guardEconEnv(t)
  const f = makeRosterFixture(t, 'route-pref', ['测试专家', '显式专家'])
  const { descriptors, specs, ctx } = makeSummonCtx({ capabilities: { agentOptions: true } })
  registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  mkdirSync(dirname(f.projectPath), { recursive: true })
  writeFileSync(f.projectPath, JSON.stringify({
    experts: { 显式专家: { model: 'model-explicit' } },
    defaults: { model: 'model-default', modelByPref: { cost: 'model-cost', quality: 'model-quality' } },
  }))
  // ① pref=cost 且无逐专家配置 → 档值
  process.env.DSH_EXPERT_ROUTE_PREF = 'cost'
  await summon.execute({ expert: '测试专家', task: '任务一' }, { agent: {} })
  assert.equal(specs[0].agentOptions?.model, 'model-cost')
  // ② per-expert 显式配置压过偏好
  await summon.execute({ expert: '显式专家', task: '任务二' }, { agent: {} })
  assert.equal(specs[1].agentOptions?.model, 'model-explicit')
  // ③ 关闭 env → defaults.model（既有行为）
  delete process.env.DSH_EXPERT_ROUTE_PREF
  await summon.execute({ expert: '测试专家', task: '任务三' }, { agent: {} })
  assert.equal(specs[2].agentOptions?.model, 'model-default')
})

test('方向2 summon_experts stagger：首项完成（含 run 收尾）后其余才启动；缺省并发即刻全启动', async (t) => {
  guardEconEnv(t)
  const f = makeRosterFixture(t, 'stagger', ['甲', '乙', '丙'])
  // item0 慢（60ms），item1/2 快（5ms）——非 stagger 时 1/2 必在 0 完成前启动；
  // stagger 时 1/2 必在 0 完成后才启动。
  const run = async (stagger) => {
    const log = []
    const { descriptors, ctx } = makeSummonCtx({ delayMs: [60, 5, 5], log })
    registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
    const batch = descriptors.find((d) => d.name === 'summon_experts')
    const r = await batch.execute({ experts: [{ expert: '甲', task: 'a' }, { expert: '乙', task: 'b' }, { expert: '丙', task: 'c' }], ...(stagger ? { stagger: true } : {}) }, { agent: {} })
    return { r, log }
  }
  const { r: rOff, log: logOff } = await run(false)
  assert.ok(logOff.indexOf('done0') > logOff.indexOf('done1') && logOff.indexOf('done0') > logOff.indexOf('done2'), `缺省并发：慢项未完成时快项已启动 ${JSON.stringify(logOff)}`)
  assert.ok(rOff.results.every((x) => x.ok))
  const { r: rOn, log: logOn } = await run(true)
  assert.ok(logOn.indexOf('done0') < logOn.indexOf('done1') && logOn.indexOf('done0') < logOn.indexOf('done2'), `stagger：首项完成后其余才启动 ${JSON.stringify(logOn)}`)
  assert.ok(rOn.results.map((x) => x.expert).join(',') === '甲,乙,丙', '结果序与声明序一致（stagger 不改变结果对位）')
  assert.ok(rOn.results.every((x) => x.ok), '部分成功语义不变')
})

test('方向2 summon_experts render 分流建议：≥2 写型条目附提示，readOnly/单写型零变化', async (t) => {
  guardEconEnv(t)
  const f = makeRosterFixture(t, 'fanout', ['甲', '乙'])
  const { descriptors, ctx } = makeSummonCtx({})
  registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
  const batch = descriptors.find((d) => d.name === 'summon_experts')
  const renderFn = batch.output?.render ?? batch.render
  const value = { results: [{ expert: '甲', ok: true, answer: 'a' }, { expert: '乙', ok: true, answer: 'b' }] }
  // ① 两个写型条目 → 【分流建议】
  const t1 = renderFn({ experts: [{ expert: '甲', task: 'a' }, { expert: '乙', task: 'b' }] }, value)[0].text
  assert.ok(t1.includes('【分流建议】'), t1)
  assert.ok(t1.includes('不阻断'), t1)
  // ② 全 readOnly → 零变化
  const t2 = renderFn({ experts: [{ expert: '甲', task: 'a', readOnly: true }, { expert: '乙', task: 'b', readOnly: true }] }, value)[0].text
  assert.ok(!t2.includes('【分流建议】'), t2)
  // ③ 单写型条目 → 零变化
  const t3 = renderFn({ experts: [{ expert: '甲', task: 'a' }] }, value)[0].text
  assert.ok(!t3.includes('【分流建议】'), t3)
  // ④ render 纯展示：返回值结构不变（execute 结果无附加键）
  const r = await batch.execute({ experts: [{ expert: '甲', task: 'a', readOnly: true }, { expert: '乙', task: 'b', readOnly: true }] }, { agent: {} })
  assert.deepEqual(Object.keys(r), ['results'])
  assert.ok(r.results.every((x) => x.ok && x.answer.startsWith('ok')))
})

test('方向2 summon_experts render 成本累计行：开启附【成本】会话累计，关闭零变化', async (t) => {
  guardEconEnv(t)
  const f = makeRosterFixture(t, 'cost-render', ['甲'])
  const { descriptors, ctx } = makeSummonCtx({})
  registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
  const batch = descriptors.find((d) => d.name === 'summon_experts')
  const renderFn = batch.output?.render ?? batch.render
  const value = { results: [{ expert: '甲', ok: true, answer: 'a' }] }
  // 关闭：render 与既有逐字节一致（仅召唤结果行）
  const off = renderFn({ experts: [{ expert: '甲', task: 'a' }] }, value)[0].text
  assert.ok(!off.includes('【成本】'), off)
  // 开启：先产生一次召唤记账（execute），render 出会话累计行（数字断言：次数/成败/估算下界/预算额；
  // env 单位=千 token，'0.01' → 10 tokens → formatTokenScale='10 tok'）
  process.env.DSH_EXPERT_TOKEN_BUDGET = '0.01'
  await batch.execute({ experts: [{ expert: '甲', task: '记账任务' }] }, { agent: {} })
  const on = renderFn({ experts: [{ expert: '甲', task: 'a' }] }, value)[0].text
  assert.ok(on.includes('【成本】'), on)
  assert.ok(on.includes('会话累计：1 次召唤（成功 1/失败 0）'), `次数与成败断言：${on}`)
  const m = on.match(/估算输入 ~([0-9.]+)(K| tok)/)
  assert.ok(m, `估算数字在列：${on}`)
  const sumTokens = m[2] === 'K' ? Number(m[1]) * 1000 : Number(m[1])
  const floor = estimateTokens('记账任务') + estimateTokens('ok0')
  assert.ok(sumTokens >= floor, `估算 ≥ 任务书+回包下界（${sumTokens} ≥ ${floor}，origin-chain 标记行只增不减）：${on}`)
  assert.ok(on.includes('预算 10 tok'), `预算额断言（DSH_EXPERT_TOKEN_BUDGET='0.01' → 10 tokens）：${on}`)
})

// ── messages 双语完整性 ──────────────────────────────────────────────────────

test('方向2 messages：新增 key 双语可渲染且全量 key 收口', () => {
  for (const k of ['cost.budgetExceeded', 'cost.batchSummary', 'econ.writeFanoutAdvisory']) {
    assert.ok(messageKeys().includes(k), `缺 key：${k}`)
    const zh = msg(k, 'zh', { used: '5K', budget: '3K', summons: 2, ok: 1, fail: 1, sum: '5K', count: 2 })
    const en = msg(k, 'en', { used: '5K', budget: '3K', summons: 2, ok: 1, fail: 1, sum: '5K', count: 2 })
    assert.ok(zh.length > 0 && en.length > 0 && zh !== en, k)
  }
})
