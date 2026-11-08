// test/client-settings.selftest.mjs — 设置页纯函数自测（node:test，零依赖）。
// lib/client.js 是 ModuleLoader 文本 bundle（window.__ModuleLoader__ 包裹，node 不可直接
// import），设置页纯函数区以 `// SET-PURE-BEGIN` / `// SET-PURE-END` 标记隔离；本测试从
// 源码文本提取该区段后 new Function 求值——单一真相：被测代码即交付代码（先例：TB-PURE）。
// 覆盖任务书 M4：computeRecommendedPlan 三桶跳过规则 / statusToneOf·statusTextToneOf 唯一映射 /
// looksLikeSourceUrl 双正则 / parseMirrorPrefixes / mirrorPrefixesValid / errorKeyOf / findingText。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')

const BEGIN = '// SET-PURE-BEGIN'
const END = '// SET-PURE-END'
const beginCount = source.split(BEGIN).length - 1
const endCount = source.split(END).length - 1
const beginIndex = source.indexOf(BEGIN)
const endIndex = source.indexOf(END)

test('SET-PURE 标记恰各一次且次序正确（提取契约）', () => {
  assert.equal(beginCount, 1)
  assert.equal(endCount, 1)
  assert.ok(beginIndex >= 0 && endIndex > beginIndex)
})

const set = new Function(
  source.slice(beginIndex + BEGIN.length, endIndex)
    + '\n;return { BUILTIN_SOURCE_ID, LEGACY_SOURCE_ID, messageOf, errorKeyOf, findingText,'
    + ' looksLikeSourceUrl, parseMirrorPrefixes, mirrorPrefixesValid, statusToneOf,'
    + ' statusTextToneOf, computeRecommendedPlan, normProfileKey, resolveExpertModelSource,'
    + ' expertSourceLabels, suggestGroupMembers, sortedKeysJson };',
)()

function makeSource(overrides) {
  return {
    id: 'src-a', name: '来源 A', status: 'ok', enabled: true, builtin: false,
    custom: false, recommended: false, installedVersion: '1.0.0', ...overrides,
  }
}

// ---------- 常量 id ----------

test('BUILTIN_SOURCE_ID/LEGACY_SOURCE_ID 契约值', () => {
  assert.equal(set.BUILTIN_SOURCE_ID, 'bundled-core')
  assert.equal(set.LEGACY_SOURCE_ID, 'legacy-adapted')
})

// ---------- computeRecommendedPlan ----------

test('computeRecommendedPlan: 推荐且未安装 → download 桶', () => {
  const plan = set.computeRecommendedPlan({
    sources: [makeSource({ id: 'a', recommended: true, installedVersion: null })],
  })
  assert.equal(plan.download.length, 1)
  assert.equal(plan.enableOnly.length, 0)
  assert.equal(plan.disable.length, 0)
})

test('computeRecommendedPlan: 推荐已安装未启用 → enableOnly 桶（不重复 download）', () => {
  const plan = set.computeRecommendedPlan({
    sources: [makeSource({ id: 'a', recommended: true, enabled: false })],
  })
  assert.equal(plan.download.length, 0)
  assert.equal(plan.enableOnly.length, 1)
  assert.equal(plan.disable.length, 0)
})

test('computeRecommendedPlan: 非推荐且启用中 → disable 桶', () => {
  const plan = set.computeRecommendedPlan({
    sources: [makeSource({ id: 'a', recommended: false, enabled: true })],
  })
  assert.equal(plan.disable.length, 1)
  assert.equal(plan.download.length, 0)
  assert.equal(plan.enableOnly.length, 0)
})

