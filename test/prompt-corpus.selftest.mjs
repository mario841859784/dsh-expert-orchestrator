// test/prompt-corpus.selftest.mjs — prompt corpus 清单/完整性/重复度自测（node:test，零依赖）。
// 覆盖 T3（P3-3②）：三处 corpus（skills/expert-orchestration/experts/*.md、
// expert-methods/*.md、skills/expert-gestures/expert-*.md）——
//   1) 清单从事实源派生：运行期 readdir 枚举，与 scripts/gen-preset-declaration.mjs
//      的生成面对账（该脚本无导出清单函数，但其花名册枚举逻辑导出于
//      lib/expert-gestures.js 的 readRoster/gestureSkillName——单一真相，import 对账，
//      禁止手写文件清单）；
//   2) 每文件非空 + frontmatter 必备键（键集先只读核实：experts 实际键
//      name/title/适用任务（禁入任务/典型交付/method 为可选），gestures 实际键
//      name/description/disable-model-invocation；expert-methods 全目录无 frontmatter，
//      以「非空 + # 标题开头」断言，勿臆造）；
//   3) 两两归一化重复度上限（阈值实测现网分布：组内最大 dice 分别 0.6699 / 0.2013 /
//      0.9494（手势文件共享生成模板，相似度天然高），跨组最大 0.3086——上界取
//      现网最大值之上的合理余量，防未来拷贝粘贴漂移，超限具名报出文件对与重复率）；
//   4) 测试自身负样本自检：对 checkCorpus(root) 注入 tmp 目录扰动（删/增 .md、
//      清空文件、frontmatter 缺键、内容复制超限），证明「清单漏文件 / 文件空 /
//      frontmatter 缺键 / 重复度超限」四类负路径均能判错，防断言生成器自指盲区。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GESTURE_SKILL_DIR, gestureSkillName, readRoster } from '../lib/expert-gestures.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// 与 gen-preset-declaration.mjs 默认 --roster 目录一致（脚本内硬编码默认值）；
// 手势目录复用生成器导出的 GESTURE_SKILL_DIR（单一真相）。
const EXPERTS_DIR = join('skills', 'expert-orchestration', 'experts')
const METHODS_DIR = 'expert-methods'
const GESTURES_DIR = GESTURE_SKILL_DIR

// 阈值 = 现网实测组内最大重复度 + 余量（见文件头注释）。
const SIM_LIMITS = {
  [EXPERTS_DIR]: 0.80,
  [METHODS_DIR]: 0.50,
  [GESTURES_DIR]: 0.97,
  cross: 0.60,
}

// ---------- 纯函数（清单/解析/相似度核心，负样本直接以扰动输入打这些函数） ----------

/** 运行期枚举目录顶层 .md（排序确定性），返回相对 root 的路径。 */
function listMd(root, dirRel, nameFilter = (n) => n.toLowerCase().endsWith('.md')) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return []
  return readdirSync(abs).filter(nameFilter).sort().map((fn) => join(dirRel, fn))
}

/** frontmatter 解析（独立于 lib 的行式轻量版）：文件以 --- 开头 → { ok, fm }；
 *  无 frontmatter → { ok:false }；行无法按 key: value 解析 → { ok:false, error }。 */
function parseFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return { ok: false, error: '缺少 frontmatter 块' }
  const end = text.indexOf('\n---')
  if (end < 0) return { ok: false, error: 'frontmatter 块未闭合' }
  const fm = {}
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const i = line.indexOf(':')
    if (i <= 0) return { ok: false, error: `frontmatter 行无法解析：${line.trim().slice(0, 40)}` }
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { ok: true, fm }
}

/** 归一化：剥 frontmatter 块，去全部空白/标点/符号（含中文标点），小写。 */
function normalizeBody(text) {
  const body = text.startsWith('---') && text.indexOf('\n---') > 0 ? text.slice(text.indexOf('\n---') + 4) : text
  return body.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

const bigrams = (s) => {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
  return m
}

/** 字符二元组 Dice 系数 ∈ [0,1]：完全相同 → 1，无公共二元组 → 0。 */
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  let n = 0
  let m = 0
  let inter = 0
  for (const c of A.values()) n += c
  for (const c of B.values()) m += c
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g))
  return (2 * inter) / (n + m)
}

const groupOf = (relPath) => {
  const p = relPath.split(join.sep).join('/')
  if (p.startsWith('skills/expert-gestures/')) return GESTURES_DIR
  if (p.startsWith('expert-methods/')) return METHODS_DIR
  return EXPERTS_DIR
}

