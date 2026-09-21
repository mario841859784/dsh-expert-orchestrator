// test/tools.selftest.mjs — lib/tools.js 纯函数自测（node:test，零依赖）。
// 覆盖：sanitizePersona / loadRoster / loadAliases / resolveExpert（解析链全
// 分支）/ rosterCandidates（花名册归一）/ P1 经验池（expertLessonSlug /
// loadExpertLessons / withLessonHint）/ P2 方法论分层（extractPersonaMethod /
// splitPersona）。文件系统用例使用 os.tmpdir() 临时目录，结束后清理，不触碰
// 仓库内任何数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPERT_TOOLS_DENY_LIST,
  expertLessonSlug,
  extractPersonaMethod,
  filterRestrictableTools,
  loadAliases,
  loadExpertLessons,
  loadRoster,
  registerExpertTools,
  resolveExpert,
  rosterCandidates,
  sanitizePersona,
  splitPersona,
  withLessonHint,
} from '../lib/tools.js'

const PERSONA_LIMIT = 100000 // 与 tools.js MAX_PERSONA_CHARS 一致

test('sanitizePersona: 非字符串与空输入归零', () => {
  assert.equal(sanitizePersona(undefined), '')
  assert.equal(sanitizePersona(null), '')
  assert.equal(sanitizePersona(42), '')
  assert.equal(sanitizePersona(''), '')
  assert.equal(sanitizePersona('   '), '')
})

test('sanitizePersona: 剥离首部 frontmatter（含 CRLF 变体）', () => {
  assert.equal(sanitizePersona('---\nname: x\n---\nBODY'), 'BODY')
  assert.equal(sanitizePersona('---\r\nname: x\r\n---\r\nBODY'), 'BODY')
  // frontmatter 之外的正文内 --- 不受影响
  assert.equal(sanitizePersona('---\na: b\n---\nA\n---\nB'), 'A\n---\nB')
  // 非 frontmatter 开头不剥
  assert.equal(sanitizePersona('# 标题\n---\nx'), '# 标题\n---\nx')
})

test('sanitizePersona: 清理控制字符但保留 \\n \\t', () => {
  const dirty = 'a\u0000b\u0007c\u001bd\u007fe\u000bf\u000cf\tg\nh'
  assert.equal(sanitizePersona(dirty), 'abcdeff\tg\nh')
})

test('sanitizePersona: 超过 100K 码点截断到上限', () => {
  const body = 'x'.repeat(PERSONA_LIMIT + 10)
  const out = sanitizePersona(`---\nk: v\n---\n${body}`)
  assert.equal(out.length, PERSONA_LIMIT)
  // 恰好不超不截
  const exact = 'y'.repeat(PERSONA_LIMIT)
  assert.equal(sanitizePersona(exact), exact)
})

// ── loadRoster / loadAliases：文件系统语义 ──────────────────────────────
let dir // 正常 fixture（两文件均为合法 JSON）
let brokenDir // 损坏 fixture（两文件均为损坏 JSON，供容错语义断言）
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tools-selftest-'))
  mkdirSync(join(dir, 'expert-sources', 'merged'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'expert-orchestration'), { recursive: true })
  writeFileSync(join(dir, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [] }))
  writeFileSync(join(dir, 'skills', 'expert-orchestration', 'roster-aliases.json'), '{"aliases":{}}')
  brokenDir = mkdtempSync(join(tmpdir(), 'tools-selftest-broken-'))
  mkdirSync(join(brokenDir, 'expert-sources', 'merged'), { recursive: true })
  mkdirSync(join(brokenDir, 'skills', 'expert-orchestration'), { recursive: true })
  writeFileSync(join(brokenDir, 'expert-sources', 'merged', 'roster.json'), '{not-json')
  writeFileSync(join(brokenDir, 'skills', 'expert-orchestration', 'roster-aliases.json'), '{"aliases":')
})
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(brokenDir, { recursive: true, force: true })
})

test('loadRoster: 正常 / 文件缺失 / 损坏 JSON', () => {
  assert.deepEqual(loadRoster(dir), { core: [] })
  assert.equal(loadRoster(join(dir, 'missing-root')), null) // 文件缺失 → null
  assert.equal(loadRoster(dir.replace(/.$/, '')), null) // 目录不存在 → null
  assert.equal(loadRoster(brokenDir), null) // 损坏 JSON → null（readJsonFile 容错契约）
})

