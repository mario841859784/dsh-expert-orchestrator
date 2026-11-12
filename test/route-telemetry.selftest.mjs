// ⑤小切口 自测：路由实测数据回填（lib/route-telemetry.js + lib/tools.js summon 边界接线
// + scripts/routing-metrics.mjs 聚合面）（node:test，零依赖）。
// 覆盖面：
// - telemetryEnabled：默认开（攒数据是切口目的）/'0'、'' 关/'1' 开/非法值开+告警；
// - buildSample：字段形状（码点计数、usage=null 占位、stopReason 非串归 null、时长取整）；
// - appendSample/makeRecorder：JSONL 追加、8MB 软顶跳过（cap）、fail-open（落盘异常本会话
//   禁用 + warn 一次性）、kill switch 零文件；
// - aggregate：按专家/模型聚合（okRate/tokPerChar 反推比/时长分位/stopReason 分布缺省归并）；
// - summon 接线真断言（econ 桩同形夹具）：召唤一次 → .expert-routing/samples.jsonl 落一行
//   完整样本（expert/model/pref/ok/stopReason=completed/estTokens>0/durationMs≥0/usage=null），
//   summon 输出零变化；kill switch → 零文件；pref env 透传。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { telemetryEnabled, buildSample, appendSample, makeRecorder, aggregate } from '../lib/route-telemetry.js'
import { registerExpertTools } from '../lib/tools.js'

const noopWarn = () => {}

