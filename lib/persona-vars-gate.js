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
import { readFileSync } from 'node:fs'

export const ALLOWED_PERSONA_VARS = new Set(['provider', 'model'])

const PERSONA_ID_RE = /^(\s*)-\s+id:\s*persona\s*(?:#.*)?$/
const BLOCK_SCALAR_RE = /^(\s*)([A-Za-z-]+|\?[\s\S]*?):\s*(?:['"][^'"]*['"]\s*)?([|>][+-]?[0-9]*)(?:\s+#.*)?$/
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

// 扫描若干文件，返回 { ok, violations }。违规含：文件缺失、无 persona 块、
// persona 块内出现不在 {provider, model} 白名单内的 {{变量}}。
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
    const personaLines = extractPersonaLines(text)
    if (personaLines.length === 0) {
      violations.push({ file, kind: 'no-persona-block', message: 'persona-vars gate: 未找到 persona 块（- id: persona），不静默跳过' })
      continue
    }
    for (const line of personaLines) {
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