test('loadAliases: 正常 / 文件缺失 / 损坏 JSON', () => {
  assert.deepEqual(loadAliases(dir), { aliases: {} })
  assert.equal(loadAliases(join(dir, 'missing-root')), null)
  assert.equal(loadAliases(brokenDir), null) // 损坏 JSON → null
})

test('rosterCandidates: core + sources 归一，shadowed/disabled 透传', () => {
  const roster = {
    core: [
      { source: 'bundled-core', file: 'a.md', name: '后端工程师', title: 'Backend', disabled: true },
      { file: 'noname.md' }, // source 缺省回落 bundled-core，name/title 缺省 null
      { noshape: true }, // 无 file → 剔除
    ],
    sources: [
      { id: 'zh', files: [{ file: 'b.md', name: '后端工程师', shadowed: true }] },
    ],
  }
  const cs = rosterCandidates(roster)
  assert.equal(cs.length, 3)
  assert.deepEqual(cs[0], { source: 'bundled-core', file: 'a.md', name: '后端工程师', title: 'Backend', shadowed: false, disabled: true })
  assert.deepEqual(cs[1], { source: 'bundled-core', file: 'noname.md', name: null, title: null, shadowed: false, disabled: false })
  assert.deepEqual(cs[2], { source: 'zh', file: 'b.md', name: '后端工程师', title: null, shadowed: true, disabled: false })
  assert.deepEqual(rosterCandidates(null), [])
  assert.deepEqual(rosterCandidates({}), [])
})

// ── resolveExpert：解析链 exact → alias → title → 歧义/拒绝 ─────────────
const core = { source: 'bundled-core', file: 'backend.md', name: '后端工程师', title: 'Backend Engineer', shadowed: false, disabled: false }
const zhDup = { source: 'agency-agents-zh', file: 'backend.md', name: '后端工程师', title: 'Backend Engineer', shadowed: false, disabled: false }
const ghost = { source: 'bundled-core', file: 'ghost.md', name: '影子工程师', title: null, shadowed: true, disabled: false }
const off = { source: 'bundled-core', file: 'off.md', name: '停用专家', title: null, shadowed: false, disabled: true }
const solo = { source: 'bundled-core', file: 'solo.md', name: '孤名专家', title: 'Unique Title', shadowed: false, disabled: false }
const aliases = { aliases: { 老后端: { source: 'bundled-core', path: 'backend.md' } } }

test('resolveExpert: name 精确命中（大小写与首尾空白归一）', () => {
  const r = resolveExpert([solo], aliases, '  孤名专家 ')
  assert.ok(r.ok)
  assert.equal(r.expert.file, 'solo.md')
})

test('resolveExpert: 跨源重名消歧 → ambiguous 附候选清单', () => {
  const r = resolveExpert([core, zhDup], aliases, '后端工程师')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ambiguous')
  assert.equal(r.candidates.length, 2)
  assert.deepEqual(r.candidates.map((c) => c.source), ['bundled-core', 'agency-agents-zh'])
})

test('resolveExpert: 惯用名 alias 命中（source+path 定位）', () => {
  const r = resolveExpert([core, zhDup], aliases, '老后端')
  assert.ok(r.ok)
  assert.equal(r.expert.source, 'bundled-core')
  assert.equal(r.expert.file, 'backend.md')
})

test('resolveExpert: 无歧义 title 命中；多 title 命中 → ambiguous', () => {
  const ok = resolveExpert([solo], aliases, 'unique title')
  assert.ok(ok.ok)
  const amb = resolveExpert([core, zhDup], aliases, 'backend engineer')
  assert.equal(amb.ok, false)
  assert.equal(amb.reason, 'ambiguous')
})

test('resolveExpert: 未命中 → missing（含空输入）', () => {
  assert.deepEqual(resolveExpert([solo], aliases, '不存在'), { ok: false, reason: 'missing' })
  assert.equal(resolveExpert([solo], aliases, '  ').reason, 'missing')
  assert.equal(resolveExpert([solo], aliases, '').reason, 'missing')
  assert.equal(resolveExpert([solo], aliases, undefined).reason, 'missing')
})

test('resolveExpert: disabled 拒绝', () => {
  const r = resolveExpert([off], aliases, '停用专家')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'expertDisabled')
  assert.equal(r.expert.file, 'off.md')
})