/** env 守卫：防部署环境注入干扰断言。 */
const guardEnv = (t, keys) => {
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

const makeDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `rt-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const readSamples = (cwd) => {
  const raw = readFileSync(join(cwd, '.expert-routing', 'samples.jsonl'), 'utf-8')
  return raw.trim().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

// ── 纯函数面 ──────────────────────────────────────────────────────────────────

test('⑤ telemetryEnabled：默认开 / 0、空串关 / 1 开 / 非法值开+告警', () => {
  assert.equal(telemetryEnabled({}, noopWarn), true, '未设置=默认开（攒数据是切口目的）')
  assert.equal(telemetryEnabled({ DSH_EXPERT_ROUTE_TELEMETRY: '0' }, noopWarn), false)
  assert.equal(telemetryEnabled({ DSH_EXPERT_ROUTE_TELEMETRY: '' }, noopWarn), false)
  assert.equal(telemetryEnabled({ DSH_EXPERT_ROUTE_TELEMETRY: '1' }, noopWarn), true)
  const warns = []
  assert.equal(telemetryEnabled({ DSH_EXPERT_ROUTE_TELEMETRY: 'junk' }, (m) => warns.push(m)), true, '非法值按开处理（宁多记勿静默丢样本）')
  assert.equal(warns.length, 1)
})

test('⑤ buildSample：码点计数 / usage=null 占位 / stopReason 非串归 null / 时长取整与非有限归 null', () => {
  const s = buildSample({ expert: '专家甲', model: 'm1', pref: 'cost', ok: true, stopReason: 'completed', taskText: '三个汉字abc', answerText: 'ok', estTokens: 7, durationMs: 1234.6 })
  assert.equal(s.v, 1)
  assert.equal(s.taskChars, 7, '「三个汉字」4 汉字+3 ascii=7 码点')
  assert.equal(s.answerChars, 2)
  assert.equal(s.estTokens, 7)
  assert.equal(s.durationMs, 1235, '时长取整')
  assert.equal(s.usage, null, '宿主 seam 未暴露 usage——占位保证行形状稳定')
  assert.equal(s.ok, true)
  const bad = buildSample({ stopReason: 42, durationMs: -1, estTokens: 'x' })
  assert.equal(bad.stopReason, null, '非串 stopReason 归 null（不猜）')
  assert.equal(bad.durationMs, null, '负值时长归 null')
  assert.equal(bad.estTokens, 0, '非有限估算值归 0')
  assert.equal(bad.answerChars, 0)
})

// ── 落盘面 ────────────────────────────────────────────────────────────────────

test('⑤ appendSample/makeRecorder：JSONL 逐行追加 + kill switch 零文件 + 软顶 cap 跳过', (t) => {
  guardEnv(t, ['DSH_EXPERT_ROUTE_TELEMETRY'])
  delete process.env.DSH_EXPERT_ROUTE_TELEMETRY
  const dir = makeDir(t, 'append')
  const rec = makeRecorder({ env: process.env, warn: noopWarn })
  rec.record({ expert: '甲', ok: true, taskText: '任务书', answerText: 'ok', estTokens: 5 }, dir)
  rec.record({ expert: '乙', ok: false, taskText: '任务书二' }, dir)
  const samples = readSamples(dir)
  assert.equal(samples.length, 2)
  assert.equal(samples[0].expert, '甲')
  assert.equal(samples[1].ok, false, '失败样本如实落盘（answerChars=0）')
  // kill switch：关闭后零新文件/零新行
  process.env.DSH_EXPERT_ROUTE_TELEMETRY = '0'
  const dir2 = makeDir(t, 'kill')
  makeRecorder({ env: process.env, warn: noopWarn }).record({ expert: '丙', ok: true }, dir2)
  assert.equal(existsSync(join(dir2, '.expert-routing')), false, 'kill switch=零目录零文件')
  // 软顶：maxBytes 注入即跳过（appendSample 直测，cap 不删不滚）
  const r = appendSample(dir, buildSample({ expert: '丁', ok: true }), { maxBytes: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cap')
  assert.equal(readSamples(dir).length, 2, 'cap 后零追加（archive/back up, never destroy）')
})

test('⑤ makeRecorder fail-open：落盘异常一次性告警后本会话禁用（不阻塞 summon 路径）', (t) => {
  guardEnv(t, ['DSH_EXPERT_ROUTE_TELEMETRY'])
  delete process.env.DSH_EXPERT_ROUTE_TELEMETRY
  const warns = []
  const rec = makeRecorder({ env: process.env, warn: (m) => warns.push(m) })
  const base = makeDir(t, 'failopen')
  const bogusCwd = join(base, 'not-a-dir', 'deeper')
  mkdirSync(dirname(bogusCwd), { recursive: true })
  writeFileSync(bogusCwd, '占位文件') // cwd 是文件：mkdir/append 必失败
  rec.record({ expert: '甲', ok: true }, bogusCwd)
  assert.equal(warns.length, 1, '首次失败一次性告警')
  rec.record({ expert: '甲', ok: true }, bogusCwd)
  assert.equal(warns.length, 1, '本会话禁用：不再告警不再尝试')
})

// ── 聚合面 ────────────────────────────────────────────────────────────────────

test('⑤ aggregate：按专家/模型聚合 + okRate/tokPerChar/时长分位/stopReason 缺省归并', () => {
  const samples = [
    { expert: '甲', model: 'm1', ok: true, stopReason: 'completed', taskChars: 10, answerChars: 100, estTokens: 30, durationMs: 100 },
    { expert: '甲', model: 'm1', ok: false, taskChars: 20, answerChars: 0, estTokens: 5, durationMs: 300 },
    { expert: '乙', model: 'm2', ok: true, stopReason: 'max-tokens', taskChars: 10, answerChars: 50, estTokens: 20, durationMs: 200 },
  ]
  const agg = aggregate(samples)
  assert.equal(agg.samples, 3)
  const a = agg.byExpert.find((r) => r.key === '甲')
  assert.equal(a.count, 2)
  assert.equal(a.okRate, 0.5)
  assert.equal(a.tokPerChar, Math.round((35 / 130) * 1000) / 1000, 'tok/字=estTokens/(task+answer) 反推比')
  assert.equal(a.durationP50, 100)
  assert.equal(a.durationP95, 300)
  assert.deepEqual(a.stopReasons, { completed: 1, unknown: 1 }, '失败无 stopReason → unknown 归并')
  const m = agg.byModel.find((r) => r.key === 'm2')
  assert.equal(m.stopReasons['max-tokens'], 1)
  assert.equal(aggregate([]).byExpert.length, 0)
  assert.equal(aggregate(null).samples, 0, '非数组输入如实归零（聚合面不抛）')
})

// ── summon 接线真断言（econ 桩同形夹具）────────────────────────────────────────

/** summon 捕获夹具（与 orchestration-economics.selftest makeSummonCtx 同形）。 */
const makeSummonCtx = () => {
  const descriptors = []
  const tools = { register: (d) => descriptors.push(d) }
  return {
    descriptors,
    ctx: {
      tools,
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
        start: async (_provider, opts) => {
          const index = 0
          const result = { stopReason: 'completed', output: [{ type: 'text', text: `ok${index}` }] }
          return { result: Promise.resolve(result), dispose: async () => {} }
        },
      },
    },
  }
}

const makeRosterFixture = (t, label) => {
  const root = mkdtempSync(join(tmpdir(), `rt-sum-${label}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dst = join(root, 'dst')
  mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({
    core: [{ source: 'bundled-core', file: 'e0.md', name: '测试专家' }],
  }))
  return { root, dst, homePath: join(root, 'home', 'expert-profiles.json'), projectPath: join(root, 'ws', '.dsh', 'expert-profiles.json') }
}

