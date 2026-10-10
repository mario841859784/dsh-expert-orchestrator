// lib/persona-vars-gate.js — 发布门禁⑦：persona 模板变量静态扫描（零依赖）。
// 语义（.expert-lessons.md:271）：扫描 cordis.patch.yml / agent.cordis.yml 的
// persona 块，断言 {{变量}} ⊆ {provider, model}。背景：2.9.0 曾因 persona
// suffix 引用 {{cwd}} 带病发布（宿主组装期 unknown prompt variable 即抛）。
//
// 无 yaml 依赖，用文本状态机实现（package.json 无 dependencies，禁止为门禁
// 引入新依赖；文件内还有 !!js 标签，通用 YAML 解析器也需额外配置 js 支持）：
//   1. persona 块边界：`- id: persona` 行开启，缩进回到同级 `- ` 列表项或
//      更浅缩进即结束（跟踪块标量延续行，`>`/`|-` 折叠不漏行——经验提示①）。
//   2. 注释行豁免：块标量之外以 # 起始的行是 YAML 注释，不参与宿主插值，
//      其中的 {{变量}} 不判违规（agent.cordis.yml:57 的 {{cwd}} 解释性注释
//      即此类，必须通过）；块标量内的 # 行是字面内容，照常扫描（经验提示②）。
//   3. 目标文件缺失（ENOENT）或未找到 persona 块均判 fail，不静默跳过。
//   4. *.md 目标（expert persona / gesture md，dsh-expert-292 T1-③）：不适用
//      1–2 的 YAML 语义——剥 frontmatter 后全文按字面内容扫描，注释豁免不适用，
//      无 persona 块要求（详见 extractMdLiteralLines 注释）。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const ALLOWED_PERSONA_VARS = new Set(['provider', 'model'])