const simLimit = (a, b) => {
  const ga = groupOf(a)
  const gb = groupOf(b)
  return ga === gb ? SIM_LIMITS[ga] : SIM_LIMITS.cross
}

/**
 * corpus 完整性检查核心：返回问题清单（[] = 全绿）。
 * 每条问题 { kind, msg }，kind ∈ 清单|内容|相似度。root 可指向仓库或 tmp 扰动副本
 * ——负样本自检即基于该参数注入增/删/改场景。
 */
function checkCorpus(root) {
  const problems = []
  const expertsFiles = listMd(root, EXPERTS_DIR)
  const gesturesFiles = listMd(root, GESTURES_DIR, (n) => /^expert-.*\.md$/.test(n))
  const methodsFiles = listMd(root, METHODS_DIR)

  // ── 清单对账（事实源：readdir 枚举 × 生成器花名册 readRoster × 引用闭包）──
  let roster = null
  try {
    roster = readRoster(join(root, EXPERTS_DIR), () => {})
  } catch (err) {
    problems.push({ kind: '清单', msg: `花名册解析失败（gen 生成面口径）：${err?.message ?? err}` })
  }
  if (roster) {
    // readdir 枚举 ≡ readRoster 花名册（同一目录两种口径必须一致）
    const rosterFiles = roster.map((e) => join(EXPERTS_DIR, e.file))
    for (const f of expertsFiles) if (!rosterFiles.includes(f)) problems.push({ kind: '清单', msg: `清单漏对账：experts 枚举含 ${f} 但花名册未收录` })
    for (const f of rosterFiles) if (!expertsFiles.includes(f)) problems.push({ kind: '清单', msg: `清单漏对账：花名册含 ${f} 但 experts 目录枚举缺失` })
    // 手势目录 ≡ 花名册派生的手势文件集（双向：缺失 + 残留，gen --check 同款漂移口径）
    const expectedGestures = new Map(roster.map((e) => [join(GESTURES_DIR, `${gestureSkillName(e.name)}.md`), e]))
    for (const [f, e] of expectedGestures) {
      if (!gesturesFiles.includes(f)) problems.push({ kind: '清单', msg: `清单漏文件：专家 ${e.name} 的手势技能 ${f} 缺失` })
    }
    for (const f of gesturesFiles) {
      if (!expectedGestures.has(f)) problems.push({ kind: '清单', msg: `清单漏文件：手势残留 ${f} 不对应任何花名册专家（生成面已删但文件仍在）` })
    }
    // expert-methods ≡ { README.md } ∪ 各专家 frontmatter method: 引用闭包
    const referenced = new Set([join(METHODS_DIR, 'README.md')])
    for (const e of roster) {
      const raw = readFileSync(join(root, EXPERTS_DIR, e.file), 'utf-8')
      const method = parseFrontmatter(raw).fm?.method
      if (method) referenced.add(join(METHODS_DIR, method.replace(/^expert-methods\//, '')))
    }
    for (const f of methodsFiles) {
      if (!referenced.has(f)) problems.push({ kind: '清单', msg: `清单漏文件：${f} 不被任何专家 method: 引用且非 README` })
    }
    for (const f of referenced) {
      if (!methodsFiles.includes(f)) problems.push({ kind: '清单', msg: `清单漏文件：被引用的 ${f} 在 expert-methods 目录缺失` })
    }
  }

  // ── 每文件内容断言（非空 / frontmatter 必备键，键集按目录实测事实）──
  for (const f of expertsFiles) {
    const text = readFileSync(join(root, f), 'utf-8')
    if (!text.trim()) { problems.push({ kind: '内容', msg: `文件为空：${f}` }); continue }
    const p = parseFrontmatter(text)
    if (!p.ok) { problems.push({ kind: '内容', msg: `${f}：${p.error}` }); continue }
    for (const key of ['name', 'title', '适用任务']) {
      if (!p.fm[key]) problems.push({ kind: '内容', msg: `${f}：frontmatter 缺必备键 ${key}` })
    }
  }
  for (const f of methodsFiles) {
    const text = readFileSync(join(root, f), 'utf-8')
    if (!text.trim()) { problems.push({ kind: '内容', msg: `文件为空：${f}` }); continue }
    if (!/^#\s/.test(text)) problems.push({ kind: '内容', msg: `${f}：缺 # 标题行（expert-methods 目录约定，无 frontmatter）` })
  }
  const skillByFile = new Map((roster ?? []).map((e) => [join(GESTURES_DIR, `${e.skill}.md`), e]))
  for (const f of gesturesFiles) {
    const text = readFileSync(join(root, f), 'utf-8')
    if (!text.trim()) { problems.push({ kind: '内容', msg: `文件为空：${f}` }); continue }
    const p = parseFrontmatter(text)
    if (!p.ok) { problems.push({ kind: '内容', msg: `${f}：${p.error}` }); continue }
    for (const key of ['name', 'description', 'disable-model-invocation']) {
      if (!p.fm[key]) problems.push({ kind: '内容', msg: `${f}：frontmatter 缺必备键 ${key}` })
    }
    if (p.fm['disable-model-invocation'] !== 'true') problems.push({ kind: '内容', msg: `${f}：disable-model-invocation 须为 true（手势不进模型目录）` })
    if (skillByFile.has(f) && p.fm.name !== skillByFile.get(f).skill) {
      problems.push({ kind: '内容', msg: `${f}：手势 name=${p.fm.name} 与花名册派生名 ${skillByFile.get(f).skill} 不一致` })
    }
  }

  // ── 两两归一化重复度上限（超限具名报出文件对与重复率）──
  const docs = [...expertsFiles, ...methodsFiles, ...gesturesFiles].map((f) => ({ f, n: normalizeBody(readFileSync(join(root, f), 'utf-8')) }))
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const limit = simLimit(docs[i].f, docs[j].f)
      const rate = dice(docs[i].n, docs[j].n)
      if (rate > limit) {
        problems.push({ kind: '相似度', msg: `重复度超限：${docs[i].f} ~ ${docs[j].f} 归一化重复率 ${rate.toFixed(4)} > 上限 ${limit}` })
      }
    }
  }
  return problems
}

const problemsOf = (root, kind) => checkCorpus(root).filter((p) => p.kind === kind)

// ---------- tmp 扰动副本（负样本场景） ----------

function makeTmpCorpus() {
  const root = mkdtempSync(join(tmpdir(), 'prompt-corpus-'))
  mkdirSync(join(root, 'skills', 'expert-orchestration'), { recursive: true })
  mkdirSync(join(root, GESTURES_DIR), { recursive: true })
  cpSync(join(repoRoot, EXPERTS_DIR), join(root, EXPERTS_DIR), { recursive: true })
  cpSync(join(repoRoot, GESTURES_DIR), join(root, GESTURES_DIR), { recursive: true })
  cpSync(join(repoRoot, METHODS_DIR), join(root, METHODS_DIR), { recursive: true })
  return root
}

// ---------- 纯函数用例 ----------

test('normalizeBody: 剥 frontmatter、去空白/标点（含中文标点）、小写', () => {
  assert.equal(normalizeBody('---\nname: x\n---\n你好， 世界！\nnext\tstep'), '你好世界nextstep')
  assert.equal(normalizeBody('A, B; C?'), normalizeBody('a b c'))
  assert.equal(normalizeBody(''), '')
})

test('dice: 自反=1、对称、无关内容趋低', () => {
  const a = normalizeBody('alpha beta gamma')
  const b = normalizeBody('alpha beta delta')
  assert.equal(dice(a, a), 1)
  assert.equal(dice(a, b), dice(b, a))
  assert.ok(dice(a, b) > 0.5 && dice(a, b) < 1)
  assert.ok(dice(normalizeBody('完全不同的内容'), normalizeBody('utterly different words')) < 0.2)
})

test('simLimit: 组内取目录上界、跨组取 cross 上界', () => {
  assert.equal(simLimit('skills/expert-orchestration/experts/a.md', 'skills/expert-orchestration/experts/b.md'), 0.80)
  assert.equal(simLimit('expert-methods/a.md', 'expert-methods/b.md'), 0.50)
  assert.equal(simLimit('skills/expert-gestures/expert-a.md', 'skills/expert-gestures/expert-b.md'), 0.97)
  assert.equal(simLimit('skills/expert-orchestration/experts/a.md', 'expert-methods/a.md'), 0.60)
})

// ---------- 真实 corpus 正向用例 ----------

test('真实 corpus：清单对账全绿（readdir × readRoster × 手势双射 × method 引用闭包）', () => {
  assert.deepEqual(problemsOf(repoRoot, '清单'), [])
})

test('真实 corpus：每文件非空且 frontmatter 必备键齐全（按目录实测键集）', () => {
  assert.deepEqual(problemsOf(repoRoot, '内容'), [])
  // 键集本身是从实测事实出发的可校验副产品：28 个 corpus 文件被枚举到
  const n = (d) => listMd(repoRoot, d).length
  assert.equal(n(EXPERTS_DIR) + n(METHODS_DIR) + n(GESTURES_DIR), 28)
  assert.ok(n(EXPERTS_DIR) >= 11 && n(GESTURES_DIR) >= 11 && n(METHODS_DIR) >= 6)
})

test('真实 corpus：两两归一化重复度均在实测上界内', () => {
  assert.deepEqual(problemsOf(repoRoot, '相似度'), [])
})

// ---------- 负样本自检（tmp 扰动副本，证明四类负路径均能判错） ----------

test('负样本·前置：未扰动的 tmp 副本 checkCorpus 全绿（证明后续翻红由扰动导致）', () => {
  const root = makeTmpCorpus()
  try {
    assert.deepEqual(checkCorpus(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('负样本·清单漏文件：删专家 .md → 手势残留翻红；增专家 .md → 手势缺失翻红', () => {
  // 删：experts 少一个 → 其手势文件成为生成面之外的残留
  const rootA = makeTmpCorpus()
  try {
    rmSync(join(rootA, EXPERTS_DIR, 'data-analyst.md'))
    const ps = problemsOf(rootA, '清单')
    assert.ok(ps.some((p) => /清单漏文件/.test(p.msg) && p.msg.includes('expert-data-analyst.md')), `应报手势残留，实际：${JSON.stringify(ps)}`)
  } finally {
    rmSync(rootA, { recursive: true, force: true })
  }
  // 增：合法 frontmatter 的新专家 → 派生手势文件缺失
  const rootB = makeTmpCorpus()
  try {
    writeFileSync(join(rootB, EXPERTS_DIR, 'ghost-expert.md'), '---\nname: ghost-expert\ntitle: 幽灵专家\n适用任务: 测试负样本\n---\n正文\n')
    const ps = problemsOf(rootB, '清单')
    assert.ok(ps.some((p) => /清单漏文件/.test(p.msg) && p.msg.includes('expert-ghost-expert.md')), `应报手势缺失，实际：${JSON.stringify(ps)}`)
  } finally {
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('负样本·文件空：清空 methods 与 gestures 文件均翻红', () => {
  const root = makeTmpCorpus()
  try {
    writeFileSync(join(root, METHODS_DIR, 'tech-writer.md'), '')
    writeFileSync(join(root, GESTURES_DIR, 'expert-generalist.md'), '')
    const ps = problemsOf(root, '内容')
    assert.ok(ps.some((p) => p.msg.includes('文件为空') && p.msg.includes(join(METHODS_DIR, 'tech-writer.md'))), `应报空文件，实际：${JSON.stringify(ps)}`)
    assert.ok(ps.some((p) => p.msg.includes('文件为空') && p.msg.includes('expert-generalist.md')), `应报空文件，实际：${JSON.stringify(ps)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('负样本·frontmatter 缺键：expert 缺 title / gesture 缺 description 均翻红', () => {
  const root = makeTmpCorpus()
  try {
    // parseExpertFile 只强制 name（title 为 lib 层可选键）；corpus 面必备键由本测试口径强制
    writeFileSync(join(root, EXPERTS_DIR, 'generalist.md'), '---\nname: generalist\n适用任务: 兜底\n---\n正文\n')
    const gestureRaw = readFileSync(join(root, GESTURES_DIR, 'expert-generalist.md'), 'utf-8')
    const noDesc = gestureRaw.split('\n').filter((l) => !/^description:/.test(l)).join('\n')
    writeFileSync(join(root, GESTURES_DIR, 'expert-generalist.md'), noDesc)
    const ps = problemsOf(root, '内容')
    assert.ok(ps.some((p) => p.msg.includes('generalist.md') && p.msg.includes('缺必备键 title')), `应报缺 title，实际：${JSON.stringify(ps)}`)
    assert.ok(ps.some((p) => p.msg.includes('expert-generalist.md') && p.msg.includes('缺必备键 description')), `应报缺 description，实际：${JSON.stringify(ps)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('负样本·重复度超限：内容整份复制 → 重复率 1.0 具名翻红', () => {
  const root = makeTmpCorpus()
  try {
    writeFileSync(join(root, METHODS_DIR, 'code-reviewer.md'), readFileSync(join(root, METHODS_DIR, 'backend-engineer.md'), 'utf-8'))
    const ps = problemsOf(root, '相似度')
    assert.ok(
      ps.some((p) => p.msg.includes('重复度超限') && p.msg.includes('code-reviewer.md') && p.msg.includes('backend-engineer.md') && p.msg.includes('1.0000')),
      `应具名报出重复对与重复率，实际：${JSON.stringify(ps)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