test('⑤ summon 接线真断言：召唤一次落完整样本（输出零变化）+ pref env 透传 + kill switch 零文件', async (t) => {
  guardEnv(t, ['DSH_EXPERT_ROUTE_TELEMETRY', 'DSH_EXPERT_ROUTE_PREF', 'DSH_EXPERT_TOKEN_BUDGET'])
  delete process.env.DSH_EXPERT_ROUTE_TELEMETRY
  delete process.env.DSH_EXPERT_TOKEN_BUDGET
  process.env.DSH_EXPERT_ROUTE_PREF = 'cost'
  const f = makeRosterFixture(t, 'wired')
  const { descriptors, ctx } = makeSummonCtx()
  registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  const r = await summon.execute({ expert: '测试专家', task: '遥测接线任务书' }, { agent: {} })
  assert.equal(r.answer, 'ok0', '埋点零变化：summon answer 无任何附加行')
  const samples = readSamples(f.root)
  assert.equal(samples.length, 1)
  const s = samples[0]
  assert.equal(s.v, 1)
  assert.equal(s.expert, '测试专家')
  assert.equal(s.pref, 'cost', '路由偏好档随样本落盘（校准路由用）')
  assert.equal(s.ok, true)
  assert.equal(s.stopReason, 'completed', '宿主结算 stopReason 随结果回传（additive）')
  assert.equal(typeof s.model, 'string', '模型字段在（桩夹具未配档案 model → 空串如实记录）')
  assert.ok(s.estTokens > 0)
  assert.ok(s.answerChars === 3, '回包 ok0=3 码点')
  assert.ok(Number.isFinite(s.durationMs) && s.durationMs >= 0, '实测时长已采')
  assert.equal(s.usage, null)
  // kill switch：关掉后召唤零落盘（输出仍零变化）
  process.env.DSH_EXPERT_ROUTE_TELEMETRY = '0'
  const f2 = makeRosterFixture(t, 'wired-off')
  const { descriptors: d2, ctx: c2 } = makeSummonCtx()
  registerExpertTools(c2, { dst: f2.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f2.root, profilesPaths: { homePath: f2.homePath, projectPath: f2.projectPath } })
  await d2.find((d) => d.name === 'summon_expert').execute({ expert: '测试专家', task: '关闭后召唤' }, { agent: {} })
  assert.equal(existsSync(join(f2.root, '.expert-routing')), false, 'kill switch=零目录零文件')
})