test('computeRecommendedPlan: builtin 与 custom 伪来源一律跳过（id 命中 builtin id 同样跳过）', () => {
  const plan = set.computeRecommendedPlan({
    sources: [
      makeSource({ id: 'bundled-core', builtin: true, recommended: false, enabled: true }),
      makeSource({ id: 'custom-x', custom: true, recommended: true, installedVersion: null }),
      makeSource({ id: 'bundled-core', builtin: false, recommended: true, installedVersion: null }),
      makeSource({ id: 'a', recommended: true, installedVersion: null }),
    ],
  })
  // 仅第 4 条进 download：第 1 条 builtin、第 2 条 custom、第 3 条 id=bundled-core 均跳过
  assert.equal(plan.download.length, 1)
  assert.equal(plan.download[0].id, 'a')
  assert.equal(plan.enableOnly.length, 0)
  assert.equal(plan.disable.length, 0)
})

test('computeRecommendedPlan: 推荐已启用已安装 → 三桶皆空', () => {
  const plan = set.computeRecommendedPlan({
    sources: [makeSource({ id: 'a', recommended: true, enabled: true })],
  })
  assert.deepEqual([plan.download.length, plan.enableOnly.length, plan.disable.length], [0, 0, 0])
})

test('computeRecommendedPlan: note 透传字符串、非字符串回退 null', () => {
  assert.equal(set.computeRecommendedPlan({ sources: [], recommendedNote: '注意：x' }).note, '注意：x')
  assert.equal(set.computeRecommendedPlan({ sources: [] }).note, null)
  assert.equal(set.computeRecommendedPlan({ sources: [], recommendedNote: 42 }).note, null)
})

// ---------- statusToneOf / statusTextToneOf（visual-spec §3.2 唯一映射表） ----------

test('statusToneOf: 六已知状态→同名 tone，未知/缺失→idle', () => {
  for (const status of ['ok', 'downloading', 'verifyFailed', 'scanRejected', 'error']) {
    assert.equal(set.statusToneOf({ status }), status)
  }
  assert.equal(set.statusToneOf({ status: 'chaos' }), 'idle')
  assert.equal(set.statusToneOf({}), 'idle')
  assert.equal(set.statusToneOf(null), 'idle')
})

test('statusTextToneOf: 仅 verifyFailed/scanRejected/error → danger，其余 null', () => {
  assert.equal(set.statusTextToneOf({ status: 'verifyFailed' }), 'danger')
  assert.equal(set.statusTextToneOf({ status: 'scanRejected' }), 'danger')
  assert.equal(set.statusTextToneOf({ status: 'error' }), 'danger')
  assert.equal(set.statusTextToneOf({ status: 'ok' }), null)
  assert.equal(set.statusTextToneOf({ status: 'downloading' }), null)
  assert.equal(set.statusTextToneOf({ status: 'chaos' }), null)
  assert.equal(set.statusTextToneOf(null), null)
})

// ---------- looksLikeSourceUrl ----------

test('looksLikeSourceUrl: github repo URL 放行', () => {
  assert.equal(set.looksLikeSourceUrl('https://github.com/user/repo'), true)
  assert.equal(set.looksLikeSourceUrl('https://github.com/user/repo.name-x_1'), true)
  assert.equal(set.looksLikeSourceUrl('https://github.com/user/repo/'), true)
})

test('looksLikeSourceUrl: 本地路径前缀放行（~/ / ./ ../）', () => {
  assert.equal(set.looksLikeSourceUrl('~/experts'), true)
  assert.equal(set.looksLikeSourceUrl('/vol2/experts'), true)
  assert.equal(set.looksLikeSourceUrl('./relative/path'), true)
  assert.equal(set.looksLikeSourceUrl('../up/path'), true)
})

test('looksLikeSourceUrl: 非法输入拒绝', () => {
  assert.equal(set.looksLikeSourceUrl('https://gitlab.com/user/repo'), false)
  assert.equal(set.looksLikeSourceUrl('http://github.com/user/repo'), false) // 非 https
  assert.equal(set.looksLikeSourceUrl('https://github.com/user/repo/extra'), false)
  assert.equal(set.looksLikeSourceUrl('path with space'), false)
  assert.equal(set.looksLikeSourceUrl(''), false)
})

