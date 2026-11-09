// test/session-cwd.selftest.mjs — T1 会话 cwd 解析缝（方案 a′）自测（node:test，零依赖）。
// 覆盖：resolveSessionCwd 解析链各来源注入分别命中 + 优先级断言：
//   ① summon 显式 cwd 参数 > ② 宿主 exec.agent 会话 cwd（workingDirectory 服务
//   通道 get(session)；不可达降级 session.header.cwd）> ③ config.expertTools?.cwd
//   （注册 cwd 配置）> ④ process.cwd() 注册期兜底（autoClaimCwd 注入通道=现状）。
// 观测面：文件层项目层专家（<cwd>/.dsh/experts/*.md）只在被消费的 cwd 命中——
// 各候选目录放同名互斥的探针专家，summon 成败 + provider 收到的 persona 内容
// 即证明解析缝落点；summon_experts 顶层 cwd 透传与 list_experts 会话 cwd 同测。
// 回归底线：无会话 cwd、无显式参数时走 autoClaimCwd 注入（现状通道）——用例 5。
// 文件系统用例使用 os.tmpdir() 临时目录，结束后清理，不触碰仓库内任何数据。
process.env.DSH_EXPERT_REPLY_LANG = 'zh'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerExpertTools } from '../lib/tools.js'

// 全局层隔离：DSH_HOME 指向独立空 tmp——本文件所有用例只允许项目层文件层命中，
// 全局层恒空（排除全局层干扰，锚定「项目层目录=解析缝落点」的观测面）。
const DSH_HOME = mkdtempSync(join(tmpdir(), 't1-dsh-home-'))
process.env.DSH_HOME = DSH_HOME

/** 探针专家 .md（frontmatter + 带 PERSONA_<mark> 标记的正文，persona 断言锚）。 */
const probeMd = (name, mark) => `---\nname: ${name}\ntitle: ${name} 标题\n---\nPERSONA_${mark} 正文\n`

/** 建一组候选目录：每个 dir 一个互斥探针专家（exp-a/exp-b/exp-c/exp-f）。 */
function makeProbeDirs() {
  const root = mkdtempSync(join(tmpdir(), 't1-cwd-'))
  const defs = [
    ['dirA', 'exp-a', 'A'],
    ['dirB', 'exp-b', 'B'],
    ['dirC', 'exp-c', 'C'],
    ['dirF', 'exp-f', 'F'],
  ]
  const dirs = {}
  for (const [key, name, mark] of defs) {
    const dir = join(root, key)
    mkdirSync(join(dir, '.dsh', 'experts'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'experts', `${name}.md`), probeMd(name, mark))
    dirs[key] = dir
  }
  return { root, dirs }
}

/** 构造待探测 exec：
 *  - host channel：session 在、workingDirectory 服务投影 get() 返回 hostCwd；
 *  - header channel：服务不可达（ctx.get 拿不到 workingDirectory），降级
 *    session.header.cwd；
 *  - 无会话 cwd：exec.agent 无 session（现状测试形态 { agent: {} }）。 */
function makeExec({ hostCwd, headerCwd, noSession = false } = {}) {
  if (noSession) return { agent: {} }
  const session = { header: headerCwd !== undefined ? { cwd: headerCwd } : {} }
  if (hostCwd !== undefined) session.__wd = hostCwd
  return { agent: { session } }
}

/** mock ctx + 注册。withWd=false 模拟服务未挂载（ctx.get 拿不到 workingDirectory）。 */
function setup({ dst, hostCwd, withWd = true, configCwd, autoClaimCwd } = {}) {
  const descriptors = []
  const specs = []
  const ctx = {
    tools: {
      register: (d) => descriptors.push(d),
      get: (n) => (n === 'subagent' ? undefined : {}),
    },
    subagents: {
      getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
      start: async (_provider, opts) => {
        specs.push(opts)
        return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }
      },
    },
  }
  if (withWd) {
    ctx.get = (name) => {
      if (name === 'workingDirectory') return hostCwd !== undefined ? { get: () => hostCwd } : undefined
      return undefined
    }
  }
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), ...(configCwd !== undefined ? { cwd: configCwd } : {}), ...(autoClaimCwd !== undefined ? { autoClaimCwd } : {}) })
  const byName = (n) => descriptors.find((d) => d.name === n)
  return { summon: byName('summon_expert'), summonBatch: byName('summon_experts'), list: byName('list_experts'), specs }
}