test('resolveExpert: shadowed 拒绝', () => {
  const r = resolveExpert([ghost], aliases, '影子工程师')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'expertShadowed')
  assert.equal(r.expert.file, 'ghost.md')
})

test('resolveExpert: alias 指向不存在的 source/path → missing', () => {
  const broken = { aliases: { 野名: { source: 'nowhere', path: 'x.md' } } }
  assert.equal(resolveExpert([solo], broken, '野名').reason, 'missing')
  assert.equal(resolveExpert([solo], null, '孤名专家').ok, true) // aliases 缺省不炸
})

test('EXPERT_TOOLS_DENY_LIST: 递归防护清单冻结且含派生工具', () => {
  assert.throws(() => { EXPERT_TOOLS_DENY_LIST.push('x') })
  for (const t of ['list_experts', 'summon_expert', 'summon_experts', 'subagent', 'subagent_fork', 'workflow']) {
    assert.ok(EXPERT_TOOLS_DENY_LIST.includes(t), t)
  }
})

// ── P1 每专家经验池：slug 派生 / loadExpertLessons / withLessonHint ───────
test('expertLessonSlug: source/file 派生稳定，跨源重名天然消歧', () => {
  assert.equal(expertLessonSlug('bundled-core', 'backend-engineer.md'), 'bundled-core--backend-engineer')
  // 同名专家不同来源 → slug 必然不同
  assert.notEqual(expertLessonSlug('bundled-core', 'backend-engineer.md'), expertLessonSlug('agency-agents-zh', 'backend-engineer.md'))
  // 路径分隔符与不安全字符归一为 '-'；.md 后缀剥除
  assert.equal(expertLessonSlug('Weird Source', 'Sub Dir/Name.md'), 'Weird-Source--Sub-Dir-Name')
  // 确定性：同输入同输出
  const once = expertLessonSlug('custom', '我的专家.md')
  assert.equal(expertLessonSlug('custom', '我的专家.md'), once)
  // slug 对空 file 仍可用（防御）：尾随连字符被归一
  assert.equal(expertLessonSlug('custom', ''), 'custom')
})

test('loadExpertLessons: 正常加载（sanitize 复用剥 frontmatter）/ 缺文件静默 / 2K 截断', () => {
  const lessonsDir = join(dir, 'expert-lessons')
  mkdirSync(lessonsDir, { recursive: true })
  writeFileSync(join(lessonsDir, 'bundled-core--backend-engineer.md'), '---\ntitle: x\n---\n要点一\n要点二')
  const ok = loadExpertLessons(dir, 'bundled-core--backend-engineer')
  assert.equal(ok, '要点一\n要点二') // frontmatter 已剥
  // 缺文件 → 静默 null（不抛出）
  assert.equal(loadExpertLessons(dir, 'custom--不存在'), null)
  assert.equal(loadExpertLessons(dir.replace(/.$/, ''), 'x'), null) // dst 目录不存在也静默
  // 2000 字符截断
  writeFileSync(join(lessonsDir, 'long.md'), 'y'.repeat(2000) + 'OVERFLOW')
  const long = loadExpertLessons(dir, 'long')
  assert.equal(long.length, 2000)
  assert.ok(!long.includes('OVERFLOW'))
  // 空 slug 防御 → null
  assert.equal(loadExpertLessons(dir, ''), null)
})

test('withLessonHint: 尾部注入固定格式 / 无命中行为零变化', () => {
  assert.equal(withLessonHint('任务书', '后端工程师', null), '任务书')
  assert.equal(withLessonHint('任务书', '后端工程师', ''), '任务书')
  assert.equal(
    withLessonHint('任务书', '后端工程师', '要点'),
    '任务书\n\n【经验提示｜来自 后端工程师 历次任务沉淀】\n要点',
  )
  // 固定前缀不被破坏：注入只发生在尾部
  const out = withLessonHint('任务书', 'X', '提示')
  assert.ok(out.startsWith('任务书'))
})

// ── P2 persona 方法论分层：extractPersonaMethod / splitPersona ───────────
test('extractPersonaMethod: frontmatter method 键提取 / 缺失返 null', () => {
  const raw = '---\ntitle: 后端工程师\nmethod: expert-methods/backend-engineer.md\n---\nBODY'
  assert.equal(extractPersonaMethod(raw), 'expert-methods/backend-engineer.md')
  // 无 frontmatter → null（来源包专家典型形态）
  assert.equal(extractPersonaMethod('# 标题\nBODY'), null)
  // 有 frontmatter 无 method → null
  assert.equal(extractPersonaMethod('---\ntitle: x\n---\nBODY'), null)
  assert.equal(extractPersonaMethod(undefined), null)
  assert.equal(extractPersonaMethod(''), null)
  // CRLF 变体
  assert.equal(extractPersonaMethod('---\r\nmethod: m.md\r\n---\r\nBODY'), 'm.md')
})