// ---------- parseMirrorPrefixes / mirrorPrefixesValid ----------

test('parseMirrorPrefixes: 按行拆分、去首尾空白、去空行', () => {
  assert.deepEqual(set.parseMirrorPrefixes(' https://a.example\n\nhttps://b.example\r\n  \n'), [
    'https://a.example',
    'https://b.example',
  ])
  assert.deepEqual(set.parseMirrorPrefixes(''), [])
  assert.deepEqual(set.parseMirrorPrefixes('   '), [])
})

test('mirrorPrefixesValid: http/https 前缀放行，其余拒绝，空表通过', () => {
  assert.equal(set.mirrorPrefixesValid(['https://mirror.example/', 'http://bak.example']), true)
  assert.equal(set.mirrorPrefixesValid(['ftp://mirror.example']), false)
  assert.equal(set.mirrorPrefixesValid(['mirror.example']), false)
  assert.equal(set.mirrorPrefixesValid(['https://ok', 'bad']), false)
  assert.equal(set.mirrorPrefixesValid([]), true)
})

// ---------- errorKeyOf / findingText ----------

test('errorKeyOf: e.key 直取、message 前缀、正文词匹配、兜底 null', () => {
  assert.equal(set.errorKeyOf({ key: 'conflict' }), 'conflict')
  assert.equal(set.errorKeyOf(new Error('conflict: revision mismatch')), 'conflict')
  assert.equal(set.errorKeyOf(new Error('quota LIMIT exceeded')), 'limit')
  assert.equal(set.errorKeyOf(new Error('boom')), null)
})

test('findingText: file·rule·detail 组装，缺失回退 —，非对象 String 化', () => {
  assert.equal(set.findingText({ file: 'a.md', rule: '同名', detail: '第 3 行' }), 'a.md · 同名 · 第 3 行')
  assert.equal(set.findingText({ path: 'a.md', reason: 'dup' }), 'a.md · dup')
  assert.equal(set.findingText({}), '—')
  assert.equal(set.findingText(null), 'null')
  assert.equal(set.findingText('raw'), 'raw')
})

// ---------- messageOf（globalErrorText 的底层） ----------

test('messageOf: Error.message 与字符串直转', () => {
  assert.equal(set.messageOf(new Error('x')), 'x')
  assert.equal(set.messageOf('y'), 'y')
})

// ---------- expandedSources 行级 disclosure 状态（v2.11.1 回归钉死） ----------
// 组件闭包 hooks 非纯函数区、不可走 SET-PURE 提取，按任务书改静态断言（从简）：
// 源码必须含 useState(new Set()) 声明、闭包 setter 的不可变更新与 disclosure 接线——
// 钉死 v2.11.0 重构丢声明导致的渲染崩溃
// （ReferenceError: expandedSources is not defined at ExpertSourcesSettings）。

test('expandedSources: useState(new Set()) 声明与 setter 引用齐备（free identifier 回归钉死）', () => {
  assert.match(source, /var expandedSourcesState = React\.useState\(new Set\(\)\)/)
  assert.match(source, /var expandedSources = expandedSourcesState\[0\]/)
  assert.match(source, /var setExpandedSources = expandedSourcesState\[1\]/)
  // 首次使用（rows 渲染 .has）必须晚于声明：free identifier 即回归
  const declareAt = source.indexOf('var expandedSources =')
  const useAt = source.indexOf('expandedSources.has(')
  assert.ok(declareAt >= 0 && useAt > declareAt)
})