test('T1 ① 显式 cwd 参数优先级最高（压过宿主会话 cwd 与 config 覆盖）', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    // 会话 cwd=dirA、config 覆盖=dirB，但显式参数=dirC → 必须落 dirC。
    const { summon, specs } = setup({ dst, hostCwd: dirs.dirA, configCwd: dirs.dirB })
    const r = await summon.execute({ expert: 'exp-c', task: '任务', cwd: dirs.dirC }, makeExec({ hostCwd: dirs.dirA }))
    assert.equal(r.answer, 'ok')
    assert.ok(specs[0].persona.includes('PERSONA_C'), 'persona 来自显式 cwd 目录的文件层专家')
    // 同一 exec/config 下不带显式参数命中 dirA 会话层——反证显式参数确实参与裁决。
    const r2 = await summon.execute({ expert: 'exp-a', task: '任务' }, makeExec({ hostCwd: dirs.dirA }))
    assert.equal(r2.answer, 'ok')
    assert.ok(specs[1].persona.includes('PERSONA_A'))
    // 显式参数指向 dirC 时 dirA 的专家不可见（优先级压过会话通道）。
    await assert.rejects(() => summon.execute({ expert: 'exp-a', task: '任务', cwd: dirs.dirC }, makeExec({ hostCwd: dirs.dirA })), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 ② 宿主 exec.agent 会话 cwd（workingDirectory 服务通道 get(session)）', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    const { summon, specs } = setup({ dst, hostCwd: dirs.dirA })
    const r = await summon.execute({ expert: 'exp-a', task: '任务' }, makeExec({ hostCwd: dirs.dirA }))
    assert.equal(r.answer, 'ok')
    assert.ok(specs[0].persona.includes('PERSONA_A'), 'persona 来自会话 cwd 目录的文件层专家')
    // 会话 cwd=dirA 时 dirB 探针不可见（证明落点确是会话 cwd 而非兜底）。
    await assert.rejects(() => summon.execute({ expert: 'exp-b', task: '任务' }, makeExec({ hostCwd: dirs.dirA })), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 ②′ 服务不可达降级 session.header.cwd 通道', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    // withWd=false：ctx.get 拿不到 workingDirectory（服务未挂载形态）→ 降级 header.cwd。
    const { summon, specs } = setup({ dst, withWd: false })
    const r = await summon.execute({ expert: 'exp-b', task: '任务' }, makeExec({ headerCwd: dirs.dirB }))
    assert.equal(r.answer, 'ok')
    assert.ok(specs[0].persona.includes('PERSONA_B'), 'persona 来自 header.cwd 目录的文件层专家')
    await assert.rejects(() => summon.execute({ expert: 'exp-a', task: '任务' }, makeExec({ headerCwd: dirs.dirB })), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 ③ config.expertTools.cwd 配置覆盖（无会话 cwd 时生效）', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    // exec.agent 无 session（现状测试形态）→ 解析链落到 configCwd=dirC。
    const { summon, specs } = setup({ dst, configCwd: dirs.dirC, autoClaimCwd: dirs.dirF })
    const r = await summon.execute({ expert: 'exp-c', task: '任务' }, makeExec({ noSession: true }))
    assert.equal(r.answer, 'ok')
    assert.ok(specs[0].persona.includes('PERSONA_C'), 'persona 来自 config cwd 目录的文件层专家')
    // config 覆盖压过 autoClaimCwd 兜底：dirF 探针不可见。
    await assert.rejects(() => summon.execute({ expert: 'exp-f', task: '任务' }, makeExec({ noSession: true })), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 ④ 兜底回归：无会话 cwd、无显式、无 config → autoClaimCwd 现状通道', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    const { summon, specs } = setup({ dst, withWd: false, autoClaimCwd: dirs.dirF })
    const r = await summon.execute({ expert: 'exp-f', task: '任务' }, makeExec({ noSession: true }))
    assert.equal(r.answer, 'ok')
    assert.ok(specs[0].persona.includes('PERSONA_F'), 'persona 来自 autoClaimCwd 注入目录（≤2.13.5 现状行为）')
    await assert.rejects(() => summon.execute({ expert: 'exp-a', task: '任务' }, makeExec({ noSession: true })), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 空白 cwd 参数视为未传（trim 后落下一级）', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    const { summon, specs } = setup({ dst, hostCwd: dirs.dirA, configCwd: dirs.dirB })
    // 空白显式参数 → 落会话通道 dirA。
    const r = await summon.execute({ expert: 'exp-a', task: '任务', cwd: '   ' }, makeExec({ hostCwd: dirs.dirA }))
    assert.equal(r.answer, 'ok')
    assert.ok(specs[0].persona.includes('PERSONA_A'))
    // 会话 cwd 缺席（服务不可达、header 无 cwd）时空白显式参数 → 落 config=dirB。
    const { summon: summon2, specs: specs2 } = setup({ dst, configCwd: dirs.dirB, autoClaimCwd: dirs.dirF })
    const r2 = await summon2.execute({ expert: 'exp-b', task: '任务', cwd: '  ' }, makeExec({}))
    assert.equal(r2.answer, 'ok')
    assert.ok(specs2[0].persona.includes('PERSONA_B'))
    // 同一形态下不带空白参数的兜底探针（dirF）不可见——证明落点是 config 而非兜底。
    await assert.rejects(() => summon2.execute({ expert: 'exp-f', task: '任务' }, makeExec({})), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 summon_experts 顶层 cwd 透传（每项共享同一解析缝输入）', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    const { summonBatch, specs } = setup({ dst, hostCwd: dirs.dirA })
    // 显式顶层 cwd=dirC：批内命中 dirC 探针。
    const v = await summonBatch.execute({ experts: [{ expert: 'exp-c', task: 't' }], cwd: dirs.dirC }, makeExec({ hostCwd: dirs.dirA }))
    assert.deepEqual(v.results.map((x) => [x.expert, x.ok]), [['exp-c', true]])
    assert.ok(specs[0].persona.includes('PERSONA_C'))
    // 不带 cwd：批内走会话通道 dirA。
    const v2 = await summonBatch.execute({ experts: [{ expert: 'exp-a', task: 't' }] }, makeExec({ hostCwd: dirs.dirA }))
    assert.deepEqual(v2.results.map((x) => [x.expert, x.ok]), [['exp-a', true]])
    assert.ok(specs[1].persona.includes('PERSONA_A'))
    // cwd=dirC 时 dirA 探针失败条目形态完好（ok:false + error 字符串）。
    const v3 = await summonBatch.execute({ experts: [{ expert: 'exp-a', task: 't' }], cwd: dirs.dirC }, makeExec({ hostCwd: dirs.dirA }))
    assert.equal(v3.results[0].ok, false)
    assert.match(String(v3.results[0].error), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 list_experts 项目层文件层视图随会话 cwd', async () => {
  const { root, dirs } = makeProbeDirs()
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    const { list } = setup({ dst, hostCwd: dirs.dirA, autoClaimCwd: dirs.dirF })
    // 会话 cwd=dirA：文件层只见 exp-a。
    const withSession = await list.execute({ bySource: '.file-layer' }, makeExec({ hostCwd: dirs.dirA }))
    const names1 = withSession.sources[0]?.experts?.map((e) => e.name) ?? []
    assert.deepEqual(names1, ['exp-a'])
    // 无会话 cwd：文件层落 autoClaimCwd=dirF（现状兜底）。
    const withoutSession = await list.execute({ bySource: '.file-layer' }, makeExec({ noSession: true }))
    const names2 = withoutSession.sources[0]?.experts?.map((e) => e.name) ?? []
    assert.deepEqual(names2, ['exp-f'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T1 零注入回归：registerExpertTools 全缺省（autoClaimCwd=process.cwd()）不炸', async () => {
  // 现状宿主形态（lib/index.js 未传 cwd/autoClaimCwd）：解析缝必须安静落
  // process.cwd() 兜底，summon 解析/报错路径与 ≤2.13.5 逐字节一致。
  const root = mkdtempSync(join(tmpdir(), 't1-default-'))
  try {
    const dst = join(root, 'dst')
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
    const { summon } = setup({ dst, withWd: false })
    await assert.rejects(() => summon.execute({ expert: 'exp-a', task: '任务' }, { agent: {} }), /专家不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