test('splitPersona: 有标记+method → 瘦 persona + abs 指针行；method 文件缺失回退全文', () => {
  const methodsDir = join(dir, 'expert-methods')
  mkdirSync(methodsDir, { recursive: true })
  writeFileSync(join(methodsDir, 'backend-engineer.md'), '# 领域方法论\n- 清单 A')
  const body = '核心规则\n<!-- methods-cut -->\n深读区清单（不应注入）'
  const out = splitPersona(dir, body, 'expert-methods/backend-engineer.md')
  assert.ok(out.startsWith('核心规则'))
  assert.ok(!out.includes('深读区清单'))
  // 指针行含 dst 注入构造的绝对路径
  assert.ok(out.includes(join(dir, 'expert-methods', 'backend-engineer.md')))
  assert.ok(out.endsWith('任务复杂或触及清单场景时先 read 再动手'))
  // method 文件缺失 → fail-safe 回退全文
  const fallback = splitPersona(dir, body, 'expert-methods/missing.md')
  assert.equal(fallback, body)
})

test('splitPersona: 无标记 / 无 method / 可疑路径 → 原文（向后兼容）', () => {
  const body = '核心规则\n<!-- methods-cut -->\n深读区'
  // 无 cut 标记（即使 method 文件存在）
  assert.equal(splitPersona(dir, '普通 persona 全文', 'expert-methods/backend-engineer.md'), '普通 persona 全文')
  // 无 method 键（来源包专家零变化）
  assert.equal(splitPersona(dir, body, null), body)
  assert.equal(splitPersona(dir, body, ''), body)
  // 可疑路径防御：绝对路径 / 越过 dst / 非 expert-methods/ 前缀（评审加固：
  // 防上游 persona 携带 method 键把 dst 内任意文件路径指给子代理）
  assert.equal(splitPersona(dir, body, '/etc/passwd'), body)
  assert.equal(splitPersona(dir, body, '../escape.md'), body)
  assert.equal(splitPersona(dir, body, 'skills/expert-orchestration/lessons.md'), body)
  assert.equal(splitPersona(dir, body, 'expert-lessons/long.md'), body)
})

test('P2 回归锁：来源包风格 persona 经完整管线（sanitize→split）行为零变化', () => {
  const raw = '---\ntitle: Upstream Expert\n---\n正文 A\n\n正文 B'
  const method = extractPersonaMethod(raw)
  assert.equal(method, null) // 无 method 键
  const sanitized = sanitizePersona(raw)
  assert.equal(splitPersona(dir, sanitized, method), sanitized) // 全文注入，逐字相等
})

// ── T9 召唤通道缺陷回归：restrict 名单过滤 + summon_experts 输出 lossless ──
/** 宿主同款 lossless JSON 判定（零依赖简化版，对齐 dsh-util-values walkJsonValue
 *  规则：有限非 -0 数 / plain object / 稠密数组 / 无 undefined）。 */
const isLosslessJson = (v, seen = new Set()) => {
  if (v === null) return true
  const t = typeof v
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(v) && !Object.is(v, -0)
  if (t !== 'object') return false
  if (seen.has(v)) return false
  seen.add(v)
  if (Array.isArray(v)) {
    if (Object.getOwnPropertyNames(v).length !== v.length + 1) return false // 稠密
    return v.every((x) => isLosslessJson(x, seen))
  }
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.keys(v).every((k) => isLosslessJson(v[k], seen))
}

