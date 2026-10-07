// test/tools.selftest.mjs — lib/tools.js 纯函数自测（node:test，零依赖）。
// 覆盖：sanitizePersona / loadRoster / loadAliases / resolveExpert（解析链全
// 分支）/ rosterCandidates（花名册归一）/ P1 经验池（expertLessonSlug /
// loadExpertLessons / withLessonHint）/ P2 方法论分层（extractPersonaMethod /
// splitPersona）。文件系统用例使用 os.tmpdir() 临时目录，结束后清理，不触碰
// 仓库内任何数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  autoClaimSummonedTasks,
  EXPERT_TOOLS_DENY_LIST,
  expertLessonSlug,
  extractPersonaMethod,
  filterRestrictableTools,
  loadAliases,
  loadExpertLessons,
  loadRoster,
  locateAutoClaimBoard,
  neutralizePromptTemplates,
  parseTaskIds,
  registerExpertTools,
  resolveExpert,
  rosterCandidates,
  sanitizePersona,
  splitPersona,
  withLessonHint,
} from '../lib/tools.js'
import { remoteCleanupCustomDeleted, remoteDeleteCustom, remoteSaveCustom } from '../lib/index.js'
import { readFileSync } from 'node:fs'

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

// ── 模板括号中和（P3）：防宿主 interpolate 把 persona 内 {{name}} 当变量 ──
test('neutralizePromptTemplates: CI 模板片段双花括号全部中和', () => {
  // 典型现场形态：${{ github.sha }}（名字含点，宿主 VARIABLE_NAME 必拒）；
  // 括号内空格保留，仅双花括号本身被替换
  assert.equal(neutralizePromptTemplates('echo ${{ github.sha }}'), 'echo $« github.sha »')
  assert.equal(neutralizePromptTemplates('echo ${{github.sha}}'), 'echo $«github.sha»')
  assert.equal(neutralizePromptTemplates('{{a}} {{ b.c }} {{{d}}}'), '«a» « b.c » «{d»}') // 单花括号不动
  // 孤立 {{（无闭合）同样被中和——宿主对含 }} 者直接 throw
  assert.equal(neutralizePromptTemplates('孤立 {{ 开头'), '孤立 « 开头')
  assert.equal(neutralizePromptTemplates('只有 }}'), '只有 »')
  // 普通单花括号原样；无花括号原样；确定性
  assert.equal(neutralizePromptTemplates('普通 {a} 与 JSON { "k": 1 }'), '普通 {a} 与 JSON { "k": 1 }')
  assert.equal(neutralizePromptTemplates('无括号文本'), '无括号文本')
  assert.equal(neutralizePromptTemplates('{{x}}'), neutralizePromptTemplates('{{' + 'x}}'))
  // 非字符串透传（不参与 sanitize 归零语义，由 sanitizePersona 统一处理）
  assert.equal(neutralizePromptTemplates(undefined), undefined)
})