test('expandedSources: toggle 不可变更新 + disclosure 接线（aria-expanded/Esc 收起）', () => {
  // toggleExpandedSource：经闭包 setter 不可变 Set 增删（直改 prev 视为回归）
  assert.match(source, /setExpandedSources\(function \(prev\) \{\s*var next = new Set\(prev\);/)
  // disclosure 按钮：aria-expanded/aria-controls 指向 region，onClick 走 toggle
  assert.match(source, /"aria-expanded": expanded, "aria-controls": filesRegionId/)
  assert.match(source, /onClick: function \(\) \{ toggleExpandedSource\(source\.id\); \}/)
  // region Esc 收起复用同一 toggle（回焦触发按钮）
  assert.match(source, /if \(event\.key !== "Escape"\) return;\s*toggleExpandedSource\(source\.id\);/)
})

// ---------- T10 专家档案与分组：生效来源徽标推导（硬门抽查 3 例） ----------
// 前端 resolveExpertModelSource 必须与 lib/expert-profiles.js resolveExpertModel（T8 后端链）
// 逐例对账：model 值一致，source 映射 expert/group/defaults ↔ 非空返回，session ↔ null。

import { resolveExpertModel } from '../lib/expert-profiles.js'

const noopWarn = () => {}

function assertBadgeMatchesBackend(name, experts, groups, defaults, context) {
  // resolveExpertModel 吃 loadExpertProfiles 的平面合并视图（专家名顶层平铺 +
  // groups/defaults 增量键，见其 JSDoc）；前端函数吃三键分离形参——语义对账。
  const profiles = { ...experts, groups, defaults }
  const expected = resolveExpertModel(profiles, name, noopWarn)
  const actual = set.resolveExpertModelSource(experts, groups, defaults, name)
  assert.equal(actual.model, expected, context + ': model 与 T8 链一致')
  if (expected === null) {
    assert.equal(actual.source, 'session', context + ': 后端 null ↔ 前端 session')
    assert.equal(actual.group, null, context + ': session 无组名')
  }
  return actual
}

test('徽标抽查① 仅 experts 键：逐专家命中 → expert，未配置 → session（对账 T8 链）', () => {
  const experts = { 'pm-expert': { model: 'deepseek-chat' } }
  const actual = assertBadgeMatchesBackend('pm-expert', experts, {}, {}, '仅 experts/命中')
  assert.equal(actual.source, 'expert')
  assert.equal(actual.group, null)
  // 归一命中（trim+lower）与 T8 链一致
  const norm = assertBadgeMatchesBackend('  PM-Expert ', experts, {}, {}, '仅 experts/归一')
  assert.equal(norm.source, 'expert')
  assert.equal(norm.model, 'deepseek-chat')
  // 未配置专家 → session，后端返回 null
  const miss = assertBadgeMatchesBackend('nobody', experts, {}, {}, '仅 experts/未配置')
  assert.equal(miss.source, 'session')
  assert.equal(miss.model, null)
  // 保留键不作专家名（T8 链同规）
  const reserved = assertBadgeMatchesBackend('groups', experts, {}, {}, '仅 experts/保留键')
  assert.equal(reserved.source, 'session')
})

test('徽标抽查② experts+groups 重叠：逐专家 > 组（声明顺序首个）> 首组无 model 落 defaults（对账 T8 链）', () => {
  const experts = { alice: { model: 'expert-model' } }
  const groups = {
    'g-a': { model: 'group-a-model', members: ['alice', 'bob'] },
    'g-b': { model: 'group-b-model', members: ['Alice'] }, // 多组命中，声明顺序首个 g-a 胜
  }
  // alice 有逐专家 model → expert 胜过组
  const alice = assertBadgeMatchesBackend('alice', experts, groups, {}, '重叠/逐专家胜')
  assert.equal(alice.source, 'expert')
  assert.equal(alice.model, 'expert-model')
  // bob 无逐专家条目 → 首个命中组 g-a
  const bob = assertBadgeMatchesBackend('bob', experts, groups, {}, '重叠/组命中')
  assert.equal(bob.source, 'group')
  assert.equal(bob.model, 'group-a-model')
  assert.equal(bob.group, 'g-a')
  // 多组命中（bob 亦属 g-b？否——多组命中场景单独构造：carol 属 g-b 与 g-c，声明顺序 g-b 先）
  const groups2 = {
    'g-b': { model: 'b-model', members: ['carol'] },
    'g-c': { model: 'c-model', members: ['Carol'] },
  }
  const carol = assertBadgeMatchesBackend('carol', {}, groups2, {}, '重叠/多组首个')
  assert.equal(carol.source, 'group')
  assert.equal(carol.model, 'b-model')
  // 首个命中组无 model → 组层无值落 defaults（T8 链 break 语义）
  const groups3 = {
    'g-empty': { members: ['dave'] },
    'g-late': { model: 'late-model', members: ['dave'] },
  }
  const defaults = { model: 'fallback-model' }
  const dave = assertBadgeMatchesBackend('dave', {}, groups3, defaults, '重叠/首组无model落defaults')
  assert.equal(dave.source, 'defaults')
  assert.equal(dave.model, 'fallback-model')
})

test('徽标抽查③ 全空：experts/groups/defaults 皆空 → session（对账 T8 链 null）', () => {
  const actual = assertBadgeMatchesBackend('anyone', {}, {}, {}, '全空')
  assert.equal(actual.source, 'session')
  assert.equal(actual.model, null)
  assert.equal(actual.group, null)
  // 仅 defaults：兜底命中
  const fallback = assertBadgeMatchesBackend('anyone', {}, {}, { model: 'defaults-model' }, '仅 defaults')
  assert.equal(fallback.source, 'defaults')
  assert.equal(fallback.model, 'defaults-model')
  // 仅组无 model 且无 defaults → session（后端 null）
  const noModel = assertBadgeMatchesBackend('anyone', {}, { g: { members: ['anyone'] } }, {}, '组无model无defaults')
  assert.equal(noModel.source, 'session')
})

// ---------- T10 其余纯函数 ----------

test('expertSourceLabels: 跨来源同名标签去重共现、custom 标注、归一键', () => {
  const sources = [
    { id: 's1', name: '来源一', files: [{ name: '审查员', file: 'a.md' }, { name: 'Bob', file: 'b.md' }] },
    { id: 's2', name: '来源二', files: [{ name: 'bob', file: 'b2.md' }] },
  ]
  const customs = [{ name: 'Bob', division: 'dev' }]
  const labels = set.expertSourceLabels(sources, customs)
  assert.deepEqual(labels['bob'], [
    { kind: 'source', label: '来源一' },
    { kind: 'source', label: '来源二' },
    { kind: 'custom' },
  ])
  assert.deepEqual(labels['审查员'], [{ kind: 'source', label: '来源一' }])
  assert.equal(labels[undefined], undefined)
})

test('suggestGroupMembers: division 归一匹配、保序去重、空 division 返回 []', () => {
  const customs = [
    { name: 'A', division: 'Dev' },
    { name: 'B', division: 'dev' },
    { name: 'C', division: 'review' },
    { name: 'A', division: 'dev' }, // 重名不重复建议
  ]
  assert.deepEqual(set.suggestGroupMembers(customs, ' dev '), ['A', 'B'])
  assert.deepEqual(set.suggestGroupMembers(customs, 'review'), ['C'])
  assert.deepEqual(set.suggestGroupMembers(customs, ''), [])
  assert.deepEqual(set.suggestGroupMembers(customs, 'nope'), [])
})

test('sortedKeysJson: 键序无关且值敏感（脏态比较基础）', () => {
  assert.equal(set.sortedKeysJson({ a: 1, b: 2 }), set.sortedKeysJson({ b: 2, a: 1 }))
  assert.notEqual(set.sortedKeysJson({ a: 1 }), set.sortedKeysJson({ a: 2 }))
  assert.equal(set.sortedKeysJson({ experts: {}, groups: null }), set.sortedKeysJson({ groups: null, experts: {} }))
})

test('normProfileKey: trim+lower 归一口径', () => {
  assert.equal(set.normProfileKey('  PM-Expert '), 'pm-expert')
  assert.equal(set.normProfileKey(42), '')
})

// ---------- T10 面板接线（组件闭包静态断言，先例：expandedSources 钉死） ----------

test('profiles 面板接线：加载/保存/invalid 错误分支/分区与 nav 入口', () => {
  // 初载 getExpertProfiles（fail-open：非 function 跳过）
  assert.match(source, /typeof remote\.getExpertProfiles !== "function"\) return undefined/)
  assert.match(source, /remote\.getExpertProfiles\(\)/)
  // 独立保存流：整文档三键替换 + 成功回读刷新
  assert.match(source, /remote\.saveExpertProfiles\(\{\s*experts: plainObjectOf\(doc\.experts\),/)
  assert.match(source, /errorKeyOf\(cause\) === "invalid" \? t\("profiles\.err\.invalid"\) : messageOf\(cause\)/)
  assert.match(source, /acceptProfilesView\(unwrap\(result\)\)/)
  // 分区与 nav 入口
  assert.match(source, /id: "eso-set-sec-profiles", label: t\("nav\.profiles"\)/)
  assert.match(source, /id: "eso-set-sec-profiles", "aria-label": t\("profiles\.title"\)/)
})

test('profiles 分组 disclosure：expandedGroups useState(new Set()) + aria-controls 接线（回归钉死）', () => {
  assert.match(source, /var expandedGroupsState = React\.useState\(new Set\(\)\)/)
  assert.match(source, /var expandedGroups = expandedGroupsState\[0\]/)
  assert.match(source, /setExpandedGroups\(function \(prev\) \{\s*var next = new Set\(prev\);/)
  assert.match(source, /"aria-controls": groupRegionId,/)
  assert.match(source, /onClick: function \(\) \{ toggleExpandedGroup\(groupName\); \}/)
  // 成员归组视图来源标注（expertSourceLabels 在组件内消费）
  assert.match(source, /expertSourceLabels\(snapshot\.sources, customList\)/)
})

// ---------- T10 双语词条：新增 key zh/en 各声明一次 ----------

const T10_LOCALE_KEYS = [
  'nav.profiles', 'profiles.title', 'profiles.desc', 'profiles.chain.hint', 'profiles.loading',
  'profiles.experts.title', 'profiles.experts.empty', 'profiles.experts.add', 'profiles.experts.namePlaceholder',
  'profiles.expert.modelLabel', 'profiles.expert.effortLabel', 'profiles.expert.toolsLabel',
  'profiles.expert.skillsLabel', 'profiles.expert.mcpLabel', 'profiles.expert.none',
  'profiles.expert.delete', 'profiles.expert.deleteConfirm', 'profiles.expert.deleteAria',
  'profiles.groups.title', 'profiles.groups.empty', 'profiles.groups.add',
  'profiles.group.nameLabel', 'profiles.group.modelLabel', 'profiles.group.membersLabel',
  'profiles.group.memberCount', 'profiles.group.expand', 'profiles.group.membersEmpty',
  'profiles.group.delete', 'profiles.group.deleteConfirm', 'profiles.group.deleteAria',
  'profiles.group.namePlaceholder', 'profiles.group.membersPlaceholder', 'profiles.group.divisionPick',
  'profiles.defaults.modelLabel', 'profiles.badge.expert', 'profiles.badge.group',
  'profiles.badge.defaults', 'profiles.badge.session', 'profiles.source.custom',
  'profiles.dirty', 'profiles.save', 'profiles.saved', 'profiles.err.invalid', 'profiles.err.form',
]

test('T10 双语词条：每个新 key 在 zh/en 字典各声明一次', () => {
  for (const key of T10_LOCALE_KEYS) {
    const pattern = new RegExp('"' + key.replace(/\./g, '\\.') + '":')
    const count = source.split(pattern).length - 1
    assert.equal(count, 2, 'key "' + key + '" 应在 zh/en 各声明一次，实际 ' + count + ' 次')
  }
})