const PERSONA_ID_RE = /^(\s*)-\s+id:\s*persona\s*(?:#.*)?$/
// 键名放宽（dsh-expert-292 T1-②）：[A-Za-z-]+ → [\w.-]+，覆盖数字/下划线/点键名
// （如 v2.0: |-、prompt_1: |-、2nd: |-）。与 ?: 复杂键分支互斥无歧义（? 不在
// [\w.-] 类内）：复杂键形态仍由 \?[\s\S]*? 分支识别。残差留档（fail-open 方向，
// 现行仓库目标无此形态）：键名含类外字符（?、引号外特殊符号）的块标量不识别，
// 其内缩进 # 行可能被注释豁免误放过——识别失败只会漏报、不会把字面内容误判违规。
const BLOCK_SCALAR_RE = /^(\s*)([\w.-]+|\?[\s\S]*?):\s*(?:['"][^'"]*['"]\s*)?([|>][+-]?[0-9]*)(?:\s+#.*)?$/
const COMMENT_RE = /^\s*#/
const TEMPLATE_VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g

function indentOf (line) {
  const m = line.match(/^[ \t]*/)
  return m ? m[0].length : 0
}

// 提取单个文本中 persona 块内的候选行（含块标量延续行，排除块外注释行）。
export function extractPersonaLines (text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let personaIndent = -1 // 当前 persona 块的 `-` 缩进；-1 = 不在 persona 块
  let scalarKeyIndent = -1 // 块标量起始 key 的缩进；-1 = 不在块标量内

  for (const line of lines) {
    if (personaIndent >= 0) {
      if (line.trim() === '') {
        out.push(line) // 空行可能在块标量中段，保留供延续判定，本身无变量
        continue
      }
      const ind = indentOf(line)
      if (scalarKeyIndent >= 0) {
        if (ind > scalarKeyIndent) {
          out.push(line) // 块标量延续行（含折叠 > 与字面 |-），# 是内容
          continue
        }
        scalarKeyIndent = -1 // 缩进回落：块标量结束
      }
      if (ind <= personaIndent) {
        personaIndent = -1 // 回到同级/更浅：persona 块结束
      } else {
        if (COMMENT_RE.test(line)) continue // persona 块内、块标量外的注释行
        out.push(line)
        const sm = line.match(BLOCK_SCALAR_RE)
        if (sm) scalarKeyIndent = indentOf(line)
        continue
      }
    }
    const pm = line.match(PERSONA_ID_RE)
    if (pm) {
      personaIndent = indentOf(line)
      out.push(line)
    }
  }
  return out
}

// ── md 形态规则（dsh-expert-292 T1-③，扫描面纳入 expert persona md）──────────
// 适用于 *.md 目标（expert persona 与 gesture md，无 `- id: persona` 行，不走
// YAML persona 块状态机）。规则定义：
//   1. frontmatter 剥离：文件以 `---` 行开启且有闭合 `---` 行时，首尾界定符及
//      其间元数据不扫（frontmatter 是技能元数据，不进提示词插值）；无闭合界定
//      符 → 宁严勿宽，全文按字面内容扫描（frontmatter 豁免不成立）。
//   2. 其余全文按字面内容扫描：md 的 `#` 是标题/正文，不是 YAML 注释——注释豁
//      免不适用，任何 {{var}} 照判违规。
//   3. md 无 persona 块要求：不做 no-persona-block 判定（该判定的对象是 YAML
//      persona 插值面；md 全文即插值面，等价于"整块都是 persona"）。
// 导出供自测。
const MD_FRONTMATTER_DELIM_RE = /^---\s*$/

export function extractMdLiteralLines (text) {
  const lines = text.split(/\r?\n/)
  if (!MD_FRONTMATTER_DELIM_RE.test(lines[0] ?? '')) return lines
  const close = lines.findIndex((l, i) => i > 0 && MD_FRONTMATTER_DELIM_RE.test(l))
  if (close === -1) return lines // frontmatter 未闭合：全文照扫（宁严勿宽）
  return lines.slice(close + 1)
}

// md 目标目录展开：目录全扫（*.md，名称排序保证输出稳定）。取舍（dsh-expert-292
// T1-③）：目录全扫而非清单式——新增专家/手势 md 自动纳入门禁，无需同步维护清
// 单；代价是删除目录会显式 fail。目录缺失判 fail（与文件缺失同语义，不静默跳
// 过），违规由调用方并入扫描结果。导出供自测。
export function listMarkdownTargets (dirs) {
  const files = []
  const violations = []
  for (const dir of dirs) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch (err) {
      violations.push({ file: dir, kind: 'missing-dir', message: `persona-vars gate: md 目标目录无法读取（不静默跳过）: ${err.code || err.message}` })
      continue
    }
    files.push(...entries.filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f)))
  }
  return { files, violations }
}

// 扫描若干文件，返回 { ok, violations }。违规含：文件缺失、无 persona 块（仅
// YAML 形态）、md 目标目录缺失、persona 块内/md 字面内容出现不在 {provider,
// model} 白名单内的 {{变量}}。
export function scanPersonaTemplateVars (files) {
  const violations = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      violations.push({ file, kind: 'missing', message: `persona-vars gate: 无法读取目标文件（不静默跳过）: ${err.code || err.message}` })
      continue
    }
    const isMd = file.endsWith('.md')
    const lines = isMd ? extractMdLiteralLines(text) : extractPersonaLines(text)
    if (!isMd && lines.length === 0) {
      violations.push({ file, kind: 'no-persona-block', message: 'persona-vars gate: 未找到 persona 块（- id: persona），不静默跳过' })
      continue
    }
    for (const line of lines) {
      for (const m of line.matchAll(TEMPLATE_VAR_RE)) {
        const name = m[1]
        if (!ALLOWED_PERSONA_VARS.has(name)) {
          violations.push({ file, kind: 'disallowed-var', variable: name, line: line.trim().slice(0, 120), message: `persona-vars gate: persona 块引用未注册提示词变量 {{${name}}}（白名单: provider, model）` })
        }
      }
    }
  }
  return { ok: violations.length === 0, violations }
}
