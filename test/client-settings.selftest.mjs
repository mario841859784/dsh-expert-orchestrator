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
    + ' statusTextToneOf, computeRecommendedPlan };',
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