test('sanitizePersona: 模板括号中和接入全管线（零 {{ }} 残留）', () => {
  const persona = '---\ntitle: x\n---\nCI 步骤：echo ${{ github.sha }} 与 {{ a.b }}\n单括号 {a} 保留'
  const out = sanitizePersona(persona)
  assert.ok(!out.includes('{{'))
  assert.ok(!out.includes('}}'))
  assert.ok(out.includes('$« github.sha »'))
  assert.ok(out.includes('« a.b »'))
  assert.ok(out.includes('{a}')) // 单花括号不受影响
  // 孤立 {{（无闭合）也被中和；frontmatter 之外的正文处理正常
  assert.equal(sanitizePersona('孤立 {{ 片段'), '孤立 « 片段')
  // 畸形 {{ a.b }}（名字含点）中和后宿主解析器不可能命中
  const malformed = sanitizePersona('模板 {{ a.b }} 示例')
  assert.ok(!malformed.includes('{{') && !malformed.includes('}}'))
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

// ── T6 P7 专家库管理硬化：list_experts 标注 + custom 软删/清理/乐观锁 ──────
test('T6 list_experts: bySource 展开补 conflict/shadowed 标注，compact 与 total 语义不变', async () => {
  const dst = mkdtempSync(join(tmpdir(), 't6-list-'))
  try {
    mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({
      core: [
        { source: 'bundled-core', file: 'a.md', name: '同名专家', title: 'T1' },
        { source: 'bundled-core', file: 'b.md', name: '独名专家' },
      ],
      sources: [
        { id: 'zh', files: [
          { file: 'a.md', name: '同名专家' },
          { file: 'a2.md', name: '同名专家', shadowed: true },
        ] },
      ],
    }))
    const descriptors = []
    registerExpertTools({ tools: { register: (d) => descriptors.push(d) }, subagents: { getProvider: () => ({}), start: async () => ({}) } }, { dst })
    const t = descriptors.find((d) => d.name === 'list_experts')
    // compact 形态：无 experts/shadowed 字段，total 只计可召唤候选（shadowed 剔除）
    const compact = await t.execute({})
    assert.equal(compact.total, 3)
    assert.ok(compact.sources.every((g) => !('shadowed' in g)))
    // bySource：跨源重名 conflict 标注 + shadowed 副本可见
    const zh = await t.execute({ bySource: 'zh' })
    const zhGroup = zh.sources.find((g) => g.source === 'zh')
    assert.equal(zhGroup.experts.length, 1)
    assert.equal(zhGroup.experts[0].conflict, true)
    assert.deepEqual(zhGroup.shadowed, [{ name: '同名专家', title: null, file: 'a2.md' }])
    // bySource：无重名者不打 conflict；无遮蔽者无 shadowed 字段
    const core = await t.execute({ bySource: 'bundled-core' })
    const coreGroup = core.sources.find((g) => g.source === 'bundled-core')
    const dup = coreGroup.experts.find((e) => e.name === '同名专家')
    const solo = coreGroup.experts.find((e) => e.name === '独名专家')
    assert.equal(dup.conflict, true)
    assert.ok(!('conflict' in solo))
    assert.ok(!('shadowed' in coreGroup))
    // 未知名来源仍报错
    await assert.rejects(() => t.execute({ bySource: '不存在' }), /来源不存在或未启用/)
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})

test('T6 P7 契约锁：deleteCustom 软删+wasEnabled、deleted slug 不可复活、同名可重建', async () => {
  const dst = mkdtempSync(join(tmpdir(), 't6-softdel-'))
  try {
    mkdirSync(join(dst, 'expert-sources'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'sources.json'), JSON.stringify({ version: 1, revision: 0, mirrorPrefixes: null, dedup: { preferLang: null, choice: {} }, sources: [], mergedStateHash: '' }))
    writeFileSync(join(dst, 'expert-sources', 'custom-experts.json'), JSON.stringify({ customExperts: [{ slug: 'custom-00000001', name: '误删专家', description: 'd', prompt: 'P', enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }))
    // 软删：deleted 软标 + wasEnabled 记忆（既有契约，回归锁）
    await remoteDeleteCustom(dst, 'custom-00000001', 0)
    const db = JSON.parse(readFileSync(join(dst, 'expert-sources', 'custom-experts.json'), 'utf-8'))
    assert.equal(db.customExperts.length, 1)
    assert.equal(db.customExperts[0].deleted, true)
    assert.equal(db.customExperts[0].wasEnabled, true)
    assert.equal(db.customExperts[0].enabled, false)
    // deleted slug 不可复活（saveCustom 走 missing 拒绝，Error.key 契约）
    await assert.rejects(
      () => remoteSaveCustom(dst, { slug: 'custom-00000001', name: '误删专家', description: 'd', prompt: 'P' }, true, 1),
      (e) => e.key === 'missing',
    )
    // 恢复语义=重建：同名新 slug 可建（duplicate 查重跳过 deleted 记录）
    await remoteSaveCustom(dst, { slug: 'custom-00000002', name: '误删专家', description: 'd', prompt: 'P' }, true, 1)
    const db2 = JSON.parse(readFileSync(join(dst, 'expert-sources', 'custom-experts.json'), 'utf-8'))
    assert.equal(db2.customExperts.length, 2)
    assert.equal(db2.customExperts.find((r) => r.slug === 'custom-00000002').deleted, undefined)
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})

test('T6 cleanupCustomDeleted: 清空软删记录 bump revision / 无实变不 bump / 乐观锁拒绝过期', async () => {
  const dst = mkdtempSync(join(tmpdir(), 't6-cleanup-'))
  try {
    mkdirSync(join(dst, 'expert-sources'), { recursive: true })
    writeFileSync(join(dst, 'expert-sources', 'sources.json'), JSON.stringify({ version: 1, revision: 3, mirrorPrefixes: null, dedup: { preferLang: null, choice: {} }, sources: [], mergedStateHash: '' }))
    writeFileSync(join(dst, 'expert-sources', 'custom-experts.json'), JSON.stringify({ customExperts: [
      { slug: 'live', name: '活着', description: 'd', prompt: 'P', enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { slug: 'gone', name: '已删', description: 'd', prompt: 'P', enabled: false, deleted: true, wasEnabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ] }))
    const snap = await remoteCleanupCustomDeleted(dst, 3)
    assert.equal(snap.revision, 4) // 实变 → bump
    const db = JSON.parse(readFileSync(join(dst, 'expert-sources', 'custom-experts.json'), 'utf-8'))
    assert.deepEqual(db.customExperts.map((r) => r.slug), ['live']) // 仅软删记录被清，活记录不动
    // 无实变 → revision 不 bump（对齐「choice already equal」惯例）
    const snap2 = await remoteCleanupCustomDeleted(dst, 4)
    assert.equal(snap2.revision, 4)
    // 乐观锁：过期 revision 拒绝
    await assert.rejects(() => remoteCleanupCustomDeleted(dst, 3), /expert sources state changed/)
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})

// ── WP-1 任务板并发正确性（v2.6）：taskboard.py 子进程级用例 (a)–(e) ───────
const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json') // 无遗留板时的默认板路径

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。 */
const runTb = (cwd, args) => {
  const r = spawnSync('python3', [TASKBOARD, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 非错误输出（多行人类可读）不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

/** 从输出提取（最新一个）revision=N。 */
const revOf = (out) => {
  const ms = [...out.matchAll(/revision=(\d+)/g)]
  assert.ok(ms.length > 0, `输出缺 revision=N：${JSON.stringify(out)}`)
  return Number(ms[ms.length - 1][1])
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `wp1-taskboard-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// (a) CAS revision 乐观锁：并发双写带旧 revision 的第二个写返回具名 stale_revision 且不落盘
test('WP-1 (a) CAS：旧 revision 的第二个写返回 stale_revision 且不落盘；读返回 revision；不带参数行为不变', (t) => {
  const dir = makeBoardDir(t, 'cas')
  let r = runTb(dir, ['create', '任务A'])
  assert.equal(r.code, 0)
  const rev0 = revOf(r.stdout)
  assert.ok(revOf(runTb(dir, ['list']).stdout) >= rev0) // 读命令末行返回 revision
  // 第一个写（带 rev0）成功
  r = runTb(dir, ['create', '任务B', '--expected-revision', String(rev0)])
  assert.equal(r.code, 0)
  const rev1 = revOf(r.stdout)
  assert.ok(rev1 > rev0)
  // 第二个写复用旧 revision → stale_revision，且板文件逐字节未变（不落盘）
  const boardPath = join(dir, BOARD_REL)
  const before = readFileSync(boardPath)
  const stale = runTb(dir, ['claim', 'T1', '某人', '--expected-revision', String(rev0)])
  assert.equal(stale.code, 1)
  assert.equal(stale.json.error, 'stale_revision')
  assert.equal(stale.json.expected, rev0)
  assert.equal(stale.json.current, rev1)
  assert.deepEqual(readFileSync(boardPath), before)
  // 不带 --expected-revision：行为与现状完全一致（照常写入成功）
  const compat = runTb(dir, ['claim', 'T1', '某人'])
  assert.equal(compat.code, 0)
  assert.equal(revOf(compat.stdout), rev1 + 1)
})

// (b) attempt 代际：旧 attempt_id 的 done/report 被拒并返回具名 stale_attempt
test('WP-1 (b) attempt 代际：旧代际 done/fail/progress 被拒；reassign 撤销旧代际；不带 --attempt 行为不变', (t) => {
  const dir = makeBoardDir(t, 'attempt')
  assert.equal(runTb(dir, ['create', '任务A']).code, 0)
  assert.equal(runTb(dir, ['claim', 'T1', '甲', '--attempt', 'A1']).code, 0)
  // 旧/错误代际的 done 被拒且不落盘
  const before = readFileSync(join(dir, BOARD_REL))
  const stale = runTb(dir, ['done', 'T1', '旧代际汇报', '--attempt', 'A0'])
  assert.equal(stale.code, 1)
  assert.equal(stale.json.error, 'stale_attempt')
  assert.equal(stale.json.attempt, 'A0')
  assert.equal(stale.json.current, 'A1')
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
  // 当前代际的 done/progress 正常
  assert.equal(runTb(dir, ['progress', 'T1', '检查点', '--attempt', 'A1']).code, 0)
  // 转派：reassign 先撤销旧代际，旧代际 progress 随后被拒
  assert.equal(runTb(dir, ['reassign', 'T1', 'A2', '--owner', '乙']).code, 0)
  const rej = runTb(dir, ['progress', 'T1', '旧代际检查点', '--attempt', 'A1'])
  assert.equal(rej.code, 1)
  assert.equal(rej.json.error, 'stale_attempt')
  assert.ok((rej.json.revoked || []).includes('A1'))
  assert.equal(runTb(dir, ['progress', 'T1', '新代际检查点', '--attempt', 'A2']).code, 0)
  // 兼容：任务有 attempt_id 但不带 --attempt → 行为与现状一致（照常 done）
  assert.equal(runTb(dir, ['done', 'T1', '结果', '--by', '甲']).code, 0)
})

// (c) 查询失败语义：损坏 JSON 后 list/show 返回 unrecoverable，stdout 无空任务列表
test('WP-1 (c) unrecoverable：损坏/结构非法的任务板 list/show 返回显式错误对象，绝不静默返回空列表', (t) => {
  const dir = makeBoardDir(t, 'corrupt')
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  writeFileSync(join(dir, BOARD_REL), '{not-json')
  for (const args of [['list'], ['show', 'T1'], ['status']]) {
    const r = runTb(dir, args)
    assert.equal(r.code, 1, args.join(' '))
    assert.equal(r.json.error, 'unrecoverable')
    assert.equal(r.json.unrecoverable, true) // 显式标记
    assert.ok(!r.stdout.includes('任务板为空')) // 绝不静默返回空列表
    assert.ok(typeof r.json.reason === 'string' && r.json.reason.length > 0)
  }
  // 结构合法 JSON 但非任务板（如 []）同样 unrecoverable
  writeFileSync(join(dir, BOARD_REL), '[]')
  const structural = runTb(dir, ['list'])
  assert.equal(structural.json.error, 'unrecoverable')
  assert.equal(structural.json.unrecoverable, true)
})

// (d) 依赖写入前全图环检测：A→B→C→A 被拒绝
test('WP-1 (d) 环检测：set_dependencies 构造 A→B→C→A 被拒且不落盘；无环写入正常', (t) => {
  const dir = makeBoardDir(t, 'cycle')
  for (const title of ['A', 'B', 'C']) assert.equal(runTb(dir, ['create', title]).code, 0)
  assert.equal(runTb(dir, ['set_dependencies', 'T2', '--dep', 'T1']).code, 0)
  assert.equal(runTb(dir, ['set_dependencies', 'T3', '--dep', 'T2']).code, 0)
  // 闭环写入被拒，T1 依赖不变
  const before = readFileSync(join(dir, BOARD_REL))
  const rej = runTb(dir, ['set_dependencies', 'T1', '--dep', 'T3'])
  assert.equal(rej.code, 1)
  assert.equal(rej.json.error, 'dependency_cycle')
  assert.ok(rej.json.cycle.startsWith('T1->') && rej.json.cycle.endsWith('->T1'), rej.json.cycle) // 完整环路径
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
  assert.ok(!runTb(dir, ['show', 'T1']).stdout.includes('dep=')) // T1 依赖未被写入
  // 无环写入正常（多依赖合法链）；自依赖同样被拒
  assert.equal(runTb(dir, ['set_dependencies', 'T3', '--dep', 'T2,T1']).code, 0)
  const self = runTb(dir, ['set_dependencies', 'T3', '--dep', 'T3'])
  assert.equal(self.code, 1)
  assert.equal(self.json.error, 'dependency_cycle')
})

// (e) 全程无第三方 import：taskboard.py 仅标准库
test('WP-1 (e) taskboard.py 零第三方 import（import 语句逐一落进标准库白名单）', () => {
  const src = readFileSync(TASKBOARD, 'utf-8')
  const stdlib = new Set(['argparse', 'collections', 'contextlib', 'datetime', 'fcntl', 'glob', 'json', 'os', 'sys', 'time', 'uuid'])
  const found = []
  for (const m of src.matchAll(/^\s*import\s+(.+)$/gm)) {
    for (const name of m[1].split(',')) found.push(name.trim().split(/\s+as\s+/)[0])
  }
  for (const m of src.matchAll(/^\s*from\s+([\w.]+)\s+import\s/g)) found.push(m[1])
  assert.ok(found.length >= 8, `应至少解析出既有 8 个标准库 import，实际 ${JSON.stringify(found)}`)
  for (const name of found) {
    assert.ok(stdlib.has(name), `非标准库 import：${name}`)
  }
})

// WP-1 兼容回归：现有协议文本里的全部 taskboard.py 调用方式（不传新参数）行为零变化
test('WP-1 兼容回归：SKILL.md 第 9 节既有调用方式不传新参数时全流程行为不变', (t) => {
  const dir = makeBoardDir(t, 'compat')
  const ok = (...args) => { const r = runTb(dir, args); assert.equal(r.code, 0, args.join(' ')); return r }
  ok('create', '子任务', '--owner', '后端工程师', '--desc', '完成标准')       // T1
  ok('create', '下游任务', '--dep', 'T1', '--owner', 'DevOps自动化工程师')    // T2（依赖 T1，pending）
  ok('status'); ok('list'); ok('show', 'T1'); ok('deps', 'T2')
  ok('claim', 'T1', '后端工程师')
  ok('progress', 'T1', '已完成X；产物:路径')
  ok('done', 'T1', '结果摘要')                                              // T2 自动转 ready
  const st = ok('status').stdout
  assert.ok(st.includes('可认领: T2'), st)
  ok('claim', 'T2'); ok('fail', 'T2', '原因'); ok('retry', 'T2'); ok('claim', 'T2'); ok('done', 'T2', '结果摘要', '--rework', '1', '--switched', '--by', 'DevOps自动化工程师')
  ok('metrics'); ok('recover'); ok('boards')
})

// (a2) 真并发双写（评审项 🔴2）：两个进程同时写同一板（均携带旧 revision），恰好一成一拒、板文件完好。
// 说明：两个进程都在任一写入生效前启动并携带 rev0，因此后落盘者必然命中 stale_revision，断言与调度时序无关。
const spawnTbAsync = (cwd, args) =>
  new Promise((resolve) => {
    const p = spawn('python3', [TASKBOARD, ...args], { cwd })
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })

test('WP-1 (a2) 真并发 CAS 双写：两进程同时写同一板，恰好一个成功一个 stale_revision，板文件完好无截断', async (t) => {
  const dir = makeBoardDir(t, 'conc-cas')
  const r0 = runTb(dir, ['create', '任务A'])
  assert.equal(r0.code, 0)
  const rev0 = revOf(r0.stdout)
  const [w1, w2] = await Promise.all([
    spawnTbAsync(dir, ['create', '并发写1', '--expected-revision', String(rev0)]),
    spawnTbAsync(dir, ['create', '并发写2', '--expected-revision', String(rev0)]),
  ])
  const codes = [w1.code, w2.code].sort((a, b) => a - b)
  assert.deepEqual(codes, [0, 1], `w1=${w1.code}/${w1.stdout} w2=${w2.code}/${w2.stdout}`)
  const loser = w1.code === 1 ? w1 : w2
  assert.equal(JSON.parse(loser.stdout.trim()).error, 'stale_revision')
  assert.ok(!loser.stderr.includes('Traceback'), loser.stderr) // 具名错误，绝不裸 traceback
  // 板文件完好：合法 JSON、恰好一次写入生效（revision 精确 +1、恰好 2 个任务）
  const board = JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
  assert.equal(board.revision, rev0 + 1)
  assert.equal(Object.keys(board.tasks).length, 2)
})

test('WP-1 (a3) 真并发双写（无 CAS）：两写经锁串行化均成功，revision 精确 +2，板文件完好', async (t) => {
  const dir = makeBoardDir(t, 'conc-nocas')
  const r0 = runTb(dir, ['create', '任务A'])
  assert.equal(r0.code, 0)
  const rev0 = revOf(r0.stdout)
  const [w1, w2] = await Promise.all([
    spawnTbAsync(dir, ['create', '并发写1']),
    spawnTbAsync(dir, ['create', '并发写2']),
  ])
  assert.equal(w1.code, 0, w1.stderr)
  assert.equal(w2.code, 0, w2.stderr)
  assert.ok(!w1.stderr.includes('Traceback') && !w2.stderr.includes('Traceback'))
  const board = JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
  assert.equal(board.revision, rev0 + 2) // 两写都落盘且 revision 无丢失更新
  assert.equal(Object.keys(board.tasks).length, 3)
})

// (b2) 汇报 fail-closed（评审项 🟡5）+ fail 路径代际校验（💭）+ claim/reassign 拒绝已撤销代际（评审项 🟡3）
test('WP-1 (b2) attempt fail-closed：无开放代际时带 --attempt 汇报被拒（no_attempt）；fail 旧代际被拒；claim/reassign 复用已撤销代际被拒', (t) => {
  const dir = makeBoardDir(t, 'attempt-fc')
  assert.equal(runTb(dir, ['create', '任务A']).code, 0)
  assert.equal(runTb(dir, ['claim', 'T1', '甲']).code, 0) // 无 attempt_id 认领（兼容路径）
  const before = readFileSync(join(dir, BOARD_REL))
  // fail-closed：任务无开放代际，带 --attempt 的汇报一律具名拒绝、不落盘
  for (const args of [['done', 'T1', 'x', '--attempt', 'A9'], ['fail', 'T1', 'x', '--attempt', 'A9'], ['progress', 'T1', 'x', '--attempt', 'A9']]) {
    const r = runTb(dir, args)
    assert.equal(r.code, 1, args.join(' '))
    assert.equal(r.json.error, 'no_attempt')
    assert.equal(r.json.attempt, 'A9')
  }
  assert.deepEqual(readFileSync(join(dir, BOARD_REL)), before)
  // 兼容：不带 --attempt 行为与旧版一致
  assert.equal(runTb(dir, ['done', 'T1', '结果']).code, 0)
  // 换 T2 验证代际撤销链路：claim 复用已撤销代际被拒；reassign 复活已撤销代际被拒（旧代际汇报 exit 0 缺口）
  assert.equal(runTb(dir, ['create', '任务B']).code, 0)
  assert.equal(runTb(dir, ['claim', 'T2', '乙', '--attempt', 'B1']).code, 0)
  assert.equal(runTb(dir, ['reassign', 'T2', 'B2']).code, 0) // 撤销 B1
  const revive = runTb(dir, ['reassign', 'T2', 'B1'])
  assert.equal(revive.code, 1)
  assert.equal(revive.json.error, 'stale_attempt')
  assert.ok((revive.json.revoked || []).includes('B1'))
  assert.equal(JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8')).tasks.T2.attempt_id, 'B2') // 未被复活
  // fail 路径：旧/已撤销代际同样被拒（💭 补 fail 用例）
  const staleFail = runTb(dir, ['fail', 'T2', '原因', '--attempt', 'B1'])
  assert.equal(staleFail.code, 1)
  assert.equal(staleFail.json.error, 'stale_attempt')
  assert.ok((staleFail.json.revoked || []).includes('B1'))
  assert.equal(runTb(dir, ['fail', 'T2', '原因', '--attempt', 'B2']).code, 0) // 当前代际正常
  // retry 后 ready，claim 已撤销代际被拒、当前代际可重新认领
  assert.equal(runTb(dir, ['retry', 'T2']).code, 0)
  const claimRevoked = runTb(dir, ['claim', 'T2', '丙', '--attempt', 'B1'])
  assert.equal(claimRevoked.code, 1)
  assert.equal(claimRevoked.json.error, 'stale_attempt')
  assert.equal(runTb(dir, ['claim', 'T2', '丙', '--attempt', 'B2']).code, 0)
})

// (c2) 深层结构损坏（评审项 🟡4）：tasks 条目非对象等深层损坏，全部命令路径返回 unrecoverable JSON
test('WP-1 (c2) 深层损坏：tasks 条目非对象/dep 非列表/seq 非整数 → 所有命令 unrecoverable，boards 标注损坏无 traceback', (t) => {
  const dir = makeBoardDir(t, 'corrupt-deep')
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  const boardPath = join(dir, BOARD_REL)
  const shapes = [
    ['tasks 条目为字符串', JSON.stringify({ tasks: { T1: 'not-an-object' }, seq: 1 })],
    ['dep 非列表', JSON.stringify({ tasks: { T1: { id: 'T1', title: 'x', status: 'running', dep: 'T2' } }, seq: 1 })],
    ['seq 非整数', JSON.stringify({ tasks: {}, seq: 'x' })],
    ['任务缺 status', JSON.stringify({ tasks: { T1: { id: 'T1', title: 'x', dep: [] } }, seq: 1 })],
  ]
  const cmds = [['list'], ['show', 'T1'], ['status'], ['deps', 'T1'], ['claim', 'T1'], ['done', 'T1'],
    ['fail', 'T1'], ['progress', 'T1', 'n'], ['retry', 'T1'], ['recover'], ['metrics'],
    ['set_dependencies', 'T1', '--dep', 'T1'], ['reassign', 'T1', 'A1'], ['archive'], ['create', 'x']]
  for (const [label, content] of shapes) {
    writeFileSync(boardPath, content)
    for (const args of cmds) {
      const r = runTb(dir, args)
      assert.equal(r.code, 1, `${label} | ${args.join(' ')} | stdout=${r.stdout}`)
      assert.equal(r.json.error, 'unrecoverable', `${label} | ${args.join(' ')}`)
      assert.equal(r.json.unrecoverable, true)
      assert.ok(!r.stderr.includes('Traceback'), `${label} | ${args.join(' ')} | ${r.stderr}`)
    }
  }
  // boards：对损坏板逐条标注（损坏），exit 0 且不裸 traceback
  writeFileSync(boardPath, '{"tasks": {"T1": "oops"}, "seq": 1}')
  const b = runTb(dir, ['boards'])
  assert.equal(b.code, 0)
  assert.ok(b.stdout.includes('（损坏）'), b.stdout)
  assert.ok(!b.stderr.includes('Traceback'), b.stderr)
})

// (f) 无 fcntl 降级路径（评审项 🔴1 降级要求）：TASKBOARD_DISABLE_FLOCK=1 时功能可用、写入原子、无 tmp/lock 残留
test('WP-1 (f) 降级路径（TASKBOARD_DISABLE_FLOCK=1）：CAS 仍生效、流程可用、板目录无 *.tmp/*.lock 残留', (t) => {
  const dir = makeBoardDir(t, 'nolock')
  const env = { ...process.env, TASKBOARD_DISABLE_FLOCK: '1' }
  const run = (args) => {
    const r = spawnSync('python3', [TASKBOARD, ...args], { cwd: dir, encoding: 'utf-8', env })
    let json = null
    try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出 */ }
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
  }
  const r0 = run(['create', '任务A'])
  assert.equal(r0.code, 0)
  const rev0 = revOf(r0.stdout)
  // 降级模式下 CAS 校验逻辑本身仍工作（单进程语义不变）：先写入 bump revision，旧 revision 的写被拒
  assert.equal(run(['claim', 'T1', '甲']).code, 0)
  const stale = run(['progress', 'T1', 'x', '--expected-revision', String(rev0)])
  assert.equal(stale.code, 1)
  assert.equal(stale.json.error, 'stale_revision')
  const rev1 = revOf(run(['list']).stdout)
  assert.equal(rev1, rev0 + 1)
  assert.equal(run(['progress', 'T1', '检查点', '--expected-revision', String(rev1)]).code, 0)
  // 板目录无 .tmp / .lock 残留（唯一 tmp 名写完即 replace；降级模式不建锁文件）
  const files = readdirSync(join(dir, '.expert-taskboards'))
  assert.ok(files.every((f) => !f.endsWith('.tmp') && !f.endsWith('.lock')), JSON.stringify(files))
})

// ── WP-2 消息总线投递语义升级（v2.6）：bus.py 子进程级用例 (a)–(d) ─────────
const BUS = fileURLToPath(new URL('../skills/expert-orchestration/tools/bus.py', import.meta.url))
const BUS_REL = join('.expert-bus')

/** 执行 bus.py（cwd 隔离到临时目录，可注入环境变量）；stdout 单行 JSON 时解析为 json 字段。 */
const runBus = (cwd, args, env = {}) => {
  const r = spawnSync('python3', [BUS, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...env } })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 非错误输出（多行人类可读）不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBusDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `wp2-bus-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 读取一个信箱的全部消息（id + 全文）。 */
const boxMsgs = (dir, box) => {
  const d = join(dir, BUS_REL, box)
  return readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(d, n), 'utf-8')))
}

/** 写一个最小合法任务板（供代际对账）。 */
const writeBusBoard = (dir, tasks) => {
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  writeFileSync(join(dir, '.expert-taskboards', 'default.json'), JSON.stringify({ tasks, seq: 1, revision: 0 }))
}

const outboxNames = (dir, sender) =>
  readdirSync(join(dir, BUS_REL, '_outbox', sender)).filter((n) => n.endsWith('.json') && n !== 'cursor.json').sort()
const cursorOf = (dir, sender) =>
  JSON.parse(readFileSync(join(dir, BUS_REL, '_outbox', sender, 'cursor.json'), 'utf-8')).cursor

// (a) at-least-once 游标：投递中途崩溃重启后同一条消息按同 id 重投；游标仅在成功回执后前进
test('WP-2 (a) at-least-once 游标：崩溃重启后同 id 幂等重投、游标仅在成功回执后前进、已 ack 消息重投不复活未读', (t) => {
  const dir = makeBusDir(t, 'cursor')
  const send = (subj, env = {}) =>
    runBus(dir, ['send', '--from', '甲', '--to', 'coordinator', '--subject', subj, '--body', 'b'], env)
  // 正常路径：收件箱落盘 + 游标推进到该条目
  let r = send('s1')
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('已投递'), r.stdout)
  assert.equal(outboxNames(dir, '甲').length, 1)
  assert.equal(cursorOf(dir, '甲'), outboxNames(dir, '甲')[0])
  // 崩溃注入：收件箱已落盘、游标未前进（投递成功但未收到回执）
  const crash = send('s2', { BUS_CRASH_AFTER_DELIVER: '1' })
  assert.equal(crash.code, 70)
  assert.ok(!crash.stderr.includes('Traceback'), crash.stderr)
  assert.equal(boxMsgs(dir, 'coordinator').length, 2)
  assert.equal(cursorOf(dir, '甲'), outboxNames(dir, '甲')[0]) // 游标停在 s1
  // 重启（全新进程）：s2 按同 id 原子重投（不产生重复消息），游标前进越过 s2
  r = send('s3')
  assert.equal(r.code, 0)
  const ids = boxMsgs(dir, 'coordinator').map((m) => m.id)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3) // 同 id 重投幂等
  assert.equal(cursorOf(dir, '甲'), outboxNames(dir, '甲')[2])
  // 失败路径：游标未推进期间消息被 ack，重投不复活未读标记
  const s4 = send('s4', { BUS_CRASH_AFTER_DELIVER: '1' })
  assert.equal(s4.code, 70)
  const beforeAck = boxMsgs(dir, 'coordinator').find((m) => m.subject === 's4')
  assert.equal(runBus(dir, ['ack', '--box', 'coordinator', '--id', beforeAck.id]).code, 0)
  assert.equal(send('s5').code, 0) // 重启：s4 重投
  const after = boxMsgs(dir, 'coordinator').find((m) => m.subject === 's4')
  assert.equal(after.id, beforeAck.id) // 同一条消息
  assert.equal(after.read, true) // 未被复活为未读
  assert.equal(cursorOf(dir, '甲'), outboxNames(dir, '甲')[4])
})

// (b) 过代过滤：携带已撤销/过期 attempt 的消息读取时归档、不进 inbox；板不可读 unrecoverable；开关可关
test('WP-2 (b) 过代过滤：已撤销/非当前代际消息归档不进 inbox；板缺失/损坏返回 unrecoverable 且不静默处置；--no-attempt-filter 可关', (t) => {
  const dir = makeBusDir(t, 'attempt')
  writeBusBoard(dir, {
    T1: { id: 'T1', title: 'x', status: 'running', dep: [], attempt_id: 'A1', attempt_revoked: ['A0'] },
    T2: { id: 'T2', title: 'y', status: 'running', dep: [], attempt_id: 'B1', attempt_revoked: [] },
  })
  const send = (subj, task, att) => {
    const extra = task ? ['--task', task, '--attempt', att] : []
    const r = runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', subj, '--body', 'b', ...extra])
    assert.equal(r.code, 0, r.stdout) // send 不读板；对账只发生在读取时
    return r
  }
  send('旧代际', 'T1', 'A0') // attempt_revoked → 过期
  send('当前代际', 'T2', 'B1') // 开放代际 → 保留
  send('普通消息') // 无代际引用 → 不过滤
  const r = runBus(dir, ['read', '--box', 'coordinator'])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('当前代际') && r.stdout.includes('普通消息'), r.stdout)
  assert.ok(!r.stdout.includes('旧代际'), r.stdout) // 不进收件箱
  assert.ok(r.stdout.includes('已归档过期消息'), r.stdout)
  assert.equal(boxMsgs(dir, 'coordinator').length, 2)
  const archiveDir = join(dir, BUS_REL, '_archive', 'coordinator')
  assert.equal(readdirSync(archiveDir).length, 1)
  const archived = JSON.parse(readFileSync(join(archiveDir, readdirSync(archiveDir)[0]), 'utf-8'))
  assert.equal(archived.attempt_id, 'A0')
  // 板损坏：读取返回 unrecoverable（exit 1），消息不归档不丢弃（不做静默假设）
  const broken = makeBusDir(t, 'attempt-broken')
  mkdirSync(join(broken, '.expert-taskboards'), { recursive: true })
  writeFileSync(join(broken, '.expert-taskboards', 'default.json'), '{not-json')
  runBus(broken, ['send', '--from', '丙', '--to', 'coordinator', '--subject', '待对账', '--body', 'b', '--task', 'T1', '--attempt', 'A9'])
  const bad = runBus(broken, ['read', '--box', 'coordinator'])
  assert.equal(bad.code, 1)
  assert.equal(bad.json.error, 'unrecoverable')
  assert.equal(bad.json.unrecoverable, true)
  assert.ok(typeof bad.json.reason === 'string' && bad.json.reason.length > 0)
  assert.ok(!bad.stderr.includes('Traceback'), bad.stderr)
  assert.equal(boxMsgs(broken, 'coordinator').length, 1) // 未归档未丢弃
  // 板缺失：同样 unrecoverable（消息引用了代际却不给板，不做静默假设）
  const noboard = makeBusDir(t, 'attempt-noboard')
  runBus(noboard, ['send', '--from', '丙', '--to', 'coordinator', '--subject', '待对账', '--body', 'b', '--task', 'T1', '--attempt', 'A9'])
  const missing = runBus(noboard, ['read', '--box', 'coordinator'])
  assert.equal(missing.code, 1)
  assert.equal(missing.json.error, 'unrecoverable')
  assert.equal(boxMsgs(noboard, 'coordinator').length, 1)
  // 关闭开关：回到旧版读取行为（不读板、不过滤、不归档）
  const off = runBus(noboard, ['read', '--box', 'coordinator', '--no-attempt-filter'])
  assert.equal(off.code, 0)
  assert.ok(off.stdout.includes('待对账'), off.stdout)
  // send 侧成对校验：只给其一被拒
  const half = runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', 'x', '--body', 'b', '--task', 'T1'])
  assert.equal(half.code, 1)
  assert.ok(half.stderr.includes('--task 与 --attempt 必须成对提供'), half.stderr)
})

// (c) skip-round：收件箱仅含过期消息时输出显式 SKIP_ROUND；空信箱与普通无未读行为不变
test('WP-2 (c) skip-round：信箱本轮可见消息为空且归档了过期消息时输出 SKIP_ROUND；真空信箱保持旧文案', (t) => {
  const dir = makeBusDir(t, 'skip')
  writeBusBoard(dir, { T1: { id: 'T1', title: 'x', status: 'running', dep: [], attempt_id: 'A1', attempt_revoked: [] } })
  // 仅过期消息 → SKIP_ROUND，收件箱归空
  assert.equal(runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', '过期', '--body', 'b', '--task', 'T1', '--attempt', 'A0']).code, 0)
  const r = runBus(dir, ['read', '--box', 'coordinator'])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('SKIP_ROUND'), r.stdout)
  assert.ok(r.stdout.includes('可跳过该轮'), r.stdout)
  // 💭3 措辞与判定对齐：可见为空的原因可能是已读而非全过期，不断言「全部过期」
  assert.ok(r.stdout.includes('本轮无可见消息'), r.stdout)
  assert.ok(r.stdout.includes('已归档 1 封过期消息'), r.stdout)
  assert.ok(!r.stdout.includes('全部过期'), r.stdout)
  assert.ok(!r.stdout.includes('（信箱 coordinator 无消息）'), r.stdout)
  assert.equal(readdirSync(join(dir, BUS_REL, 'coordinator')).length, 0)
  // 归档后再读：真空信箱 → 旧文案，无 SKIP_ROUND
  const empty = runBus(dir, ['read', '--box', 'coordinator'])
  assert.ok(empty.stdout.includes('（信箱 coordinator 无消息）'), empty.stdout)
  assert.ok(!empty.stdout.includes('SKIP_ROUND'), empty.stdout)
  // --unread：已读正常消息 + 未读过期消息 → 本轮无有效输入 → SKIP_ROUND
  assert.equal(runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', '正常', '--body', 'b']).code, 0)
  assert.equal(runBus(dir, ['ack', '--box', 'coordinator', '--all']).code, 0)
  assert.equal(runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', '过期2', '--body', 'b', '--task', 'T1', '--attempt', 'A0']).code, 0)
  const ur = runBus(dir, ['read', '--box', 'coordinator', '--unread'])
  assert.equal(ur.code, 0)
  assert.ok(ur.stdout.includes('SKIP_ROUND'), ur.stdout)
  assert.ok(!ur.stdout.includes('正常'), ur.stdout) // 已读消息不展示，也不阻止 skip-round 判定
  // 💭3：--unread 混合场景（已读消息 + 过期消息）下「全部过期」措辞不准确，须与新判定一致
  assert.ok(!ur.stdout.includes('全部过期'), ur.stdout)
  assert.ok(ur.stdout.includes('已归档 1 封过期消息'), ur.stdout)
})

// (d) 零第三方 import + 既有调用方式回归（SKILL.md 第 9 节 bus.py 全部既有调用不传新参数行为不变）
test('WP-2 (d) bus.py 零第三方 import（import 落进标准库白名单）+ 既有调用方式全流程回归', (t) => {
  const src = readFileSync(BUS, 'utf-8')
  const stdlib = new Set(['argparse', 'json', 'os', 'random', 'sys', 'time'])
  const found = []
  for (const m of src.matchAll(/^\s*import\s+(.+)$/gm)) {
    for (const name of m[1].split(',')) found.push(name.trim().split(/\s+as\s+/)[0])
  }
  for (const m of src.matchAll(/^\s*from\s+([\w.]+)\s+import\s/g)) found.push(m[1])
  assert.ok(found.length >= 6, `应至少解析出既有 6 个标准库 import，实际 ${JSON.stringify(found)}`)
  for (const name of found) {
    assert.ok(stdlib.has(name), `非标准库 import：${name}`)
  }
  // 既有调用回归：send / read [--box|--unread|--all-boxes] / ack [--id|--all] / broadcast / stats
  const dir = makeBusDir(t, 'compat')
  const ok = (...args) => { const r = runBus(dir, args); assert.equal(r.code, 0, `${args.join(' ')}\n${r.stderr}`); return r }
  ok('send', '--from', '后端工程师', '--to', 'coordinator', '--subject', '登录页完成', '--body', '完整产出', '--file', '产物.md')
  ok('send', '--from', '后端工程师', '--to', 'coordinator', '--subject', '第二封', '--body', 'b2')
  const r1 = ok('read', '--box', 'coordinator')
  assert.ok(r1.stdout.includes('--- ') && r1.stdout.includes('[未读] from=后端工程师 subject=登录页完成'), r1.stdout)
  assert.ok(r1.stdout.includes('附件: ' + join(dir, '产物.md')), r1.stdout)
  const r2 = ok('read', '--box', 'coordinator', '--unread') // read 不置已读 → 未读仍在
  assert.equal((r2.stdout.match(/--- /g) || []).length, 2)
  const firstId = boxMsgs(dir, 'coordinator').map((m) => m.id)[0]
  ok('ack', '--box', 'coordinator', '--id', firstId)
  const r3 = ok('read', '--box', 'coordinator', '--unread')
  assert.equal((r3.stdout.match(/--- /g) || []).length, 1) // 只剩第二封
  assert.ok(!r3.stdout.includes('登录页完成'), r3.stdout)
  ok('ack', '--box', 'coordinator', '--all')
  const all1 = ok('read', '--all-boxes') // _outbox 等内部目录不得作为信箱列出
  assert.ok(all1.stdout.includes('== 信箱 coordinator =='), all1.stdout)
  assert.ok(!all1.stdout.includes('_outbox') && !all1.stdout.includes('_archive'), all1.stdout)
  ok('broadcast', '--from', '协调官', '--subject', '通告', '--body', '全员可见')
  assert.equal(boxMsgs(dir, 'coordinator').length, 3) // 广播照常到达既有信箱
  const st = ok('stats').stdout
  assert.ok(st.includes('coordinator: 共 3 封，未读 1'), st) // 2 封已 ack + 广播 1 封未读
  assert.ok(!st.includes('_outbox') && !st.includes('_archive'), st)
})

// (e) 毒丸自愈（评审项 🔴1）：发件箱截断残件（旧版裸 open('w') 写中间态崩溃窗口的产物）不阻塞后续 send
test('WP-2 (e) 毒丸自愈：outbox 截断残件与 .tmp 残件均无害，下一次 send 照常成功，残件被隔离 .corrupt', (t) => {
  const dir = makeBusDir(t, 'poison')
  // 正常 send 一封建立游标
  assert.equal(runBus(dir, ['send', '--from', '甲', '--to', 'coordinator', '--subject', 's1', '--body', 'b']).code, 0)
  const outbox = join(dir, BUS_REL, '_outbox', '甲')
  // 注入「崩溃于写中间态」现场：旧版非原子写留下的截断 JSON（合法命名、非法内容，ts 在游标之后）
  writeFileSync(join(outbox, '9999999999999-mcrash999.json'), '{"id": "mcrash')
  // 新版唯一 tmp 崩溃窗口同样只留 .tmp 残件：任何后续读取路径都不得被它卡住
  writeFileSync(join(outbox, '8888888888888-mtmp888.json.12345.abcdef01.tmp'), '{')
  // 下一次 send 仍成功：截断残件被自愈隔离，新消息正常落盘并投递
  const r = runBus(dir, ['send', '--from', '甲', '--to', 'coordinator', '--subject', 's2', '--body', 'b'])
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`) // 修复前此处 json.load 抛异常 → 该发送者永久 exit 1
  assert.ok(r.stdout.includes('已投递'), r.stdout)
  assert.ok(r.stderr.includes('截断残件已隔离'), r.stderr) // 自愈有显式告警，不静默吞
  assert.equal(boxMsgs(dir, 'coordinator').length, 2) // s1 + s2，截断残件从未进收件箱
  // 残件已移出 .json 投递队列（.corrupt 后缀），.tmp 残件不动（无害）
  const names = readdirSync(outbox)
  assert.ok(names.some((n) => n.endsWith('.corrupt')), JSON.stringify(names))
  assert.equal(names.filter((n) => n.endsWith('.json') && n !== 'cursor.json').length, 2, JSON.stringify(names))
  // 再 send 一次：无重复告警（残件只处理一次），通道持续可用
  const r2 = runBus(dir, ['send', '--from', '甲', '--to', 'coordinator', '--subject', 's3', '--body', 'b'])
  assert.equal(r2.code, 0, `${r2.stdout}\n${r2.stderr}`)
  assert.ok(!r2.stderr.includes('截断'), r2.stderr)
  assert.equal(boxMsgs(dir, 'coordinator').length, 3)
})

// (f) flush 补投路径（评审项 🔴1 配套）：发件箱已落盘但投递中断（游标落后）时，下一次 send 触发 flush 按序补投
test('WP-2 (f) flush 补投：游标落后的挂起条目在下一次 send 时按序补投进收件箱，游标推进到最新且不重复投递', (t) => {
  const dir = makeBusDir(t, 'flush-redeliver')
  assert.equal(runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', 's1', '--body', 'b']).code, 0)
  // 模拟「发件箱已落盘、投递中断」现场：向发件箱直写两条合法挂起条目。
  // ts 取既有最大条目名之后的连续值（真实场景发件箱按时间戳单调追加，夹具保持同一不变量）
  const outbox = join(dir, BUS_REL, '_outbox', '乙')
  const lastTs = Number(outboxNames(dir, '乙').at(-1).split('-')[0])
  const pending = [
    { id: 'mpending001', from: '乙', to: 'coordinator', subject: '待补投1', body: 'b', files: [], ts: lastTs + 1, read: false },
    { id: 'mpending002', from: '乙', to: 'coordinator', subject: '待补投2', body: 'b', files: [], ts: lastTs + 2, read: false },
  ]
  for (const m of pending) writeFileSync(join(outbox, `${String(m.ts).padStart(13, '0')}-${m.id}.json`), JSON.stringify(m))
  // 下一次 send：flush 先按序补投两条挂起消息，再投递本条新消息
  const r = runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', 's2', '--body', 'b'])
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  const msgs = boxMsgs(dir, 'coordinator')
  assert.deepEqual(msgs.map((m) => m.subject).sort(), ['s1', 's2', '待补投1', '待补投2'], JSON.stringify(msgs.map((m) => m.subject)))
  assert.equal(new Set(msgs.map((m) => m.id)).size, 4) // 全程无重复投递（含挂起条目自身）
  // 游标推进到最新条目（补投完成后无积压）
  assert.equal(cursorOf(dir, '乙'), outboxNames(dir, '乙').at(-1))
  // 再次 send：已补投条目不重复进收件箱（游标幂等；同发送者新消息照常追加）
  assert.equal(runBus(dir, ['send', '--from', '乙', '--to', 'coordinator', '--subject', 's3', '--body', 'b']).code, 0)
  const after = boxMsgs(dir, 'coordinator')
  assert.ok(after.filter((m) => m.subject === '待补投1').length === 1 && after.filter((m) => m.subject === '待补投2').length === 1)
  assert.equal(cursorOf(dir, '乙'), outboxNames(dir, '乙').at(-1))
})

// (g) ack 原子写（评审回炉第2轮 🔴）：cmd_ack 裸 open('w') 写收件箱一旦中途崩溃即截断消息——
// 收件箱是已投递消息的唯一副本，截断一封即整箱 read/stats 永久 unrecoverable（与毒丸同类）。
// 修复后 ack 复用 write_json_atomic：注入「ack 写中间态崩溃」后消息文件完好、read/stats 仍可用；
// 遗留截断残件仍按既有损坏语义显式 unrecoverable（唯一副本不静默丢）；静态守卫锁死全文件无其他裸写点。
test('WP-2 (g) ack 原子写：ack 写中途崩溃不截断收件箱消息，read/stats 仍可用且可重试 ack；遗留截断残件按既有 unrecoverable 语义处置', (t) => {
  // 场景 A：注入「ack 写中间态崩溃」——json.dump 写 .tmp 中间文件时 os._exit(70)（模拟进程死亡，跳过一切清理）
  const dir = makeBusDir(t, 'ack-atomic')
  assert.equal(runBus(dir, ['send', '--from', '甲', '--to', 'coordinator', '--subject', 's1', '--body', 'b']).code, 0)
  assert.equal(runBus(dir, ['send', '--from', '甲', '--to', 'coordinator', '--subject', 's2', '--body', 'b']).code, 0)
  const target = boxMsgs(dir, 'coordinator').find((m) => m.subject === 's1')
  const crashDriver = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../skills/expert-orchestration/tools/', import.meta.url)))})
sys.argv = ['bus.py', '--root', ${JSON.stringify(join(dir, BUS_REL))}, 'ack', '--box', 'coordinator', '--id', ${JSON.stringify(target.id)}]
import bus
real_dump = json.dump
once = {'hit': False}
def crashy_dump(obj, fp, **kw):
    # 仅拦 ack 回写收件箱的 .tmp 中间文件首次调用：写一半就崩溃（等价旧版裸写最坏中间态）
    if fp.name.endswith('.tmp') and not once['hit']:
        once['hit'] = True
        fp.write('{"id": "trunc')
        fp.flush()
        os._exit(70)
    return real_dump(obj, fp, **kw)
json.dump = crashy_dump
bus.main()
`
  const crash = spawnSync('python3', ['-c', crashDriver], { cwd: dir, encoding: 'utf-8' })
  assert.equal(crash.status, 70) // 注入生效：确实死在写中间态
  assert.ok(!crash.stderr.includes('Traceback'), crash.stderr)
  // 目标消息文件完好：仍是完整合法 JSON、内容未被截断、read 标记未落盘（ack 可幂等重试）
  const targetFile = `${String(target.ts).padStart(13, '0')}-${target.id}.json`
  const afterCrash = JSON.parse(readFileSync(join(dir, BUS_REL, 'coordinator', targetFile), 'utf-8'))
  assert.equal(afterCrash.id, target.id)
  assert.equal(afterCrash.read, false)
  assert.equal(afterCrash.subject, 's1')
  // read/stats 仍可用（修复前裸写截断后此处整箱永久 exit 1 unrecoverable）
  const rd = runBus(dir, ['read', '--box', 'coordinator'])
  assert.equal(rd.code, 0, `${rd.stdout}\n${rd.stderr}`)
  assert.ok(rd.stdout.includes('subject=s1') && rd.stdout.includes('[未读]'), rd.stdout)
  const st = runBus(dir, ['stats'])
  assert.equal(st.code, 0, `${st.stdout}\n${st.stderr}`)
  assert.ok(st.stdout.includes('coordinator: 共 2 封，未读 2'), st.stdout)
  // .tmp 残件无害（既有语义：唯一 tmp 崩溃窗口只留残件），ack 重试成功且 read/stats 持续可用
  const boxFiles = readdirSync(join(dir, BUS_REL, 'coordinator'))
  assert.ok(boxFiles.some((n) => n.endsWith('.tmp')), JSON.stringify(boxFiles))
  assert.equal(runBus(dir, ['ack', '--box', 'coordinator', '--id', target.id]).code, 0)
  const rd2 = runBus(dir, ['read', '--box', 'coordinator', '--unread'])
  assert.equal(rd2.code, 0)
  assert.ok(!rd2.stdout.includes('subject=s1'), rd2.stdout) // s1 已读不再展示，s2 仍在
  assert.ok(rd2.stdout.includes('subject=s2'), rd2.stdout)

  // 场景 B：遗留截断残件（旧版裸写或外部截断的产物）按既有损坏语义处置——显式 unrecoverable，不静默丢、不裸 traceback
  const broken = makeBusDir(t, 'ack-atomic-legacy')
  assert.equal(runBus(broken, ['send', '--from', '甲', '--to', 'coordinator', '--subject', 'good', '--body', 'b']).code, 0)
  writeFileSync(join(broken, BUS_REL, 'coordinator', '9999999999999-mtrunc999.json'), '{"id": "mtrunc')
  const rdB = runBus(broken, ['read', '--box', 'coordinator'])
  assert.equal(rdB.code, 1)
  assert.equal(rdB.json.error, 'unrecoverable')
  assert.equal(rdB.json.unrecoverable, true)
  assert.ok(!rdB.stderr.includes('Traceback'), rdB.stderr)
  const stB = runBus(broken, ['stats'])
  assert.equal(stB.code, 1)
  assert.equal(stB.json.unrecoverable, true)
  assert.ok(!stB.stderr.includes('Traceback'), stB.stderr)
  assert.equal(readdirSync(join(broken, BUS_REL, 'coordinator')).filter((n) => n.endsWith('.json')).length, 2) // 唯一副本不静默丢

  // 静态守卫：全文件无 write_json_atomic 之外的裸 JSON 落盘点（open(.., 'w'/'wb') 唯一命中 write_json_atomic 内部写唯一 tmp；无 write_bytes/流式 .write( 落盘）
  const src = readFileSync(BUS, 'utf-8')
  const bareWrites = [...src.matchAll(/open\(\s*[\w.()[\]]+\s*,\s*['"]w[b+]*['"]/g)].map((m) => m[0])
  assert.equal(bareWrites.length, 1, JSON.stringify(bareWrites))
  assert.ok(bareWrites[0].includes('tmp'), '唯一 open(w) 应是 write_json_atomic 写唯一 tmp')
  assert.ok(!/write_bytes|\.write\(/.test(src), 'bus.py 不得出现 write_bytes 或流式 .write( 落盘')
})

// ── WP-4a 派工即回写（auto-claim）：派发入口先 claim、后跑专家（回炉第 1 轮）──
// 单元：parseTaskIds（显式 token + 命令引述/路径形态排除 + 8 上限，宁漏勿错）
// / locateAutoClaimBoard（唯一板）。
// 集成：registerExpertTools + mock provider + 真实 taskboard.py 子进程，覆盖
// (a) 委派成功→自动 running+owner，且时序可观测：provider start 时板已 running
// （含 owner 已有不覆盖、done 跳过、不存在 id 提示）
// (b) 无板/板损坏 fail-open (c) DSH_EXPERT_AUTOCLAIM='0'/'' 关闭 (d) 无可解
// 析 id 零副作用 (e) summon_experts 批量同一 id 只回写一次
// (f) 专家失败不回滚：条目保持 running，提示附错误尾部
// (g) claim 失败 fail-open：summon 继续、专家结果返回
// (h) taskboard 超时提示与「板不可读」区分
// (i) 任务 id 超过 8 个取前 8 并提示截断。
test('WP-4a parseTaskIds: 显式 T<数字> token 提取（宁漏勿错，去重保序）', () => {
  assert.deepEqual(parseTaskIds('完成任务 T7 并顺带核对 T3'), ['T7', 'T3'])
  assert.deepEqual(parseTaskIds('任务T7已经提到过 T7'), ['T7']) // 中文紧邻可解析 + 去重
  assert.deepEqual(parseTaskIds('AT7 T7x T77a v2.6 attempt A1 WP-4a'), []) // 非显式片段不解析
  assert.deepEqual(parseTaskIds('T1.owner 与 T12、T2049'), ['T1', 'T12', 'T2049'])
  assert.deepEqual(parseTaskIds('下划线紧邻 T7_ 与 T_7 都不算'), [])
  assert.deepEqual(parseTaskIds(''), [])
  assert.deepEqual(parseTaskIds(undefined), [])
})

test('WP-4a parseTaskIds 回炉加固：命令引述/路径形态排除 + 8 个上限截断', () => {
  // 命令引述形态（taskboard 命令动词 + T<数字>）不解析
  assert.deepEqual(parseTaskIds('先执行 claim T5 再 show T3'), [])
  assert.deepEqual(parseTaskIds('完成后 progress T7，并用 deps T2 查看'), [])
  assert.deepEqual(parseTaskIds('done T4 之后收口'), [])
  // 同句混合：命令引述排除，真正的派工目标保留
  assert.deepEqual(parseTaskIds('claim T5，但真正要做的是 T6'), ['T6'])
  // 路径形态（T<数字> 前邻 / . -）不解析
  assert.deepEqual(parseTaskIds('参见 build/T3-report.md 与 /a/b/T4-x.md 的说明'), [])
  assert.deepEqual(parseTaskIds('处理 T9（见 foo-T5 附件）'), ['T9'])
  // 原有语义不受加固影响
  assert.deepEqual(parseTaskIds('任务T7 正常引用'), ['T7'])
  // 上限 8：超出取前 8（宁漏勿错，截断说明由 autoClaimSummonedTasks 提示）
  const many = Array.from({ length: 12 }, (_, i) => `T${i + 1}`).join('、')
  assert.deepEqual(parseTaskIds(many), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'])
})

test('WP-4a locateAutoClaimBoard: 唯一板命中；0 个/多个/目录异常跳过并说明', (t) => {
  const dir = makeBoardDir(t, 'locate')
  assert.equal(locateAutoClaimBoard(dir).ok, false) // 目录不存在 → 0 个
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  assert.equal(locateAutoClaimBoard(dir).ok, false) // 目录存在但无板
  writeFileSync(join(dir, '.expert-taskboards', 'default.json'), '{"tasks":{},"seq":0}')
  const r2 = locateAutoClaimBoard(dir)
  assert.equal(r2.ok, true)
  assert.equal(r2.board, join(dir, '.expert-taskboards', 'default.json'))
  writeFileSync(join(dir, '.expert-taskboards', 'other.json'), '{}')
  const r3 = locateAutoClaimBoard(dir)
  assert.equal(r3.ok, false)
  assert.ok(r3.reason.includes('default.json') && r3.reason.includes('other.json'), r3.reason)
})

/** WP-4a 集成夹具：dst（最小花名册）+ summon ctx（mock provider）。
 *  可选 boardDir：provider start 触发时读取板文件记录 T1 状态（时序可观测断言
 *  ——「专家 run 开始前板已 running」）；可选 stopReason/text 定制专家结果。 */
const makeWp4aDst = (t, label) => {
  const dst = mkdtempSync(join(tmpdir(), `wp4a-dst-${label}-`))
  t.after(() => rmSync(dst, { recursive: true, force: true }))
  mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [{ source: 'bundled-core', file: 'a.md', name: '测试专家' }] }))
  return dst
}
const makeWp4aCtx = ({ boardDir, stopReason = 'completed', text = 'ok' } = {}) => {
  const descriptors = []
  const boardStatusAtStart = [] // 每次 provider start 时 T1 的板内状态快照
  return {
    descriptors,
    boardStatusAtStart,
    ctx: {
      tools: { register: (d) => descriptors.push(d) },
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
        start: async () => {
          if (boardDir) {
            try {
              const board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
              boardStatusAtStart.push(board.tasks.T1?.status ?? null)
            } catch {
              boardStatusAtStart.push('unreadable')
            }
          }
          return { result: Promise.resolve({ stopReason, output: [{ type: 'text', text }] }), dispose: async () => {} }
        },
      },
    },
  }
}

test('WP-4a (a) 委派成功→任务板自动 running+owner；owner 已有不覆盖；done 跳过；不存在 id 只提示', async (t) => {
  const dst = makeWp4aDst(t, 'claim')
  const boardDir = makeBoardDir(t, 'claim')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready（无 owner）
  assert.equal(runTb(boardDir, ['create', '任务B', '--owner', '前任']).code, 0) // T2 ready + owner 已有
  assert.equal(runTb(boardDir, ['create', '任务C']).code, 0) // T3 ready
  assert.equal(runTb(boardDir, ['claim', 'T3', '某人']).code, 0) // T3 → running
  assert.equal(runTb(boardDir, ['done', 'T3', '已完成']).code, 0) // T3 → done
  const { descriptors, ctx, boardStatusAtStart } = makeWp4aCtx({ boardDir })
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  // ① 委派成功 → T1 自动 running + owner=测试专家（不手工写板）；T99 不在板 → 只提示不阻塞
  const r = await summon.execute({ expert: '测试专家', task: '请处理 T1 与 T99' }, { agent: {} })
  assert.ok(r.answer.startsWith('ok'), r.answer)
  assert.ok(r.answer.includes('T1 已自动认领（owner=测试专家'), r.answer)
  assert.ok(r.answer.includes('T99 不在任务板'), r.answer)
  // 时序可观测（回炉第 1 轮 🔴1）：provider start（专家 run 开始）那一刻板已 running——先 claim 后跑专家
  assert.deepEqual(boardStatusAtStart, ['running'])
  let board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
  assert.equal(board.tasks.T1.status, 'running') // in_progress 语义（板状态机为 running）
  assert.equal(board.tasks.T1.owner, '测试专家')
  // ② owner 已有 → 不覆盖，条目保持 ready
  const r2 = await summon.execute({ expert: '测试专家', task: '请处理 T2' }, { agent: {} })
  assert.ok(r2.answer.startsWith('ok'), r2.answer)
  assert.ok(r2.answer.includes('T2 已有 owner=前任，不覆盖'), r2.answer)
  board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
  assert.equal(board.tasks.T2.status, 'ready')
  assert.equal(board.tasks.T2.owner, '前任')
  // ③ done 状态跳过
  const r3 = await summon.execute({ expert: '测试专家', task: '请处理 T3' }, { agent: {} })
  assert.ok(r3.answer.includes('T3 状态为 done（owner=某人），跳过认领'), r3.answer)
  board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
  assert.equal(board.tasks.T3.status, 'done')
})

test('WP-4a (b) 无板/板损坏 fail-open：召唤主流程不受阻，结果附跳过提示', async (t) => {
  const dst = makeWp4aDst(t, 'failopen')
  // 无板：显式提示原因，不阻塞
  const emptyDir = makeBoardDir(t, 'failopen-noboard')
  {
    const { descriptors, ctx } = makeWp4aCtx()
    registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: emptyDir })
    const summon = descriptors.find((d) => d.name === 'summon_expert')
    const r = await summon.execute({ expert: '测试专家', task: '请处理 T1' }, { agent: {} })
    assert.ok(r.answer.startsWith('ok'), r.answer)
    assert.ok(r.answer.includes('【auto-claim 跳过】'), r.answer)
    assert.ok(r.answer.includes('T1 未自动认领'), r.answer)
  }
  // 板损坏：show 返回 unrecoverable → 归一为跳过提示，不阻塞
  const corruptDir = makeBoardDir(t, 'failopen-corrupt')
  mkdirSync(join(corruptDir, '.expert-taskboards'), { recursive: true })
  writeFileSync(join(corruptDir, BOARD_REL), '{not-json')
  {
    const { descriptors, ctx } = makeWp4aCtx()
    registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: corruptDir })
    const summon = descriptors.find((d) => d.name === 'summon_expert')
    const r = await summon.execute({ expert: '测试专家', task: '请处理 T1' }, { agent: {} })
    assert.ok(r.answer.startsWith('ok'), r.answer)
    assert.ok(r.answer.includes('T1 不在任务板或板不可读'), r.answer)
  }
})

test("WP-4a (c) DSH_EXPERT_AUTOCLAIM='0'/''：整体关闭，不写板、结果零提示", async (t) => {
  const dst = makeWp4aDst(t, 'off')
  const boardDir = makeBoardDir(t, 'off')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready
  const before = readFileSync(join(boardDir, BOARD_REL))
  const { descriptors, ctx } = makeWp4aCtx()
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  process.env.DSH_EXPERT_AUTOCLAIM = '0'
  try {
    const r = await summon.execute({ expert: '测试专家', task: '请处理 T1' }, { agent: {} })
    assert.equal(r.answer, 'ok') // 零提示、零追加
    assert.deepEqual(readFileSync(join(boardDir, BOARD_REL)), before) // 板未被动过
    // 回炉 💭3：空串同样视为关闭；未设置/其他值视为开启（其余用例即未设置态）
    process.env.DSH_EXPERT_AUTOCLAIM = ''
    const r2 = await summon.execute({ expert: '测试专家', task: '请处理 T1' }, { agent: {} })
    assert.equal(r2.answer, 'ok')
    assert.deepEqual(readFileSync(join(boardDir, BOARD_REL)), before)
  } finally {
    delete process.env.DSH_EXPERT_AUTOCLAIM
  }
})

test('WP-4a (d) 任务文本无可解析 id：结果与板文件逐字节零变化（零副作用）', async (t) => {
  const dst = makeWp4aDst(t, 'noid')
  const boardDir = makeBoardDir(t, 'noid')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0)
  const before = readFileSync(join(boardDir, BOARD_REL))
  const { descriptors, ctx } = makeWp4aCtx()
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  const r = await summon.execute({ expert: '测试专家', task: '普通任务说明，不含任何任务编号' }, { agent: {} })
  assert.equal(r.answer, 'ok') // 逐字不变
  assert.deepEqual(readFileSync(join(boardDir, BOARD_REL)), before) // 板逐字节不变
})

test('WP-4a (e) summon_experts 批量：同一任务 id 只回写一次', async (t) => {
  const dst = makeWp4aDst(t, 'batch')
  const boardDir = makeBoardDir(t, 'batch')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready
  const { descriptors, ctx } = makeWp4aCtx()
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
  const t4a = descriptors.find((d) => d.name === 'summon_experts')
  const value = await t4a.execute({ experts: [
    { expert: '测试专家', task: '处理 T1' },
    { expert: '测试专家', task: '也处理 T1' },
  ] }, { agent: {} })
  assert.equal(value.results.length, 2)
  assert.ok(value.results.every((e) => e.ok === true), JSON.stringify(value.results))
  assert.equal(value.results.filter((e) => e.answer.includes('已自动认领')).length, 1) // 恰好一次
  assert.ok(isLosslessJson(value))
  const board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
  assert.equal(board.tasks.T1.status, 'running')
  assert.equal(board.tasks.T1.owner, '测试专家')
})

test('WP-4a (f) 回炉🔴1：专家执行失败不回滚——条目保持 running，提示附错误尾部', async (t) => {
  const dst = makeWp4aDst(t, 'norollback')
  const boardDir = makeBoardDir(t, 'norollback')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready
  const { descriptors, ctx, boardStatusAtStart } = makeWp4aCtx({ boardDir, stopReason: 'failed' })
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  // 专家 run 开始前板已 running（先 claim 后跑专家，可观测断言）
  await assert.rejects(
    () => summon.execute({ expert: '测试专家', task: '处理 T1' }, { agent: {} }),
    (error) => {
      assert.ok(/专家执行未正常完成/.test(error.message), error.message)
      assert.ok(error.message.includes('T1 已自动认领'), error.message) // auto-claim 结果随错误附出
      return true
    },
  )
  assert.deepEqual(boardStatusAtStart, ['running'])
  // fail-open 不回滚：条目保持 running + owner，由编排者按板处置
  const board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
  assert.equal(board.tasks.T1.status, 'running')
  assert.equal(board.tasks.T1.owner, '测试专家')
})

test('WP-4a (g) 回炉：claim 失败 fail-open——summon 继续、专家结果返回、板未被误写', async (t) => {
  const dst = makeWp4aDst(t, 'claimfail')
  const boardDir = makeBoardDir(t, 'claimfail')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready
  const before = readFileSync(join(boardDir, BOARD_REL))
  // PATH shim：show 正常透传真 python3，claim 一律失败——隔离验证 claim 失败路径
  const realPy = execFileSync('sh', ['-c', 'command -v python3']).toString().trim()
  const shimDir = mkdtempSync(join(tmpdir(), 'wp4a-shim-claimfail-'))
  t.after(() => rmSync(shimDir, { recursive: true, force: true }))
  const shim = join(shimDir, 'python3')
  writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do [ "$a" = claim ] && { echo '{"error":"stale_revision"}'; exit 1; }; done\nexec ${realPy} "$@"\n`)
  chmodSync(shim, 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${shimDir}:${oldPath}`
  try {
    const { descriptors, ctx } = makeWp4aCtx({ boardDir })
    registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
    const summon = descriptors.find((d) => d.name === 'summon_expert')
    const r = await summon.execute({ expert: '测试专家', task: '处理 T1' }, { agent: {} })
    assert.ok(r.answer.startsWith('ok'), r.answer) // 专家照常执行，claim 失败不阻塞派工
    assert.ok(r.answer.includes('T1 认领失败（已忽略，不阻塞派工）：stale_revision'), r.answer)
    const board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
    assert.equal(board.tasks.T1.status, 'ready') // claim 失败未写板
    assert.ok(!board.tasks.T1.owner)
    assert.deepEqual(readFileSync(join(boardDir, BOARD_REL)), before) // 板逐字节不变
  } finally {
    process.env.PATH = oldPath
  }
})

test('WP-4a (h) 回炉💭3：taskboard 超时提示与「板不可读」区分', async (t) => {
  const dst = makeWp4aDst(t, 'timeout')
  const boardDir = makeBoardDir(t, 'timeout')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready（板真实存在，排除板不可读干扰）
  // PATH shim：python3 假装卡死——配合极短 autoClaimTimeoutMs 触发子进程超时
  const shimDir = mkdtempSync(join(tmpdir(), 'wp4a-shim-timeout-'))
  t.after(() => rmSync(shimDir, { recursive: true, force: true }))
  const shim = join(shimDir, 'python3')
  writeFileSync(shim, '#!/bin/sh\nsleep 2\n')
  chmodSync(shim, 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${shimDir}:${oldPath}`
  try {
    const { descriptors, ctx } = makeWp4aCtx({ boardDir })
    registerExpertTools(ctx, {
      dst,
      getExpertContentImpl: () => ({ content: 'persona 正文' }),
      autoClaimCwd: boardDir,
      autoClaimTimeoutMs: 100,
    })
    const summon = descriptors.find((d) => d.name === 'summon_expert')
    const r = await summon.execute({ expert: '测试专家', task: '处理 T1' }, { agent: {} })
    assert.ok(r.answer.startsWith('ok'), r.answer) // 超时 fail-open，不阻塞派工
    assert.ok(r.answer.includes('认领前置检查超时（taskboard.py 100ms 无响应）'), r.answer)
    assert.ok(!r.answer.includes('板不可读'), r.answer) // 与板不可读提示语可区分
  } finally {
    process.env.PATH = oldPath
  }
})

test('WP-4a (i) 回炉🟡2：任务 id 超过 8 个取前 8 并在提示中说明截断', async (t) => {
  const dst = makeWp4aDst(t, 'cap')
  const boardDir = makeBoardDir(t, 'cap')
  assert.equal(runTb(boardDir, ['create', '任务A']).code, 0) // T1 ready
  const { descriptors, ctx } = makeWp4aCtx({ boardDir })
  registerExpertTools(ctx, { dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: boardDir })
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  const taskText = Array.from({ length: 10 }, (_, i) => `T${i + 1}`).join('、')
  const r = await summon.execute({ expert: '测试专家', task: taskText }, { agent: {} })
  assert.ok(r.answer.includes(`超过上限 8，仅认领前 8 个`), r.answer) // 截断说明
  const board = JSON.parse(readFileSync(join(boardDir, BOARD_REL), 'utf-8'))
  assert.equal(board.tasks.T1.status, 'running') // 前 8 个中在板者正常认领
  assert.equal(board.tasks.T1.owner, '测试专家')
})