test('filterRestrictableTools: 按宿主注册表剔除未知名 / API 缺失或异常时保守', () => {
  const registry = new Set(['list_experts', 'summon_expert', 'summon_experts', 'subagent_fork', 'workflow']) // 无 subagent（缺陷 A 现场形态）
  const ctxA = { tools: { get: (n) => (registry.has(n) ? {} : undefined) } }
  assert.deepEqual(filterRestrictableTools(ctxA, EXPERT_TOOLS_DENY_LIST), ['list_experts', 'summon_expert', 'summon_experts', 'subagent_fork', 'workflow'])
  // 全部已注册 → 原样（顺序保持）
  const ctxAll = { tools: { get: () => ({}) } }
  assert.deepEqual(filterRestrictableTools(ctxAll, EXPERT_TOOLS_DENY_LIST), [...EXPERT_TOOLS_DENY_LIST])
  // 探测 API 缺失 → 保守原样（退回宿主报错，不静默放宽）
  assert.deepEqual(filterRestrictableTools({}, EXPERT_TOOLS_DENY_LIST), [...EXPERT_TOOLS_DENY_LIST])
  // 探测异常 → 保守保留该名（防护优先）
  const ctxThrow = { tools: { get: () => { throw new Error('boom') } } }
  assert.deepEqual(filterRestrictableTools(ctxThrow, EXPERT_TOOLS_DENY_LIST), [...EXPERT_TOOLS_DENY_LIST])
})

test('T9 缺陷 A 回归：summon 传给宿主的 toolFilter.deny 不含未注册名', async () => {
  const dst = mkdtempSync(join(tmpdir(), 't9-registry-'))
  try {
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [{ source: 'bundled-core', file: 'a.md', name: '测试专家' }] }))
    const descriptors = []
    let captured
    const ctx = {
      tools: {
        register: (d) => descriptors.push(d),
        // 现场形态：注册表无 subagent（其余 deny 名均在）
        get: (n) => (n === 'subagent' ? undefined : {}),
      },
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
        start: async (_provider, opts) => {
          captured = opts
          return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }
        },
      },
    }
    registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }) })
    const summon = descriptors.find((d) => d.name === 'summon_expert')
    const r = await summon.execute({ expert: '测试专家', task: '任务' }, { agent: {} })
    assert.equal(r.answer, 'ok')
    assert.ok(!captured.toolFilter.deny.includes('subagent')) // 缺陷 A：未注册名不得传给 restrict
    for (const n of ['list_experts', 'summon_expert', 'summon_experts', 'subagent_fork', 'workflow']) {
      assert.ok(captured.toolFilter.deny.includes(n), n)
    }
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})

test('T9 缺陷 B 回归：summon_experts 失败条目无 answer 键，返回值全程 lossless', async () => {
  const dst = mkdtempSync(join(tmpdir(), 't9-no-roster-')) // 花名册缺失 → 全部失败（缺陷 B 触发形态）
  try {
    const descriptors = []
    const ctx = {
      tools: { register: (d) => descriptors.push(d) },
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
        start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }),
      },
    }
    registerExpertTools(ctx, { dst })
    const t = descriptors.find((d) => d.name === 'summon_experts')
    const value = await t.execute({ experts: [{ expert: '甲', task: 't' }, { expert: '乙', task: 't' }] }, { agent: {} })
    assert.equal(value.results.length, 2)
    for (const entry of value.results) {
      assert.equal(entry.ok, false)
      assert.ok(typeof entry.error === 'string' && entry.error.length > 0)
      assert.ok(!('answer' in entry)) // 缺陷 B 根因：显式 answer: undefined 使宿主快照拒绝
    }
    assert.ok(isLosslessJson(value)) // 宿主 snapshotJsonValue 同规则判定
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})

test('T9 缺陷 B 补充：混合成功/失败条目形状正确且 lossless', async () => {
  const dst = mkdtempSync(join(tmpdir(), 't9-mixed-'))
  try {
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [{ source: 'bundled-core', file: 'a.md', name: '测试专家' }] }))
    const descriptors = []
    const ctx = {
      tools: { register: (d) => descriptors.push(d) },
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
        start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '子代理回答' }] }), dispose: async () => {} }),
      },
    }
    registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }) })
    const t = descriptors.find((d) => d.name === 'summon_experts')
    const value = await t.execute({ experts: [{ expert: '测试专家', task: 't' }, { expert: '不存在', task: 't' }] }, { agent: {} })
    assert.equal(value.results.length, 2)
    const okEntry = value.results.find((e) => e.ok === true)
    assert.equal(okEntry.answer, '子代理回答')
    assert.ok(!('error' in okEntry))
    const failEntry = value.results.find((e) => e.ok === false)
    assert.ok(!('answer' in failEntry))
    assert.ok(typeof failEntry.error === 'string')
    assert.ok(isLosslessJson(value))
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})
