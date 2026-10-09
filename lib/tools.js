// 自有召唤工具（v2.3）：list_experts / summon_expert / summon_experts
//
// 参考实现：MichengAI/dsh-agency-agents src/index.ts（精读结论见
// docs/expert-tools-design.md）。与 Agency 的差异：
// - 数据源 = 合并花名册（merged/roster.json）+ roster-aliases.json 惯用名映射
//   + custom 伪来源（v2.2）；无 division 概念，分组维度为来源 ID；
// - toolFilter deny 追加 subagent/subagent_fork（被召唤专家彻底失去派生能力，
//   递归防护完全闭环——替代被移除的 maxDepth 深度控制，用户裁决）；
// - 注册失败降级为 console.error：本插件还承担 preset 部署职责，不因工具
//   注册失败而崩溃循环（Agency 是 fail-fast，此处刻意偏离）。
import { basename, join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getExpertContent } from './index.js'
import { FILE_LAYER_SOURCE_ID, globalExpertsDir, projectExpertsDir, loadFileExperts, readFileLayerPersona, resolveFileExpert } from './expert-files.js'
import { globalProfilesPath, loadExpertProfiles, profileForExpert, projectProfilesPath } from './expert-profiles.js'
import { checkOriginChain, originChainEnabled, renderOriginChainMarker } from './origin-chain.js'
import { acquireCwdWriteLock } from './cwd-lock.js'
import { createOscillationDetector, oscillationEnabled, oscillationThreshold } from './oscillation.js'
import { preflightEffort } from './effort-preflight.js'
import { budgetMaybeEnabled, budgetNoticeFromEnvelope } from './budget.js'
import { idleReclaimEnabled, selectIdleReclaimTasks, IDLE_RECLAIM_MAX_TASKS, IDLE_RECLAIM_OWNER } from './idle-reclaim.js'

// defineTool 来自 @deepseek-ai/dsh-tools（peerDependencies 声明，宿主环境经
// pnpm auto-install-peers 可解析）。开发/沙箱环境解析失败时降级为恒等包装
// ——descriptor 原样交给 ctx.tools.register（真实宿主用真实 defineTool）。
let defineTool = (d) => d
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  console.warn('[dsh-expert-orchestrator] @deepseek-ai/dsh-tools not resolvable — using identity defineTool fallback')
}

const SUMMON_CONCURRENCY = 4
/** 单条任务的 Unicode 码点上限（与 Agency 一致）。 */
const SUMMON_TASK_MAX_CHARS = 8000
const MAX_PERSONA_CHARS = 100000
/** 每专家经验池注入预算上限（P1）。 */
const EXPERT_LESSON_MAX_CHARS = 2000
const EXPERT_LESSONS_DIRNAME = 'expert-lessons'
const EXPERT_METHODS_DIRNAME = 'expert-methods'
/** persona 深读区分隔标记（P2）：标记之前 = 注入子代理的瘦 persona。 */
const METHODS_CUT_MARKER = '<!-- methods-cut -->'
const CUSTOM_SOURCE_ID = 'custom'
const CORE_SOURCE_ID = 'bundled-core'

/** 递归防护 deny 清单：召唤工具 + 通用派生工具。
 *  维护约定：新增任何可派生子代理的工具时必须同步本表，否则开出递归侧门。 */
export const EXPERT_TOOLS_DENY_LIST = Object.freeze([
  'list_experts',
  'summon_expert',
  'summon_experts',
  'subagent',
  'subagent_fork',
  'workflow',
])

/** 宿主 restrictableNames 动态求交（T26 #21，WP-7 ③：deny 列表与宿主 restrictableNames
 *  动态求交）：宿主 ToolRuntime 对 restrict() 只收「已注册的全局工具名」，本函数按可用
 *  seam 求出该名字集合——① tools.schemas() 枚举面（一次性批量，最权威；返回空数组视为
 *  不可用——空枚举若照信会把 deny 清成空集，fail-safe 保守回退）；② 逐名 get() 探测
 *  （T9 缺陷 A 既有机制，seam 缺 schemas 时仍可用）；③ 两者皆缺 → names: null（调用方
 *  原样传递，退回宿主报错，不静默）。导出供自测。 */
export function hostRestrictableNames(ctx) {
  if (typeof ctx?.tools?.schemas === 'function') {
    try {
      const names = (ctx.tools.schemas() ?? [])
        .map((s) => s?.name)
        .filter((n) => typeof n === 'string' && n)
      if (names.length > 0) return { mode: 'schemas', names }
    } catch { /* 枚举面异常 → 逐名探测兜底 */ }
  }
  if (typeof ctx?.tools?.get === 'function') return { mode: 'probe', names: null }
  return { mode: 'none', names: null }
}

/** 递归防护 deny 名单按宿主实际注册过滤（T9 缺陷 A）：宿主 tools.restrict()
 *  对未知名直接抛错（dsh-tools 校验 known global tools），而部署差异可能使
 *  名单含宿主未注册的工具名（如 subagent 只在部分部署面存在）。求交通道见
 *  hostRestrictableNames（schemas 枚举批量 → get 逐名探测 → 原样传递）；被剔除的名
 *  逐个 console.warn——未注册名本就不可见，剔除不放宽防护；seam 异常时保守原样
 *  传递（退回宿主报错，不静默）。label 仅影响告警文案（deny/allow 共用同一
 *  探测纪律；#19 档案 tools.allow 白名单同样经本函数过滤）。导出供自测。 */
export function filterRestrictableTools(ctx, names, label = 'deny') {
  const host = hostRestrictableNames(ctx)
  if (host.mode === 'schemas') {
    const set = new Set(host.names)
    return names.filter((name) => {
      if (set.has(name)) return true
      console.warn(`[dsh-expert-orchestrator] toolFilter ${label} 跳过宿主未注册的全局工具：${name}`)
      return false
    })
  }
  if (host.mode === 'probe') {
    return names.filter((name) => {
      try {
        if (ctx.tools.get(name) !== undefined) return true
        console.warn(`[dsh-expert-orchestrator] toolFilter ${label} 跳过宿主未注册的全局工具：${name}`)
        return false
      } catch {
        return true
      }
    })
  }
  return [...names]
}

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

function readJsonFile(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** 导出供自测（test/tools.selftest.mjs）：正常 / 文件缺失 / 损坏 JSON 语义。 */
export function loadRoster(dst) {
  return readJsonFile(join(dst, 'expert-sources', 'merged', 'roster.json'))
}

/** 导出供自测（test/tools.selftest.mjs）：正常 / 文件缺失 / 损坏 JSON 语义。 */
export function loadAliases(dst) {
  return readJsonFile(join(dst, 'skills', 'expert-orchestration', 'roster-aliases.json'))
}

function loadCustomExperts(dst) {
  return readJsonFile(join(dst, 'expert-sources', 'custom-experts.json'))
}

/** roster.json → 可召唤候选（core + 各来源 files；剔除 shadowed——同名非代表
 *  副本不可召唤，代表才是该专家）。custom 伪来源条目同样进入候选。 */
export function rosterCandidates(roster) {
  const out = []
  for (const e of roster?.core ?? []) {
    if (!e || typeof e.file !== 'string') continue
    out.push({
      source: e.source ?? CORE_SOURCE_ID,
      file: e.file,
      name: e.name ?? null,
      title: e.title ?? null,
      shadowed: false,
      disabled: !!e.disabled,
    })
  }
  for (const s of roster?.sources ?? []) {
    for (const e of s.files ?? []) {
      if (!e || typeof e.file !== 'string') continue
      out.push({
        source: e.source ?? s.id,
        file: e.file,
        name: e.name ?? null,
        title: e.title ?? null,
        shadowed: !!e.shadowed,
        disabled: !!e.disabled,
      })
    }
  }
  return out
}

/** 委派名解析：① 花名册 name 精确命中（含 zh 包中文名）② roster-aliases 惯用
 *  名命中 ③ 无歧义 title 归一命中；多候选 → ambiguous（附清单）；shadowed /
 *  disabled → 对应拒绝原因。 */
export function resolveExpert(candidates, aliases, query) {
  const q = norm(query)
  if (!q) return { ok: false, reason: 'missing' }
  let hits = candidates.filter((e) => norm(e.name) === q)
  if (hits.length === 0) {
    const alias = aliases?.aliases?.[query]
    if (alias?.source && alias?.path) {
      hits = candidates.filter((e) => e.source === alias.source && e.file === alias.path)
    }
  }
  if (hits.length === 0) {
    const titled = candidates.filter((e) => norm(e.title) === q)
    if (titled.length === 1) hits = titled
    else if (titled.length > 1) return { ok: false, reason: 'ambiguous', candidates: titled }
  }
  if (hits.length === 0) return { ok: false, reason: 'missing' }
  if (hits.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: hits,
    }
  }
  const expert = hits[0]
  if (expert.disabled) return { ok: false, reason: 'expertDisabled', expert }
  if (expert.shadowed) return { ok: false, reason: 'expertShadowed', expert }
  return { ok: true, expert }
}

/** 模板括号中和（P3）：persona 含 `{{ github.sha }}` 等 CI 模板片段时，宿主
 *  dsh-system-prompt 的 interpolate() 会把 `{{name}}` 当变量引用解析——名字含
 *  点或未注册一律 throw（且无任何转义机制）。注入前把所有 `{{`/`}}` 替换为
 *  `«`/`»`，保证输出零双花括号、解析器永不命中；单花括号 `{a}` 不受影响。
 *  纯函数、确定性，导出供自测。 */
export function neutralizePromptTemplates(text) {
  if (typeof text !== 'string') return text
  return text.replaceAll('{{', '«').replaceAll('}}', '»')
}

/** persona 注入前净化：剥离 frontmatter（防 frontmatter 注入面）→ 清理控制
 *  字符（保留 \n \t）→ 模板括号中和（防宿主 interpolate 解析 persona 内
 *  `{{name}}` 片段）→ 长度上限截断。 */
export function sanitizePersona(text) {
  if (typeof text !== 'string') return ''
  let out = text
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(out)
  if (fm) out = out.slice(fm[0].length)
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  out = neutralizePromptTemplates(out)
  if (out.length > MAX_PERSONA_CHARS) out = out.slice(0, MAX_PERSONA_CHARS)
  return out.trim()
}

/** 每专家经验池 slug（P1）：由花名册候选的 source/file 派生稳定文件名——
 *  source 作前缀使跨源重名天然消歧；非 [A-Za-z0-9._-] 字符（含路径分隔符）
 *  归一为 '-'。纯函数、确定性，导出供 T7 文档与自测引用。 */
export function expertLessonSlug(source, file) {
  const raw = `${source ?? 'unknown'}--${String(file ?? '').replace(/\.md$/, '')}`
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 每专家经验池（P1）：只读 <dst>/expert-lessons/<slug>.md——existsSync 静默
 *  缺失返 null；净化复用 sanitizePersona（剥 frontmatter/控制字符）；2K 截断
 *  控注入预算。绝不自动写入：教训入库由编排者收尾裁剪。 */
export function loadExpertLessons(dst, slug) {
  if (!slug) return null
  const p = join(dst, EXPERT_LESSONS_DIRNAME, `${slug}.md`)
  if (!existsSync(p)) return null
  let out = sanitizePersona(readFileSync(p, 'utf-8'))
  if (out.length > EXPERT_LESSON_MAX_CHARS) out = out.slice(0, EXPERT_LESSON_MAX_CHARS)
  return out
}

/** 任务文本尾部追加经验提示（P1）：无命中 = 原样返回（行为零变化，向后兼
 *  容）。放尾部与协议 §5 缓存组版（变量段后置）一致，不破坏固定前缀。导出
 *  供自测。 */
export function withLessonHint(taskText, expertName, lesson) {
  if (!lesson) return taskText
  return `${taskText}\n\n【经验提示｜来自 ${expertName ?? '专家'} 历次任务沉淀】\n${lesson}`
}

/** persona frontmatter 的 method 键提取（P2）：必须在 sanitizePersona 之前对
 *  原文调用（sanitize 会剥掉 frontmatter）。无 frontmatter 或无该键 → null
 *  （来源包专家无此键 = 行为零变化）。导出供自测。 */
export function extractPersonaMethod(raw) {
  if (typeof raw !== 'string') return null
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!fm) return null
  const m = /^method:[ \t]*(\S[^\r\n]*)$/m.exec(fm[0])
  return m ? m[1].trim() : null
}

/** persona 方法论分层（P2）：frontmatter 带 method 键且净化后 body 含
 *  <!-- methods-cut --> 标记时，子代理 persona = 标记之前部分 + 尾加 method
 *  指针行；method 值 = 相对 dst 的路径且必须落在 expert-methods/ 下（防上游
 *  persona 把 dst 内任意文件路径指给子代理）。
 *  fail-safe：无标记 / 无 method / 非 expert-methods/ 前缀 / method 文件缺失 /
 *  路径可疑（绝对路径或越过 dst）一律回退全文注入（向后兼容，来源包专家不受
 *  影响）。导出供自测。
 */
export function splitPersona(dst, persona, method) {
  if (!method || typeof persona !== 'string' || typeof dst !== 'string') return persona
  const cut = persona.indexOf(METHODS_CUT_MARKER)
  if (cut === -1) return persona
  if (!method.startsWith(`${EXPERT_METHODS_DIRNAME}/`)) return persona
  if (/^(?:[a-z]+:)?[/\\]/i.test(method) || method.split(/[/\\]/).includes('..')) return persona
  const methodAbs = join(dst, method)
  if (!existsSync(methodAbs)) return persona
  return `${persona.slice(0, cut).trimEnd()}\n\n领域方法论全文在 ${methodAbs}，任务复杂或触及清单场景时先 read 再动手`
}

// ── WP-6 余项 #17 prompt 瘦身 + #19 per-expert 档案生效面（T15）──────────────
// #17（学 dsh-plugin-subagent-roles trim.js，调研 D-subagent-ecosystem §5）：
// persona 收窄了工具的专家，其 system prompt 里对应工具的 guidance 段落是死重，
// 应在 persona 组装处一并剪掉。剪除的判定依据=专家档案（#19）的收窄清单——无档
// 案=全量（persona 逐字节零变化，向后兼容硬要求）；剪除只在本组装函数一处实现
// （不散落运行时字符串过滤）。
//
// persona 段标记约定（沿 v2.4.0 `<!-- methods-cut -->` 的 HTML 注释先例）：
//   <!-- tools: NAME[, NAME]... -->   段首：本段 guidance 依赖的工具名清单
//   ...guidance...
//   <!-- /tools -->                   段尾
// 剪除规则（trim.js ②组段语义）：段内点名的工具**全部**不可见才剪整段（含标
// 记）；任一可见即保留（保留段的原标记原样留在 persona——源文本最小变换）。
// fail-safe（对齐 methods-cut 回退全文）：无收尾标记的开段、空名单标记、标记
// 语法残缺一律不剪（宁留勿删；不支持嵌套段——开段之后首个收尾标记闭段）。
const TOOLS_SECTION_OPEN_RE = /<!--\s*tools:([^>]*?)-->/g
const TOOLS_SECTION_CLOSE_RE = /<!--\s*\/tools\s*-->/

/** 解析 persona 中的工具段标记：返回配对段清单 [{start, end, tools}]（start/end
 *  覆盖**含两端标记本体**的完整区间，剪除即整段移除）。顺序扫描、不支持嵌套：
 *  开段与其后首个收尾标记配对，已被前一配对段吞掉的嵌套开段不再参与配对。
 *  导出供自测。 */
export function parseToolGuidanceSections(persona) {
  const sections = []
  if (typeof persona !== 'string') return sections
  let cursor = 0
  for (const open of persona.matchAll(TOOLS_SECTION_OPEN_RE)) {
    if (open.index < cursor) continue // 已被前一配对段吞掉（不支持嵌套）
    const contentStart = open.index + open[0].length
    const rest = persona.slice(contentStart)
    const close = TOOLS_SECTION_CLOSE_RE.exec(rest)
    if (!close) break // 开段无收尾：fail-safe 不剪，其后不再配对
    const end = contentStart + close.index + close[0].length
    const tools = open[1].split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean)
    sections.push({ start: open.index, end, tools })
    cursor = end
  }
  return sections
}

/** #17 persona 组装处剪除（唯一实现点，纯函数）：isAvailable(toolName) → 该工具
 *  对本专家是否可见；点名的工具全部不可见的配对段整段剪除（含两端标记）。无剪
 *  除发生时逐字节原样返回（零变化保证）；发生剪除时仅折叠多余空行。导出供自测。 */
export function pruneUnavailableToolSections(persona, isAvailable) {
  if (typeof persona !== 'string' || typeof isAvailable !== 'function') return persona
  const sections = parseToolGuidanceSections(persona)
  const pruned = sections.filter((s) => s.tools.length > 0 && s.tools.every((t) => !isAvailable(t)))
  if (pruned.length === 0) return persona
  let out = ''
  let cursor = 0
  for (const s of pruned) {
    out += persona.slice(cursor, s.start)
    cursor = s.end
  }
  out += persona.slice(cursor)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** #19 档案 → MCP 白名单展开为 deny 名单：宿主提供 tools.schemas() 枚举面时，
 *  把所有 mcp__* 工具中不属于白名单 server（mcp__<server>__ 前缀）的具名工具
 *  收进 deny（它们本就注册在案，探测过滤必然保留）；宿主无枚举面（旧代宿主）
 *  → 返回 null（调用方降级可见，不猜名字——restrict 对未知名会 fail-fast）。
 *  导出供自测。 */
export function expandMcpWhitelistDeny(ctx, servers) {
  if (!Array.isArray(servers) || servers.length === 0) return []
  if (typeof ctx?.tools?.schemas !== 'function') return null
  const prefixes = servers.map((s) => `mcp__${s}__`)
  const deny = []
  try {
    for (const schema of ctx.tools.schemas()) {
      const name = schema?.name
      if (typeof name !== 'string' || !name.startsWith('mcp__')) continue
      if (!prefixes.some((p) => name.startsWith(p))) deny.push(name)
    }
  } catch (err) {
    console.warn(`[dsh-expert-orchestrator] MCP 白名单展开失败（该字段本次召唤未生效）：${err?.message ?? err}`)
    return null
  }
  return deny
}

/** #19 档案 → summon 生效面（T15）：profile=null → null（调用方走既有无档案
 *  路径，逐字节零变化）。有档案 → { toolFilter, isToolAvailable }：
 *  - toolFilter：allow 白名单（探测过滤；**空 allow 原样传空——fail closed 绝
 *    不静默放宽**，roles 先例）+ deny 黑名单（递归防护清单 ∪ 档案 deny ∪ MCP
 *    白名单展开，求并后探测过滤——递归防护永不放宽）；
 *  - isToolAvailable：#17 剪除判定的可见性谓词（deny 命中→不可见；allow 存在
 *    且不含→不可见；探测 API 缺失/异常→按可见处理，fail-safe 宁留勿删）。
 *  导出供自测。 */
export function resolveProfileEffect(ctx, profile) {
  if (!profile) return null
  const denyNames = [...EXPERT_TOOLS_DENY_LIST, ...(profile.tools?.deny ?? [])]
  const mcpDeny = expandMcpWhitelistDeny(ctx, profile.mcp)
  if (mcpDeny === null) {
    console.warn('[dsh-expert-orchestrator] 宿主未提供工具枚举面（tools.schemas），专家档案 mcp 白名单本次召唤未生效（降级可见）')
  } else {
    denyNames.push(...mcpDeny)
  }
  const allowNames = Array.isArray(profile.tools?.allow) ? profile.tools.allow : null
  const dedup = (list) => [...new Set(list)]
  const toolFilter = allowNames
    ? { allow: dedup(filterRestrictableTools(ctx, allowNames, 'allow')), deny: dedup(filterRestrictableTools(ctx, denyNames)) }
    : { deny: dedup(filterRestrictableTools(ctx, denyNames)) }
  const denySet = new Set(denyNames)
  const allowSet = allowNames ? new Set(allowNames) : null
  const probe = (name) => {
    try {
      if (typeof ctx?.tools?.get !== 'function') return true
      return ctx.tools.get(name) !== undefined
    } catch {
      return true
    }
  }
  const isToolAvailable = (name) => {
    if (denySet.has(name)) return false
    if (allowSet && !allowSet.has(name)) return false
    return probe(name)
  }
  return { toolFilter, isToolAvailable }
}

/** #19 档案 skills 白名单的提示级约束注入（T15）：宿主 start request 无 per-child
 *  技能缝（两代一致可用的只有提示级），白名单以固定格式约束行注入 persona 尾部
 *  ——确定性可断言、如实声明为提示级。无 skills 字段 → 原样返回（零变化）。导出
 *  供自测。 */
export function withProfileConstraints(persona, profile) {
  const skills = profile?.skills
  if (!Array.isArray(skills) || skills.length === 0) return persona
  return `${persona}\n\n【专家档案约束】可用技能白名单：${skills.join('、')}；白名单之外的技能一律不要调用。`
}

// ── WP-4a 派工即回写（auto-claim）：派发入口先 claim、后跑专家 ────────────
// 设计（v2.6-plan WP-4 ①，回炉第 1 轮改时序）：summon 类工具在派发入口——
// 专家 run 开始**之前**——从任务文本解析显式 T<数字> token，在唯一任务板上自
// 动 claim（ready→running + owner=被召唤专家名），保证专家拿到任务书时条目
// 已 running。专家执行失败/召唤失败时条目保持 running，不回滚（fail-open），
// 由编排者按板处置（reassign/fail）。复用 taskboard.py 子进程（不回刻板文件
// 格式）；板定位只认 <cwd>/.expert-taskboards/ 顶层 *.json 且恰好一个；任何
// 失败 fail-open——只产出可见提示行，绝不阻塞 summon 主流程。taskboard.py
// 按模块相对解析（生产=部署副本 <dst>/lib/../skills/...，自测=仓库同构布局），
// 两端同构。
const TASKBOARD_PY = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const BUS_PY = fileURLToPath(new URL('../skills/expert-orchestration/tools/bus.py', import.meta.url))
const AUTOCLAIM_TIMEOUT_MS = 15000
const AUTOCLAIM_MAX_IDS = 8

/** 解析任务文本中显式引用的任务 id（T<数字> token）：前后不得紧邻 ASCII 字
 *  母/数字/下划线（宁漏勿错——排除 T7x/AT7/T7_ 之类非显式片段），中文紧邻
 *  允许（「任务T7」是显式引用）。另排除两类回炉第 1 轮明确的误伤源：
 *  ① 命令引述形态——T<数字> 前邻 `claim/done/progress/show/deps` + 空白
 *  （引述 taskboard 命令，非本次派工目标）；
 *  ② 路径形态——T<数字> 前邻 `/`、`.`、`-`（如 build/T3-report.md）。
 *  去重保序；完整列表（不截断）由内部 parseTaskIdList 返回，导出的
 *  parseTaskIds 截到 AUTOCLAIM_MAX_IDS 个（超出部分宁漏勿错）。残余误伤类
 *  （同句提及的其他任务 id）在 SKILL.md §3 写明，缓解条件=仅 ready+无 owner
 *  才 claim。导出供自测。 */
const TASK_ID_RE = /(?<![A-Za-z0-9_/.-])T\d+(?![0-9A-Za-z_])/g
// 前缀以「命令动词 + 可选空白」结尾即视为命令引述（大小写不敏感，宁漏勿错）
const TASK_CMD_PREFIX_RE = /(?:^|[^\p{L}\p{N}])(?:claim|done|progress|show|deps)[ \t]*$/iu

function parseTaskIdList(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const m of text.matchAll(TASK_ID_RE)) {
    if (TASK_CMD_PREFIX_RE.test(text.slice(0, m.index))) continue
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

export function parseTaskIds(text) {
  return parseTaskIdList(text).slice(0, AUTOCLAIM_MAX_IDS)
}

/** 板定位（宁漏勿错）：仅认 <cwd>/.expert-taskboards/ 顶层 *.json 且恰好一
 *  个才动作；0 个或多个 → 不动作并给出可读原因。导出供自测。 */
export function locateAutoClaimBoard(cwd) {
  try {
    const dir = join(cwd, '.expert-taskboards')
    const names = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort()
      : []
    if (names.length === 1) return { ok: true, board: join(dir, names[0]), name: names[0] }
    if (names.length === 0) return { ok: false, reason: 'cwd 下没有 .expert-taskboards/*.json 任务板' }
    return { ok: false, reason: `cwd 下有多个任务板（${names.join('、')}），无法唯一定位` }
  } catch (error) {
    return { ok: false, reason: `任务板目录不可读：${error?.message ?? error}` }
  }
}

/** taskboard.py 子进程封装：超时/退出码/非 JSON 输出都归一为结果对象，不抛出。
 *  timedOut 与普通非零退出分开标记——超时提示语必须与「板不可读/任务不存在」
 *  可区分（回炉第 1 轮 💭3）。env 可注入（T27 预算盘点自测用；缺省 process.env
 *  与 execFile 既有行为逐字节一致）。 */
function runTaskboard(cwd, args, timeoutMs = AUTOCLAIM_TIMEOUT_MS, env = process.env) {
  return new Promise((resolve) => {
    execFile('python3', [TASKBOARD_PY, ...args], { cwd, encoding: 'utf-8', timeout: timeoutMs, env }, (error, stdout, stderr) => {
      let json = null
      try { json = JSON.parse(String(stdout ?? '').trim()) } catch { /* 人类可读多行输出，不解析 */ }
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        json,
        timedOut: error?.killed === true || error?.signal === 'SIGTERM',
      })
    })
  })
}

/** taskboard.py --json 结构化信封解析（v2.8 S1 机器契约，T17）：--json 模式下 stdout 恰一行
 *  JSON——成功 {ok:true,cmd,data,revision}（任务中心命令 data.task=完整任务对象，含全部簿记
 *  字段），失败 {ok:false,error,...}。auto-claim 只消费结构化信封，不再断言 show 首行/尾行
 *  文本（人类可读展示层的格式演进不再影响机器消费方；旧 parseShowTask/lastRevision 文本
 *  解析器已随本改造移除）。解析不出信封（旧版 taskboard.py/输出被污染）返回 null——调用方
 *  fail-open 跳过，与旧文本解析失败同语义。 */
function parseTaskboardEnvelope(stdout) {
  try {
    const env = JSON.parse(String(stdout ?? '').trim())
    if (env && typeof env === 'object' && !Array.isArray(env) && typeof env.ok === 'boolean') return env
  } catch { /* 非信封输出（多行人类可读或空） */ }
  return null
}

/** --json 失败信封的人类可读原因优选（T32 评审备忘1，一行三档）：人读 sys.exit
 *  类拒绝（draft/非 ready 竞态等）在 stdout 信封的 **message** 字段——--json 下
 *  stderr 为空（实测），原因只在信封里，故 message 置于最高优先；BoardError 具
 *  名错误（stale_revision/stale_attempt…）无 message，落在 error 具名码；两者都
 *  取不到再以 stderr/stdout 首行兜底（非 json 面/输出被污染）。旧实现
 *  `error ?? stderr` 把 command_failed 类失败降级成常量码，且旧注释声称「人读拒
 *  绝在 stderr 首行」与 --json 行为不符——本函数一并修正。纯函数、导出供自测。 */
export function claimFailureReason(json, stderr, stdout) {
  return json?.message ?? json?.error ?? ((stderr || stdout).trim().split('\n')[0] || '未知错误')
}

/** bus.py 子进程封装：与 runTaskboard 同语义（超时/退出码归一为结果对象，不抛出）。 */
function runBus(cwd, args, timeoutMs = AUTOCLAIM_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile('python3', [BUS_PY, ...args], { cwd, encoding: 'utf-8', timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: error?.killed === true || error?.signal === 'SIGTERM',
      })
    })
  })
}

/** WP-8 ①：宿主设置页 autoClaim 旋钮的读取。宿主 volatile 生效路径传入的是
 *  Volatile 引用（get() 返回不可变快照），普通路径是布尔或 undefined——鸭子
 *  判型两者都接受（帮手在 lib/host-settings.js，此处内联等价实现避免把该
 *  模块拉进工具面依赖）。 */
function resolveAutoClaimEnabled(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** 对单个任务 id 执行 show→判定→claim；任何失败都归一为提示行，绝不 throw。
 *  超时与板不可读/认领失败分别给出可区分的提示语（回炉第 1 轮 💭3）。
 *  v2.8 S1（T17）：show/claim 均走 --json 结构化信封——任务状态/owner/revision 从
 *  data.task 与信封顶层 revision 读取，不再解析人类可读首行与 revision 尾行文本。
 *  tag（T28 #20）：提示行标签，缺省 'auto-claim'（WP-4a 派工即回写既有文案逐字节
 *  不变）；idle-edge 自动续领复用本函数时传 '自动续领'——同一 claim 执行面、两种
 *  触发来源在提示行可区分。 */
async function autoClaimOne(board, id, owner, cwd, timeoutMs, tag = 'auto-claim') {
  const show = await runTaskboard(cwd, ['--board', board, '--json', 'show', id], timeoutMs)
  if (show.code !== 0) {
    if (show.timedOut) {
      return `【${tag}】${id} 认领前置检查超时（taskboard.py ${timeoutMs}ms 无响应），跳过认领`
    }
    return `【${tag}】${id} 不在任务板或板不可读，跳过认领`
  }
  const env = parseTaskboardEnvelope(show.stdout)
  const task = env?.ok === true ? env.data?.task : null
  if (!task) return `【${tag}】${id} 任务板输出无法解析，跳过认领`
  if (task.status !== 'ready') {
    return `【${tag}】${id} 状态为 ${task.status}${task.owner ? `（owner=${task.owner}）` : ''}，跳过认领`
  }
  if (task.owner) return `【${tag}】${id} 已有 owner=${task.owner}，不覆盖，跳过认领`
  const rev = Number(env.revision)
  const claim = await runTaskboard(cwd, [
    '--board', board, '--json', 'claim', id, owner,
    ...(Number.isFinite(rev) ? ['--expected-revision', String(rev)] : []),
  ], timeoutMs)
  if (claim.code !== 0) {
    if (claim.timedOut) {
      return `【${tag}】${id} 认领写入超时（taskboard.py ${timeoutMs}ms 无响应；条目可能已/未被认领，请按板现状处置）`
    }
    // --json 信封错误面（T32 备忘1 修正）：人读 sys.exit 类拒绝的原因在 stdout 信封的
    // message 字段（--json 下 stderr 为空），BoardError 具名错误（stale_revision/stale_attempt…）
    // 落在 error 具名码——message ?? error 优选，stderr/stdout 首行仅作非 json 面兜底。
    const why = claimFailureReason(claim.json, claim.stderr, claim.stdout)
    return `【${tag}】${id} 认领失败（已忽略，不阻塞派工）：${why}`
  }
  return `【${tag}】${id} 已自动认领（owner=${owner}，板=${basename(board)}）`
}

/** WP-4a 入口：summon 派发入口（专家 run 开始之前）调用。任务文本无显式任务
 *  id / 开关关闭时返回 ''（零副作用，板都不查）；有 id 时定位板并逐个
 *  auto-claim，产出单行提示（多 id 用「；」连接）。调用方把提示行附在 summon
 *  结果尾部（成功）或错误信息尾部（专家执行失败），降级可见；条目一旦
 *  claimed 即保持 running，不随专家失败回滚（编排者按板处置）。claimedIds
 *  为批量召唤内去重集合：同一任务 id 只回写一次（无论成败）。id 数量上限
 *  AUTOCLAIM_MAX_IDS（8），超出取前 8 并在提示中说明截断。开关语义（回炉第
 *  1 轮 💭3；WP-8 ① 增补 enabled 参数）：DSH_EXPERT_AUTOCLAIM 为 '0' 或 '' 时
 *  整体关闭（既有环境开关，优先级不变）；enabled === false 时同样关闭（宿主
 *  设置页旋钮，见 lib/host-settings.js）——两个开关任一关闭即关，均未设置/
 *  为 true 时开启。导出供自测。 */
export async function autoClaimSummonedTasks({ taskText, owner, cwd = process.cwd(), claimedIds, timeoutMs = AUTOCLAIM_TIMEOUT_MS, enabled } = {}) {
  const flag = process.env.DSH_EXPERT_AUTOCLAIM
  if (flag === '0' || flag === '') return ''
  if (resolveAutoClaimEnabled(enabled) === false) return ''
  const all = parseTaskIdList(taskText)
  if (all.length === 0 || !owner) return ''
  const ids = all.slice(0, AUTOCLAIM_MAX_IDS)
  const truncated = all.length > AUTOCLAIM_MAX_IDS
  const located = locateAutoClaimBoard(cwd)
  if (!located.ok) {
    return `【auto-claim 跳过】${located.reason}；任务 ${ids.join('、')} 未自动认领，请按协议手工 claim`
  }
  const lines = []
  for (const id of ids) {
    if (claimedIds?.has(id)) continue
    claimedIds?.add(id) // 批量内同一 id 只回写一次（同步去重，先于任何 await）
    try {
      lines.push(await autoClaimOne(located.board, id, owner, cwd, timeoutMs))
    } catch (error) {
      lines.push(`【auto-claim】${id} 认领异常（已忽略，不阻塞派工）：${error?.message ?? error}`)
    }
  }
  const joined = lines.filter(Boolean).join('；')
  return truncated
    ? `【auto-claim】任务 id 共 ${all.length} 个，超过上限 ${AUTOCLAIM_MAX_IDS}，仅认领前 ${AUTOCLAIM_MAX_IDS} 个（${ids.join('、')}），其余请按协议手工 claim；${joined}`
    : joined
}

/** #16 预算 summon 盘点（T27）：预算开关开启且任务书显式引用任务 id 时，逐个读
 *  taskboard.py --json budget 结构化信封，经 budgetNoticeFromEnvelope 翻成达档提示行
 *  （执法面在 taskboard.py，JS 只消费信封、不复制任何计数/阈值语义——这也是 #20 自动
 *  续领判预算的复用面）。预算关闭/无任务 id/板不可唯一定位/任何单板查询失败 → ''，
 *  fail-open 绝不阻塞派工（与 auto-claim 同哲学）。env 可注入（自测；缺省 process.env）。
 *  导出供自测。 */
export async function summonBudgetHint(taskText, owner, cwd = process.cwd(), timeoutMs = AUTOCLAIM_TIMEOUT_MS, env = process.env) {
  if (!budgetMaybeEnabled(env)) return ''
  const ids = parseTaskIds(taskText)
  if (ids.length === 0 || !owner) return ''
  const located = locateAutoClaimBoard(cwd)
  if (!located.ok) return ''
  const lines = []
  for (const id of ids) {
    const r = await runTaskboard(cwd, ['--board', located.board, '--json', 'budget', id], timeoutMs, env)
    if (r.code !== 0) continue
    const line = budgetNoticeFromEnvelope(parseTaskboardEnvelope(r.stdout), owner)
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

// ── #20 idle-edge 自动续领（T28，v2.8 M8-2 / WP-7 ②）────────────────────────
// 设计与边界见 lib/idle-reclaim.js 文件头。执行落点：runExpert 受保护段入口对在途
// 专家执行计数，成功收尾且归 0（空闲边沿）时调用本扫描——板面条件不满足/板不可定位/
// 任何失败一律 fail-open 空串（summon 行为零变化）。领取复用 autoClaimOne 既有 claim
// 路径（tag='自动续领' 可区分触发来源）；owner=IDLE_RECLAIM_OWNER（编排者）——领取是
// 板面动作，绝不自动召唤专家（失控面红线，SKILL.md §3 成文）。
/** 空闲边沿续领扫描：定位唯一板 → list --json 全量任务 → selectIdleReclaimTasks 判定
 *  （有 running 整轮不动；仅 ready+无 owner 入选，上限 IDLE_RECLAIM_MAX_TASKS）→ 逐个
 *  autoClaimOne（show 实时复判 + claim 带 CAS）。返回提示行（拼接单行，'；' 分隔，与
 *  autoClaimSummonedTasks 同通道同形态）；无可续领/条件不满足/失败 → ''（零变化）。
 *  开关判定在调用方（settleIdle：关闭时不发生任何板读取）。导出供自测。 */
export async function idleReclaimSweep({ cwd = process.cwd(), timeoutMs = AUTOCLAIM_TIMEOUT_MS, owner = IDLE_RECLAIM_OWNER, max = IDLE_RECLAIM_MAX_TASKS } = {}) {
  const located = locateAutoClaimBoard(cwd)
  if (!located.ok) return '' // 板不可唯一定位：静默跳过（与 summonBudgetHint 同语义，不制造噪音）
  const lst = await runTaskboard(cwd, ['--board', located.board, '--json', 'list'], timeoutMs)
  if (lst.code !== 0) return '' // 板损坏/不可读：fail-open 空串
  const env = parseTaskboardEnvelope(lst.stdout)
  const tasks = env?.ok === true ? env.data?.tasks : null
  if (!Array.isArray(tasks)) return '' // 信封解析失败：fail-open 空串
  const sel = selectIdleReclaimTasks(tasks, { max })
  if (!sel.ok) return '' // 板上有开放执行（running）：整轮不动（负向条件①）
  if (sel.ids.length === 0) return '' // 无可续领条目：零提示零副作用
  const lines = []
  for (const id of sel.ids) {
    try {
      lines.push(await autoClaimOne(located.board, id, owner, cwd, timeoutMs, '自动续领'))
    } catch (error) {
      lines.push(`【自动续领】${id} 认领异常（已忽略，不阻塞派工）：${error?.message ?? error}`)
    }
  }
  const joined = lines.filter(Boolean).join('；')
  return sel.truncated
    ? `【自动续领】就绪任务共 ${sel.total} 个，超过上限 ${max}，仅续领前 ${max} 个（${sel.ids.join('、')}），其余请按协议手工 claim；${joined}`
    : joined
}

// ── WP-4b ④ summon 专家断点续跑（T12，用户裁决 2026-10-07 Q2=2A）─────────────
// 设计（对齐宿主 dsh-subagent 0.2.x 实测语义）：
//   新一代宿主的冷恢复硬性要求子代理 descriptor.mode === 'continuable'（one-shot
//   子会话一律 NOT_RESUMABLE）——因此 seam 可用时 summon 把专家 run 建为
//   continuable 子代理：startContinuable 建持久会话（childId 即断点锚点），turn
//   结束且信箱空时宿主自动释放 Activation 并发 subagent/end（含 stopReason 与
//   lastAssistantMessage，与 one-shot run 同词表）；中断后经 sendMessage 投递恰好
//   一个续跑 turn（缺失直接子代理按持久 descriptor 冷恢复）。旧宿主
//   0.1.7-alpha.2 的 SubagentRuntime 仅 start/getProvider（无 continuation
//   生命周期）——探测返回 null，维持现状（检查点+全新代理重跑）。
const RESUME_BUS_BOX = 'coordinator'
/** bus.py 信箱根默认 <cwd>/.expert-bus（读取命令未传 --root）：幻影闭合的交叉
 *  校验目录必须与读取命令的路径解析同源（T12 二轮回炉 major-3）。 */
const BUS_ROOT_DIRNAME = '.expert-bus'
/** 续跑判定（turn 级）：error=模型/传输故障、max-tokens=额度截断——同一持久会话
 *  续跑一 turn 有实际意义。completed=成功；aborted=取消通道（exec.signal，续跑
 *  会对抗调用方的取消）；refusal=专家明确拒绝（续跑会重复拒绝）——三者一律不
 *  续跑，按现状抛错由编排者处置。宿主进程死亡则 turn 无结算事件，本函数不感知
 *  （summon 随调用一起死，恢复交给编排者重派/adopt）。导出供自测。 */
export const RESUMABLE_STOP_REASONS = Object.freeze(['error', 'max-tokens'])
/** 断点折叠预算（导出供自测锁定不变量）：RESUME_PROGRESS_MAX_ITEMS=检查点+bus
 *  汇报共享的条目总额；RESUME_PROMPT_MAX_CHARS=清单部分的总码点预算（含截断
 *  标记行本身——T12 回炉建议1，不含 prompt 头尾固定行）。 */
export const RESUME_PROGRESS_MAX_ITEMS = 8
const RESUME_ITEM_MAX_CHARS = 400
const RESUME_PARTIAL_MAX_CHARS = 800
export const RESUME_PROMPT_MAX_CHARS = 4000

/** 疑问3 落实（T12 回炉）：宿主 dsh-subagent 0.2.1-alpha.1 对 signal 是裸调用——
 *  startContinuable 内 spec.signal.throwIfAborted()（lib/index.js:1702 等）、
 *  sendMessage 路径 options.signal.throwIfAborted()（lib/index.js:1767/:1843），
 *  均非可选链，且 d.ts 把 ContinuableStartSpec.signal 与
 *  SubagentSendMessageOptions.signal 声明为非可选 AbortSignal——exec.signal 缺省
 *  （undefined）直接透传会在宿主内 TypeError。宿主自有工具恒传 exec.signal
 *  （dsh-tool-subagent-control/lib/index.js:58），但无 signal 的工具执行面真实
 *  存在（自测 mock、宿主差异）——缺省补一张永不中止的 signal，语义=「无外部取
 *  消通道」，与 undefined 在本插件观察面（signal?.aborted 恒 false）下等价。 */
const NEVER_ABORT_SIGNAL = new AbortController().signal

/** 断点续跑 seam 探测：seam = continuation 生命周期（startContinuable +
 *  sendMessage）+ provider 的 continuable 创建能力（prepareContinuable 方法存在
 *  即能力，dsh-subagent types 原文「Method presence IS the capability」）+ 结算
 *  观察面（ctx.on 订阅 subagent/end）。任一缺失（含旧宿主、DSH_EXPERT_RESUME=
 *  '0'/'' 强制关闭）返回 null → summon 维持 one-shot 现状。导出供自测。 */
export function detectResumeSeam(ctx, provider) {
  const flag = process.env.DSH_EXPERT_RESUME
  if (flag === '0' || flag === '') return null
  const s = ctx?.subagents
  if (!s || typeof s.startContinuable !== 'function' || typeof s.sendMessage !== 'function') return null
  if (typeof provider?.prepareContinuable !== 'function') return null
  if (typeof ctx.on !== 'function') return null
  return {
    startContinuable: (spec) => s.startContinuable(spec),
    sendMessage: (sender, childId, content, options) => s.sendMessage(sender, childId, content, options),
    // 辅助面（0.2.0-rc 早期可能缺）：缺省为 null，调用点跳过（取消中断/主动释放降级）
    interrupt: typeof s.interrupt === 'function'
      ? (childId, authority) => { try { s.interrupt(childId, authority) } catch { /* fire-and-forget，取消路径不因中断失败而阻断 */ } }
      : null,
    // 辅助面（0.2.1-alpha.1 起有，minor-3 回收面）：释放指定驻留 continuable 子
    // 代理的 Activation（缺失目标/无 manager 为 no-op；持久 descriptor 保留在盘
    // ——冷恢复锚点，非删除会话）。缺省 null 时终态失败路径跳过回收。
    drainChildren: typeof s.drainContinuableChildren === 'function'
      ? (parent, childIds) => s.drainContinuableChildren(parent, childIds)
      : null,
    onSettlement: (listener) => ctx.on('subagent/end', listener),
  }
}

/** 结算观察器：订阅 subagent/end（一次 summon 一次订阅，按 childId 过滤并缓冲
 *  ——订阅先于 startContinuable，杜绝「结算先到、订阅后到」丢事件；串行等待，
 *  单 wake 槽位足够）。signal 中止时立即拒绝（不空等已死的工具调用）：泊位等待
 *  与 abort 监听竞速，堵「检查后才中止、泊位中无唤醒」的丢失唤醒窗口；拒绝前
 *  best-effort interrupt 子代理 turn（continuable 不随 signal 自灭）。导出供自测。 */
export function createSettlementWatcher(seam) {
  const events = []
  let wake = null
  let disposed = false
  const off = seam.onSettlement((info) => {
    if (!info || typeof info.id !== 'string' || typeof info.stopReason !== 'string') return
    events.push(info)
    if (wake) { const w = wake; wake = null; w() }
  })
  const abortError = () => new Error('summon 已被取消（exec.signal 中止）')
  return {
    async next(childId, signal, onAbort) {
      for (;;) {
        const idx = events.findIndex((e) => e.id === childId)
        if (idx !== -1) return events.splice(idx, 1)[0]
        if (signal?.aborted) {
          try { onAbort?.() } catch { /* 已尽力 */ }
          throw abortError()
        }
        await new Promise((resolve, reject) => {
          let offAbort = null
          const fireAbort = () => {
            wake = null
            if (offAbort) offAbort()
            try { onAbort?.() } catch { /* 已尽力 */ }
            reject(abortError())
          }
          wake = () => {
            wake = null
            if (offAbort) offAbort()
            resolve()
          }
          if (typeof signal?.addEventListener === 'function') {
            signal.addEventListener('abort', fireAbort, { once: true })
            offAbort = () => signal.removeEventListener('abort', fireAbort)
          }
        })
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      try { off?.() } catch { /* 订阅清理失败不影响结果 */ }
    },
  }
}

/** bus read 输出解析（续跑折叠来源②）：消息头 `--- <id> [未读] from=… subject=…
 *  ts=…[ seq=…][ task=… attempt=…]`，正文为后续行。解析不出的消息跳过（宁漏勿
 *  错）。task 字段保留（T12 回炉 major-1：断点折叠按任务书引用的任务 id 优选
 *  bus 汇报，需知道消息携带的任务归属；与 attempt 一样只会成对出现）。id 保留
 *  供 major-3 幻影闭合的收件箱文件名交叉校验（trustedBusMessages）。导出供自测。 */
export function parseBusMessages(stdout) {
  const out = []
  const blocks = String(stdout ?? '').split(/^--- /m).slice(1)
  for (const block of blocks) {
    const nl = block.indexOf('\n')
    const header = nl === -1 ? block : block.slice(0, nl)
    const body = nl === -1 ? '' : block.slice(nl + 1)
    const m = /^(\S+) \[[^\]]*\] from=(.*?) subject=(.*) ts=(\d+)/.exec(header)
    if (!m) continue
    // subject 贪婪到 ts= 之前的整段（subject 自身可含空格）；尾部 ts/seq/task/attempt 字段剥离
    const subject = m[3].replace(/ ts=\d+(?: seq=\d+)?(?: task=\S* attempt=\S*)?$/, '').trim()
    const task = / ts=\d+(?: seq=\d+)? task=(\S*) attempt=\S*$/.exec(header)?.[1]
    const msg = { id: m[1], from: m[2], subject, body: body.trim() }
    if (task) msg.task = task
    out.push(msg)
  }
  return out
}
// 留档（T12 残余 minor，T17 收口）：from=(.*?) 非贪婪到首个「 subject=」——from 落款名自身含
// 「 subject=」分隔串时会被截断（如 from=甲 subject=x → from='甲'），署名过滤 from===owner 随即
// 失配、该消息不折入续跑 prompt——fail-closed（宁漏勿错）方向，无注入增益（伪造 from 需先过
// trustedBusMessages 交叉校验）。bus send --from 是自由文本，协议未禁止该形态；结构化修复落地前
// 以本注释留档边界，消费方（署名过滤）行为保持现状。

/** 幻影消息闭合（T12 二轮回炉 major-3，纯只读、不动 bus.py）：bus read 正文原样
 *  输出无转义，正文内嵌/逐字转述的「--- <id> …」行会被 parseBusMessages 裂解为
 *  幻影消息，伪造或改写落款的头可绕过 from===owner 署名过滤折入续跑 prompt。两
 *  步只读闭合：
 *  ① id↔收件箱文件名交叉校验——bus.py 条目文件名 = {ts:013d}-{id}.json，取首个
 *     「-」之后即消息 id；幻影 id 在信箱目录无真实文件对应即弃（评审方案①）。
 *  ② 同 id 去重保首——逐字转述真实头的幻影 id 真实在场，①挡不住（评审采纳的方
 *     案①在转述形态下不闭合的补口）；但转述者必先读到被引消息才可能引用其 id，
 *     被引消息 ts 必更小、文件名序在前——真实消息恒先于转述幻影出现，保留首次
 *     出现即真实消息，其后同 id 皆为正文内嵌复制品。去重必须先于署名过滤：真实
 *     消息（from≠owner）需在场遮蔽改写落款的转述幻影。
 *  信箱目录与读取命令同源解析（read --box 无 --root/--since-seq/--board，
 *  --no-attempt-filter 只影响过滤不改路径）＝<cwd>/.expert-bus/<box>；目录不可
 *  读（无法核实）返回空——宁漏勿错，未核实内容一律不折入。残余边界（T12 三轮
 *  建议A 修正表述，T17 落档）：同毫秒双发或预测 id 属「可直改收件箱文件」同信任
 *  级（协议 §9 非目标）；随机段(100-999)可在单条消息正文内喷洒多候选 id，实际硬
 *  约束是「精确毫秒+pid 预测」而非猜中单个随机段；且保首时序不变量以单机单时钟
 *  为前提——跨机共享文件系统部署需重估本残余（多机时钟偏差可破「真实恒先于转述」
 *  的文件名序前提，见 T12 三轮疑问1）。导出供自测。 */
export function trustedBusMessages(messages, inboxDir) {
  let inboxIds
  try {
    inboxIds = new Set()
    for (const name of readdirSync(inboxDir)) {
      if (!name.endsWith('.json')) continue
      const dash = name.indexOf('-')
      if (dash > 0) inboxIds.add(name.slice(dash + 1, -5))
    }
  } catch {
    return [] // 信箱目录不可读（无法核实）——全部按幻影处置
  }
  const seen = new Set()
  return messages.filter((msg) => inboxIds.has(msg.id) && !seen.has(msg.id) && (seen.add(msg.id), true))
}

/** 断点数据净化截断（T12 回炉 major-2）：续跑 prompt 以 bullet 清单折入断点数据，
 *  检查点/汇报正文内嵌换行会打破清单框架、伪造后续行「指令」——先把 [\r\n]+ 扁
 *  平化为可见「 ⏎ 」标记（保留换行痕迹、消灭真实行边界），扁平前剥除每个原始行
 *  行首的 -、#、*、• 与编号标记（防伪造清单项/标题/有序列表；已知误伤：行首「3.14」
 *  类小数会被剥成「14…」，属摘要级可接受损耗）。最后统一码点截断。导出供自测
 *  间接覆盖（clamp 本身不导出）。 */
const clamp = (text, max) => {
  const t = String(text ?? '')
    .split(/[\r\n]+/)
    .map((line) => line.replace(/^\s*(?:[-#*•]+|\d{1,4}[.)、．])\s*/, '').trim())
    .filter(Boolean)
    .join(' ⏎ ')
  return [...t].length > max ? [...t].slice(0, max).join('') + '…' : t
}

/** 断点数据收集（续跑 prompt 的「已完成进度清单」来源，全部 fail-open、全程
 *  只读）：① 任务板最新检查点——show 输出的「最新检查点(N)」行（show 只输出最
 *  新一条而非全轨迹；T10 事件溯源化后检查点随事件流持久，崩溃/中断不丢；此处读
 *  人类可读面，v2.8 taskboard.py --json 结构化通道已备，迁移属后续任务不在 S1 面）；
 *  ② bus 汇报——coordinator 收件箱中落款为该专家的消息（--no-attempt-filter 纯
 *  读零副作用：不归档、不 skip-round；署名纪律保证 from=专家名）。任何失败静默
 *  跳过该项。导出供自测。 */
export async function collectResumeProgress({ taskText, owner, cwd = process.cwd(), timeoutMs = AUTOCLAIM_TIMEOUT_MS } = {}) {
  const items = []
  const ids = parseTaskIdList(taskText)
  if (ids.length) {
    const located = locateAutoClaimBoard(cwd)
    if (located.ok) {
      for (const id of ids.slice(0, AUTOCLAIM_MAX_IDS)) {
        try {
          const r = await runTaskboard(cwd, ['--board', located.board, 'show', id], timeoutMs)
          if (r.code !== 0) continue
          const line = (r.stdout ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('最新检查点('))
          if (line) items.push({ source: '任务板最新检查点', text: `${id} ${clamp(line, RESUME_ITEM_MAX_CHARS)}` })
        } catch { /* 单任务检查点读取失败不阻断折叠 */ }
      }
    }
  }
  if (owner) {
    try {
      const bus = await runBus(cwd, ['read', '--box', RESUME_BUS_BOX, '--no-attempt-filter'], timeoutMs)
      if (bus.code === 0) {
        // T12 回炉 major-1（取旧弃新修复）：bus read 输出按收件箱 ts 升序（最旧在
        // 前），按序填充会让同名专家跨任务的历史汇报占满名额、把最新最相关的汇报
        // 挤出清单，旧消息还可能混入其他任务的误导性「已完成X」——先全量署名过
        // 滤，再按相关性取尾（尾部=最新）：① task= 字段命中任务书引用任务 id 的
        // 消息优先入选（组内取尾）；② 剩余名额从其余消息尾部补齐。检查点已占名
        // 额先行扣减，两来源共享 RESUME_PROGRESS_MAX_ITEMS 总预算。
        // T12 二轮回炉 major-3：先经收件箱文件名交叉校验 + 同 id 去重保首剔除正文
        // 伪造/转述分块头裂解出的幻影消息（trustedBusMessages），再做署名过滤。
        const mine = trustedBusMessages(parseBusMessages(bus.stdout), join(cwd, BUS_ROOT_DIRNAME, RESUME_BUS_BOX)).filter((msg) => msg.from === owner)
        const slots = RESUME_PROGRESS_MAX_ITEMS - items.length
        if (slots > 0 && mine.length) {
          const idSet = new Set(ids)
          const onTask = mine.filter((msg) => idSet.has(msg.task))
          const rest = mine.filter((msg) => !idSet.has(msg.task))
          const onTaskPicked = onTask.slice(-slots)
          const restSlots = slots - onTaskPicked.length
          const picked = restSlots > 0 ? [...onTaskPicked, ...rest.slice(-restSlots)] : onTaskPicked
          for (const msg of picked) {
            items.push({ source: 'bus 汇报', text: clamp(`[${msg.subject}] ${msg.body}`, RESUME_ITEM_MAX_CHARS) })
          }
        }
      }
    } catch { /* bus 读取失败不阻断折叠 */ }
  }
  return items.slice(0, RESUME_PROGRESS_MAX_ITEMS)
}

/** 续跑 prompt 组装（恰好一个续跑 turn 的全部指令）：持久会话冷恢复会重放全部
 *  历史，原任务书无需重复；折入的是断点数据——任务板最新检查点 + bus 汇报 +
 *  中断前部分产出。无任何断点数据时显式写「无清单」并要求先落检查点（协议 §3
 *  禁止无检查点盲续）。导出供自测。 */
export function buildResumePrompt({ progress = [], partialOutput = '', expertName } = {}) {
  const lines = [
    '【断点续跑】上一次执行中断，宿主已按持久会话恢复本会话——这是恰好一次的续跑 turn：从中断点继续完成剩余工作，不要重做已完成阶段，完成后正常汇报。',
  ]
  const TRUNCATION_LINE = '- （更多断点数据超出预算已截断）'
  const list = []
  const partial = clamp(partialOutput, RESUME_PARTIAL_MAX_CHARS)
  if (partial) list.push({ source: '中断前部分产出', text: partial })
  // 注入护栏在组装帧收口（T12 回炉 major-2）：progress 各条目虽已在收集侧经
  // clamp 净化，此处再过一遍 clamp——bullet 清单框架在本函数拼装，条目文本不得
  // 携带真实换行或行首清单标记进入框架（幂等：已净化文本二次 clamp 零变化）。
  list.push(...progress.map((item) => ({ ...item, text: clamp(item?.text, RESUME_ITEM_MAX_CHARS) })))
  if (list.length) {
    lines.push('已完成进度清单（断点数据，勿重做）：')
    let budget = RESUME_PROMPT_MAX_CHARS
    // 预算口径留档（T12 残余 minor「截断标记预算边角」书面裁定，T17）：预算=断点数据清单段
    // （清单行+截断标记，与 FINDINGS_MAX_CHARS 断点数据口径对齐），帧头两行与 expertName 尾行
    // 为固定常量不计入——残余超幅是常量级（数十码点），预算是 prompt 尺寸软约束而非安全边界；
    // 改口径将推翻已锁定的清单段不变量用例，无实害不实施。
    for (const item of list) {
      const line = `- [${item.source}] ${item.text}`
      const cost = [...line].length + 1
      if (budget < cost) {
        // T12 回炉建议1：放不下即以截断标记收尾，标记行自身开销同样计入预算
        // （放不下标记就静默收尾）——清单总开销（含标记）不越过总预算。
        const markCost = [...TRUNCATION_LINE].length + 1
        if (budget >= markCost) lines.push(TRUNCATION_LINE)
        break
      }
      budget -= cost
      lines.push(line)
    }
  } else {
    lines.push('已完成进度清单：无（中断前未落检查点也未汇报）——先按任务板 progress 落一个检查点再继续，禁止无检查点盲续。')
  }
  if (expertName) lines.push(`（续跑专家：${expertName}）`)
  return lines.join('\n')
}

function textBlocks(blocks) {
  return (blocks ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function mapPool(items, concurrency, mapper) {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function renderExpertList(value) {
  const lines = [`共 ${value.total} 位有效专家（${value.sources.length} 个来源）：`]
  for (const g of value.sources) {
    lines.push(`- ${g.source}：${g.count} 位`)
    for (const e of g.experts ?? []) {
      const label = e.name ?? e.title ?? e.file
      const marks = `${e.disabled ? '（已停用）' : ''}${e.conflict ? '（跨源重名，召唤需消歧）' : ''}`
      lines.push(`    · ${label}${marks}`)
    }
    for (const e of g.shadowed ?? []) {
      lines.push(`    · ${e.name ?? e.title ?? e.file}（shadowed：去重组非代表副本，不可召唤）`)
    }
  }
  return lines.join('\n')
}

/** 注册入口：apply 内调用。任何失败降级为 console.error 并跳过（不抛出——
 *  本插件承担 preset 部署职责，注册失败不得引发崩溃循环）。
 *  autoClaimCwd：WP-4a auto-claim 的板定位目录（默认宿主进程 cwd，即会话工
 *  作区），同时是 #19 项目层档案（.dsh/expert-profiles.json）与文件层项目层
 *  专家的统一 cwd 锚点；autoClaimTimeoutMs：auto-claim 的 taskboard.py 子进程超
 *  时（仅供自测注入，宿主无需传）；autoClaim：WP-8 ① 宿主设置页旋钮原样透传
 *  （可能是 Volatile 引用/布尔/undefined，autoClaimSummonedTasks 内经
 *  resolveAutoClaimEnabled 读取，volatile 编辑即时生效——见 lib/host-settings.js）；
 *  profilesPaths：#19 档案路径覆盖 {homePath, projectPath}（仅供自测注入，缺省
 *  全局层随 DSH_HOME 现场解析、项目层锚 autoClaimCwd）。 */
export function registerExpertTools(ctx, { dst, providerName = 'spawn', getExpertContentImpl, autoClaimCwd = process.cwd(), autoClaimTimeoutMs = AUTOCLAIM_TIMEOUT_MS, autoClaim, profilesPaths } = {}) {
  if (typeof ctx?.tools?.register !== 'function' || typeof ctx?.subagents?.getProvider !== 'function' || typeof ctx?.subagents?.start !== 'function') {
    console.error('[dsh-expert-orchestrator] expert tools unavailable: ctx.tools/ctx.subagents missing — skipping tool registration')
    return false
  }
  const readPersona = (expert) => {
    if (expert.source === CUSTOM_SOURCE_ID) {
      // 自定义专家的 prompt 存于 custom-experts.json（getExpertContent 拒绝 custom）
      const db = loadCustomExperts(dst) ?? {}
      const slug = String(expert.file ?? '').replace(/\.md$/, '')
      const rec = (db.customExperts ?? []).find((c) => !c.deleted && (c.slug === slug || `${c.slug}.md` === expert.file))
      if (!rec) throw new Error(`自定义专家不存在或已删除：${slug}`)
      return { content: rec.prompt }
    }
    if (expert.source === FILE_LAYER_SOURCE_ID) {
      // WP-6a 文件层专家（T13）：执行期重读（S3）——每次召唤现场读 .md 全文
      //（剥 frontmatter/净化由 runExpert 的 sanitizePersona 链统一负责），改文
      // 件立即生效、无需重启宿主。文件被删/不可读 → 显式失败：专家定义已消失，
      // 静默回退花名册会造成「同名换人」，拒绝比换人安全；读取侧 lstat 守卫
      // （回炉 M1）确保扫描→读取间隙被换成符号链接的内容同样不进信任面。
      return { content: readFileLayerPersona(expert.path) }
    }
    return (getExpertContentImpl ?? ((ref) => getExpertContent(dst, ref)))({ sourceId: expert.source, file: expert.file })
  }

  // ── WP-6a 专家定义文件层（T13）：目录定位 ──────────────────────────────
  // 全局层 = <DSH_HOME|~/.dsh>/experts/*.md（与 lib/index.js resolvePresetTargetDir
  // 同一 .dsh 定位约定；DSH_HOME 每次现场读取——测试与宿主均可注入）；项目层 =
  // <autoClaimCwd>/.dsh/experts/*.md（autoClaimCwd 即「宿主进程 cwd，会话工作
  // 区」，与 WP-4a 板定位同锚点，既有测试注入通道复用）。两目录均在 preset 部
  // 署树之外，PROTOCOL/USER_DATA 刷新机制永不触碰（用户数据语义，已核实）。
  const fileLayerDirs = () => ({
    homeDir: globalExpertsDir(),
    projectDir: projectExpertsDir(autoClaimCwd),
  })

  // ── #19 per-expert 档案（T15）：路径定位 ────────────────────────────────
  // 全局层 = <DSH_HOME|~/.dsh>/expert-profiles.json（与文件层全局层同一 home 定
  // 位约定）；项目层 = <autoClaimCwd>/.dsh/expert-profiles.json（cwd 锚点与文件
  // 层项目层同源）。每次 summon 现场读（执行期重读=热调锚点）；profilesPaths 仅
  // 供自测注入双路径，宿主无需传。
  const profilePaths = () => profilesPaths ?? {
    homePath: globalProfilesPath(),
    projectPath: projectProfilesPath(autoClaimCwd),
  }

  const loadState = () => {
    const roster = loadRoster(dst)
    if (!roster) throw new Error('合并花名册不可用（expert-sources/merged/roster.json 缺失）——请先在设置页完成来源下载并重启')
    const aliases = loadAliases(dst) ?? {}
    // all 保留 shadowed 条目（P7 冲突显式化：list_experts 标注用）；candidates
    // 仍剔除 shadowed——解析与召唤语义不变。
    const all = rosterCandidates(roster)
    const candidates = all.filter((e) => !e.shadowed)
    return { roster, aliases, candidates, all }
  }

  // ── #22 振荡检测（T26）：派发序记录器，registerExpertTools 每会话一份，summon
  // 与批量召唤共用同一序列（跨工具口可见完整的 A↔B 交替面）；开关关闭 → null。
  const oscillation = oscillationEnabled()
    ? createOscillationDetector({ threshold: oscillationThreshold() })
    : null

  // ── #20 idle-edge 自动续领（T28）：在途专家执行计数（registerExpertTools 每会话
  // 一份，summon_expert 与 summon_experts 并发项共用——最后一位收尾即空闲边沿）。
  // 计数点=runExpert 受保护段入口（锁获准之后）；settle 恰好一次（成功边沿扫描、
  // 失败边沿只递减、兜底幂等），开关关闭时 settle 直接空串返回（零板读取零开销）。
  let idleFlight = 0

  const resolveOrThrow = (state, query) => {
    // WP-6a 文件层解析前置（S2 三层覆盖：项目层>全局层>内置/来源包，用户裁决
    // 2026-10-07 Q4=4A）：每次解析现场 loadFileExperts（S3 执行期重读，无任何
    // 缓存）。回炉裁决（编排者 q1：宁严勿宽，对齐 Q4=4A「同名」字面范围）：
    // ① 文件层参与解析链的优先级只有一条通道——花名册 name 精确命中与文件层
    //    name 精确命中同点裁决，同名 → 文件层覆盖（dedup 代表规则不再参与）；
    // ② 文件层专家的 title 仅在花名册 name/惯用名/title 全部未命中后做文件层
    //    内部兜底解析（title→唯一），绝不劫持花名册（内置/来源包）的精确名或
    //    title 解析（含文件层 name 撞花名册 title 的情形，花名册 title 胜）；
    // ③ 未使用文件层（空文件层）→ 全部按既有解析链逐字走，用户行为零变化。
    const fileLayer = loadFileExperts(fileLayerDirs())
    const fileByName = resolveFileExpert(fileLayer.all, query, { mode: 'name' })
    const q = norm(query)
    const rosterNameHit = !!q && state.candidates.some((e) => norm(e.name) === q)
    // ① 同名覆盖（唯一优先通道）：花名册与文件层 name 同时精确命中。
    if (rosterNameHit && fileByName.ok) return fileByName.expert
    // ② 花名册解析链完整保留（name 命中且无同名覆盖 → 花名册专家；name 未命
    //    中 → 惯用名 > title；禁用/shadowed/歧义语义逐字不变）——文件层在
    //    此阶段一律不参与。
    const r = resolveExpert(state.candidates, state.aliases, query)
    if (r.ok) return r.expert
    if (r.reason === 'expertDisabled') {
      throw new Error(`专家 ${r.expert?.name ?? query} 已被停用——请在设置页重新启用后再召唤`)
    }
    if (r.reason === 'expertShadowed') {
      throw new Error(`${query} 是去重组的非代表副本——请召唤该组的代表专家，或用『来源名+原名』精确指定`)
    }
    if (r.reason === 'ambiguous') {
      const list = (r.candidates ?? []).map((c) => `${c.source}/${c.file}（${c.name ?? c.title ?? '?'}）`).join('\n')
      throw new Error(`委派名存在多个候选，请用『来源名+原名』精确指定：\n${list}`)
    }
    // ③ 花名册整体未命中 → 文件层内部兜底解析：name（①②已排他未命中）→
    //    title 唯一命中；title 多命中 → ambiguous（宁拒勿猜）。
    if (fileByName.ok) return fileByName.expert
    const ft = resolveFileExpert(fileLayer.all, query, { mode: 'title' })
    if (ft.ok) return ft.expert
    if (ft.reason === 'ambiguous') {
      const list = (ft.candidates ?? []).map((c) => `${c.layer}/${c.file}（${c.name ?? c.title ?? '?'}）`).join('\n')
      throw new Error(`委派名存在多个候选，请用『来源名+原名』精确指定：\n${list}`)
    }
    throw new Error(`专家不存在：${query}；可先调用 list_experts 浏览花名册（惯用名见 roster-aliases.json）`)
  }

  // one-shot 现状路径（旧宿主 / seam 不可用 / 显式关闭）：无档案时与 T15 之前的
  // 行为逐字节一致（toolFilter/agentOptions 由 runExpert 统一组装后传入）。
  // taskText→promptText（T26 #21）：经验提示与 origin chain 标记行统一在 runExpert
  // 组装，两条派发路径只消费最终 promptText（提示在前、链标记行恒收尾）。
  const runExpertOneShot = async ({ query, expert, promptText, persona, exec, toolFilter, agentOptions }) => {
    const run = await ctx.subagents.start(providerName, {
      label: `expert:${expert.name ?? query}`,
      prompt: [{ type: 'text', text: promptText }],
      parent: exec.agent,
      persona,
      toolFilter,
      // #19 model 热调（T15）：仅档案配置了 model 且 provider 声明 agentOptions
      // 能力时才带该键（无档案/未配置 → 键不存在，payload 与既有行为一致）。
      ...(agentOptions ? { agentOptions } : {}),
      signal: exec.signal,
    })
    try {
      const result = await run.result
      const text = textBlocks(result?.output)
      if (result?.stopReason !== 'completed') {
        throw new Error(`专家执行未正常完成（stopReason=${result?.stopReason ?? 'unknown'}）${text ? '：' + text.slice(0, 500) : ''}`)
      }
      return { expert: expert.name ?? query, answer: text }
    } finally {
      if (run?.dispose) await run.dispose()
    }
  }

  // continuable 断点续跑路径（新一代宿主，用户裁决 Q2=2A）：专家 run 建为持久
  // continuable 子代理；中断（error/max-tokens）后经 sendMessage 恢复恰好一个续
  // 跑 turn（宿主对缺失直接子代理按持久 descriptor 冷恢复），续跑 prompt 折入断
  // 点数据（任务板最新检查点 + bus 汇报 + 中断前部分产出）。取消（aborted）与
  // 拒绝（refusal）不续跑；续跑后再中断按一次性纪律抛错交编排者处置。
  const runExpertContinuable = async (seam, { query, expert, promptText, resumeTaskText, persona, exec, toolFilter, agentOptions }) => {
    const watcher = createSettlementWatcher(seam)
    try {
      // 疑问3（T12 回炉）：exec.signal 缺省时两处宿主调用面补永不中止 signal（宿主
      // d.ts 非可选 + 裸 throwIfAborted，见 NEVER_ABORT_SIGNAL 注记）；取消语义判
      // 定（exec.signal?.aborted）仍读原始 signal。
      const signal = exec.signal ?? NEVER_ABORT_SIGNAL
      const started = await seam.startContinuable({
        provider: providerName,
        label: `expert:${expert.name ?? query}`,
        request: {
          prompt: [{ type: 'text', text: promptText }],
          parent: exec.agent,
          persona,
          toolFilter,
          // #19 model 热调（T15）：ContinuableStartSpec.request 携带 agentOptions，
          // 宿主 continuation manager 据此解析子代理模型（写入持久 descriptor）。
          ...(agentOptions ? { agentOptions } : {}),
        },
        signal,
      })
      const childId = started?.childId
      if (typeof childId !== 'string' || !childId) {
        throw new Error('宿主未返回持久子代理 id（startContinuable 契约不符）——按检查点+全新代理重跑处置')
      }
      const interruptTurn = () => seam.interrupt?.(childId, { kind: 'ancestor', agent: exec.agent })
      // minor-3（T12 回炉）：终态失败路径 best-effort 回收——宿主
      // drainContinuableChildren 只释放驻留 Activation（缺失目标/无 manager 为
      // no-op），持久 descriptor 保留在盘（冷恢复锚点，刻意不删）。回收失败静默，
      // 绝不掩盖原错误；契约不符路径无 childId、取消路径维持 interrupt 现状，均
      // 不回收。宿主辅助面缺失（seam.drainChildren=null）时跳过。
      const reclaimChild = () => {
        try {
          const drained = seam.drainChildren?.(exec.agent, [childId])
          if (drained && typeof drained.catch === 'function') drained.catch(() => { /* best-effort */ })
        } catch { /* 已尽力 */ }
      }
      const answerText = (info) => textBlocks(info?.lastAssistantMessage ?? info?.output)
      let settle = await watcher.next(childId, signal, interruptTurn)
      if (settle.stopReason === 'completed') {
        return { expert: expert.name ?? query, answer: answerText(settle) }
      }
      const firstReason = settle.stopReason
      if (!RESUMABLE_STOP_REASONS.includes(firstReason) || exec.signal?.aborted) {
        reclaimChild()
        throw new Error(`专家执行未正常完成（stopReason=${firstReason ?? 'unknown'}）${answerText(settle) ? '：' + answerText(settle).slice(0, 500) : ''}`)
      }
      const progress = await collectResumeProgress({ taskText: resumeTaskText, owner: expert.name ?? query, cwd: autoClaimCwd, timeoutMs: autoClaimTimeoutMs })
      const resumePrompt = buildResumePrompt({ progress, partialOutput: answerText(settle), expertName: expert.name ?? query })
      try {
        await seam.sendMessage(exec.agent, childId, [{ type: 'text', text: resumePrompt }], { signal })
      } catch (error) {
        // minor-4（T12 回炉）：宿主契约为「inbox 受理才 resolve」，抛错理论=未受
        // 理且无第二次投递；若宿主在受理后抛错则存在孤儿 turn——错误信息附
        // childId 供编排者人工核查（错误信息不含 childId 无法定位）。
        throw new Error(`续跑消息投递失败（childId=${childId}）：${error?.message ?? error}`)
      }
      settle = await watcher.next(childId, signal, interruptTurn)
      if (settle.stopReason === 'completed') {
        return {
          expert: expert.name ?? query,
          answer: `${answerText(settle)}\n【断点续跑】首轮中断（stopReason=${firstReason}），已按持久会话恢复并完成恰好 1 个续跑 turn`,
        }
      }
      reclaimChild()
      throw new Error(`专家执行未正常完成（stopReason=${firstReason}），已自动续跑恰好 1 个 turn 后仍中断（stopReason=${settle.stopReason ?? 'unknown'}）——按一次性纪律以检查点+全新代理重跑`)
    } finally {
      watcher.dispose()
    }
  }

  const runExpert = async (query, task, exec, { claimedIds, readOnly = false } = {}) => {
    const taskText = typeof task === 'string' ? task.trim() : ''
    if (!taskText) throw new Error('task 必填：给专家的自包含任务说明（含全部必要上下文）')
    if ([...taskText].length > SUMMON_TASK_MAX_CHARS) {
      throw new Error(`task 超长（${[...taskText].length} > ${SUMMON_TASK_MAX_CHARS} 码点）——请精简任务书或拆分`)
    }
    if (exec?.agent === undefined) throw new Error('summon_expert 必须在有 agent 的会话中调用')
    const provider = ctx.subagents.getProvider(providerName)
    if (!provider) throw new Error(`subagent provider "${providerName}" 不可用`)
    const caps = provider.capabilities ?? {}
    if (!caps.persona) throw new Error(`provider "${providerName}" 不支持 persona 注入`)
    if (!caps.toolFilter) throw new Error(`provider "${providerName}" 不支持 toolFilter`)
    const expert = resolveOrThrow(loadState(), query)
    // ── #21 origin chain 递归防护（WP-7 ③，T26）：链上重复对拒绝，报错含链路本身 ──
    // 检查在 persona 组装与任何写面（auto-claim/写锁）之前 fail-fast；入站任务书解析
    // 出链后延伸当前跳 (专家名, cwd)；出站任务书 = 剥旧标记净文本 + 经验提示 + 新标记行
    // 收尾（协议侧复制约定见 SKILL.md §5 env 传递段）。开关关闭 → 全段跳过（零变化）。
    let chain = null
    let baseTask = taskText
    if (originChainEnabled()) {
      const chainCheck = checkOriginChain({ taskText, expertName: expert.name ?? query, cwd: autoClaimCwd })
      if (!chainCheck.ok) throw new Error(chainCheck.message)
      baseTask = chainCheck.taskText
      chain = chainCheck.chain
    }
    const lesson = loadExpertLessons(dst, expertLessonSlug(expert.source, expert.file))
    const rawPersona = readPersona(expert).content
    const method = extractPersonaMethod(rawPersona)
    // ── #19 per-expert 档案 + #17 prompt 瘦身（T15，persona 组装处唯一实现点）──
    // 档案执行期重读：summon 入口现场读 expert-profiles.json（项目层 > 全局层，
    // profilesPaths 仅供自测注入）——热改文件后新 summon 即生效、恢复文件即回滚
    // （验收 (d)）；档案在此一次性快照，在途 summon/run 不被任何机制触碰（热改只
    // 影响新 summon，构造性边界）。读取失败/无档案/该专家未配置 → profile=null，
    // persona 与 start spec 走既有路径逐字节一致（向后兼容硬要求）。
    let profile = null
    try {
      profile = profileForExpert(loadExpertProfiles(profilePaths()), expert.name ?? query)
    } catch (error) {
      console.warn(`[dsh-expert-orchestrator] 专家档案读取失败（该专家按无档案行为）：${error?.message ?? error}`)
    }
    const profileEffect = resolveProfileEffect(ctx, profile)
    let persona = sanitizePersona(rawPersona)
    if (profile) {
      // #17（验收 (c)）：档案存在即按有效工具面（档案收窄 ∪ 递归防护 deny ∪ 注册
      // 探测）剪除「点名工具全部不可见」的 guidance 段；无档案=全量（零变化）。
      persona = pruneUnavailableToolSections(persona, profileEffect.isToolAvailable)
    }
    persona = splitPersona(dst, persona, method)
    if (profile) {
      // #19 skills 白名单：提示级约束（宿主无 per-child 技能缝，如实声明）。
      // T34 修复（评审回炉）：注入点必须在 splitPersona **之后**——persona 方法
      // 论分层在 <!-- methods-cut --> 标记处截断 persona（Top-5 内置专家均带标记
      // 且 expert-methods/ 随包部署），先注入的约束行会随标记之后内容被静默丢弃；
      // 后注入保证约束行落在最终 persona 尾部（method 指针行之后），有/无分层
      // 专家均生效。消费方视角回归：真实分层 persona + skills 档案全链用例。
      persona = withProfileConstraints(persona, profile)
    }
    // #19 model 热调 + #22 effort 预检（T26）：provider 声明 agentOptions 能力才传
    // ——宿主 assertCapabilities 对缺能力的请求 fail-fast 拒收（0.2.x 实测），先门禁
    // 避免整次 summon 被拒；旧代宿主未声明该能力 → 降级可见，summon 照常。model 降
    // 级告警文本与 T15 既有实现逐字一致；effort 为 #22 新增（一行告警，不阻断）。
    const effortPreflight = preflightEffort({ profile, caps, providerName })
    const agentOptions = effortPreflight.agentOptions
    for (const w of effortPreflight.warnings) console.warn(`[dsh-expert-orchestrator] ${w}`)
    const toolFilter = profileEffect?.toolFilter ?? { deny: filterRestrictableTools(ctx, EXPERT_TOOLS_DENY_LIST) }
    // ── #22 per-cwd 写锁（验收 (d)：同 cwd 双专家并发写被拒而非排队）──
    // 派发边界执法（拉起专家之前拒绝），持有期=本次专家 run 全程；只读扇出经
    // readOnly 逃生口跳过；同 pid 同名专家计为重入（单专家多阶段正常写不误伤）。
    // 拒绝发生在 auto-claim 之前：被拒派工不在板上留任何写痕迹。
    const lock = acquireCwdWriteLock({ cwd: autoClaimCwd, expert: expert.name ?? query, readOnly })
    if (!lock.ok) throw new Error(lock.message)
    // ── #20 idle-edge 在途计数（T28）：计数点与受保护段入口之间零间隙（此间任何
    // 同步 throw 都不会发生）；settleIdle 幂等，成功/失败/兜底三路恰好一次生效。
    idleFlight += 1
    let idleSettled = false
    const settleIdle = async (succeeded) => {
      if (idleSettled) return ''
      idleSettled = true
      idleFlight = Math.max(0, idleFlight - 1)
      // 空闲边沿=本会话最后一位在途专家执行成功收尾；失败边沿只递减不扫描
      // （宁漏勿错——失败路径的板面常残留 running 条目，扫描也会被开放执行条件挡下）。
      if (!succeeded || idleFlight !== 0 || !idleReclaimEnabled()) return ''
      try {
        return await idleReclaimSweep({ cwd: autoClaimCwd, timeoutMs: autoClaimTimeoutMs })
      } catch (error) {
        console.warn(`[dsh-expert-orchestrator] 自动续领异常（已忽略，不阻塞派工）：${error?.message ?? error}`)
        return ''
      }
    }
    // T37 随行④：acquire 成功后**立即**进入受保护段——原实现 acquire 与 try/finally 之间
    // 隔着振荡记录/任务书组装/auto-claim/提示行拼装/seam 探测等多个同步面，任一同步异常
    // 都会带锁泄漏到进程退出（活持有者挡住异名专家直至 ESRCH 自愈）。
    try {
      // ── #22 振荡检测（验收 (e)：振荡 N 次来回后告警）──派发序记录，非阻断告警。
      const oscWarn = oscillation ? oscillation.record(expert.name ?? query) : null
      // 出站任务书组装：净文本（剥旧链标记）→ 经验提示 → origin chain 标记行收尾
      //（「任务书最后一行恒为链标记」是 §5 复制约定与到达探针的锚点）。
      let promptText = withLessonHint(baseTask, expert.name, lesson)
      if (chain) promptText = `${promptText}\n${renderOriginChainMarker(chain)}`
      // WP-4a 派工即回写（回炉第 1 轮改时序）：派发入口先 claim、后跑专家——
      // 专家拿到任务书时条目已 running。fail-open：claim 任何失败只产出提示行，
      // 绝不阻塞派工；专家执行失败/召唤失败时条目保持 running 不回滚，提示行
      // 附到错误信息尾部供编排者按板处置（reassign/fail）。
      let claimHint = ''
      try {
        claimHint = await autoClaimSummonedTasks({ taskText: baseTask, owner: expert.name ?? query, cwd: autoClaimCwd, claimedIds, timeoutMs: autoClaimTimeoutMs, enabled: autoClaim })
      } catch (error) {
        console.warn(`[dsh-expert-orchestrator] auto-claim 异常（已忽略，不阻塞派工）：${error?.message ?? error}`)
      }
      // ── #16 工具调用硬预算（T27）：summon 消费面——预算开启且任务书显式引用任务时盘点
      // budget --json 信封，已达档位的附【预算】提示行（wrap-up/interrupt 档语义的编排侧
      // 落点：续派任务书自动附收敛指令；fail-open 与 auto-claim 同哲学，绝不阻塞派工）。
      let budgetHint = ''
      try {
        budgetHint = await summonBudgetHint(baseTask, expert.name ?? query, autoClaimCwd, autoClaimTimeoutMs)
      } catch (error) {
        console.warn(`[dsh-expert-orchestrator] 预算盘点异常（已忽略，不阻塞派工）：${error?.message ?? error}`)
      }
      // 降级/告警提示行（与 claimHint 同通道：成功附 answer 尾、失败附 error 尾）。
      // model 降级告警仅 console（T15 既有语义）；effort 预检告警双通道（#22 新增可见面）。
      const hints = [claimHint, lock.degraded ? '【per-cwd 写锁降级】本次召唤未加锁（锁面内部错误，fail-open 可见）' : '', oscWarn, budgetHint, ...effortPreflight.answerHints].filter(Boolean)
      const hint = hints.length ? hints.join('\n') : ''
      // WP-4b ④ 断点续跑：seam 可用（新一代宿主 + provider continuable 能力 +
      // 结算观察面）走 continuable 路径；否则维持 one-shot 现状。两条路径的成功
      // /失败语义一致（成功 answer 附提示行；失败 message 附提示行）。
      const seam = detectResumeSeam(ctx, provider)
      try {
        const r = seam
          ? await runExpertContinuable(seam, { query, expert, promptText, resumeTaskText: baseTask, persona, exec, toolFilter, agentOptions })
          : await runExpertOneShot({ query, expert, promptText, persona, exec, toolFilter, agentOptions })
        // ── #20 idle-edge 自动续领（T28）：成功收尾=空闲边沿（开关开启且无其他在途
        // 执行时做一次续领扫描）；续领提示行与既有提示行同通道附 answer 尾（在既有
        // hint 之后，reclaimHint 为空串时输出与既有行为逐字节一致）。
        const reclaimHint = await settleIdle(true)
        const allHints = [hint, reclaimHint].filter(Boolean).join('\n')
        return allHints ? { ...r, answer: `${r.answer}\n${allHints}` } : r
      } catch (error) {
        // 派工失败路径：已 claim 条目保持 running（fail-open 不回滚），
        // auto-claim 结果随错误附出，编排者按板处置。
        await settleIdle(false) // 失败边沿：只递减不扫描（#20）
        if (hint) error.message = `${error.message}\n${hint}`
        throw error
      }
    } finally {
      try { lock.release?.() } catch { /* 释放面自愈，绝不掩盖主流程结果 */ }
      await settleIdle(false) // #20 兜底：受保护段内任何未路过 settle 的异常在此幂等递减
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'list_experts',
      description:
        'List the available experts from the merged expert roster (bundled core + enabled source packs + user-defined custom experts), grouped by source. Without a filter it returns source ids and counts (compact); pass a source id to expand its expert names. Call this before summon_expert when you do not know the expert name.',
      parameters: {
        bySource: { type: 'string', description: 'Optional source id to expand (e.g. agency-agents-zh, awesome-claude-code-subagents, bundled-core, custom).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sources: { type: 'array', required: true, items: { type: 'json' } },
            total: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderExpertList(value) }],
      },
      async execute(args) {
        const state = loadState()
        const bySource = typeof args?.bySource === 'string' ? args.bySource.trim() : ''
        // P7 冲突显式化：跨源重名（同名可召唤候选分布在 ≥2 个来源）打 conflict
        // 标注——用户看得见歧义而非靠召唤报错才发现；仅标注不拒绝，消歧仍由
        // resolveExpert 的『来源名+原名』路径负责。
        const byNormName = new Map()
        for (const e of state.candidates) {
          if (typeof e.name !== 'string' || !e.name) continue
          const key = norm(e.name)
          const srcs = byNormName.get(key) ?? new Set()
          srcs.add(e.source)
          byNormName.set(key, srcs)
        }
        const crossSourceNames = new Set([...byNormName.entries()].filter(([, srcs]) => srcs.size > 1).map(([key]) => key))
        // WP-6a 文件层（T13）：文件层专家并入可召唤候选视图（执行期重读）。
        // 未使用文件层（两目录缺失/为空）→ all=[]，输出与既有行为逐字节一致
        // （零变化）；使用后 file 组与既有来源并列，bySource='file' 可展开。
        // crossSourceNames 保持只算花名册候选：文件层是覆盖方而非冲突方，同名
        // roster 条目已被文件层覆盖，再标 conflict 反而误导。
        const fileLayer = loadFileExperts(fileLayerDirs())
        const experts = bySource
          ? (bySource === FILE_LAYER_SOURCE_ID ? fileLayer.all : state.candidates.filter((e) => e.source === bySource))
          : [...state.candidates, ...fileLayer.all]
        const groups = new Map()
        for (const e of experts) {
          const g = groups.get(e.source) ?? { source: e.source, count: 0 }
          g.count += 1
          if (bySource) {
            (g.experts ??= []).push(e.source === FILE_LAYER_SOURCE_ID
              ? {
                  name: e.name,
                  title: e.title,
                  file: e.file,
                  layer: e.layer,
                  ...(crossSourceNames.has(norm(e.name)) ? { conflict: true } : {}),
                }
              : {
                  name: e.name,
                  title: e.title,
                  file: e.file,
                  disabled: e.disabled,
                  ...(crossSourceNames.has(norm(e.name)) ? { conflict: true } : {}),
                })
          }
          groups.set(e.source, g)
        }
        // P7 shadowed 显式化：去重组非代表副本不可召唤但对用户可见（对齐 merged
        // roster 的 dedupGroups 标注）。仅 bySource 展开时输出；count/total 语义
        // 不变（只计可召唤候选，向后兼容）。
        if (bySource) {
          for (const e of state.all) {
            if (!e.shadowed || e.source !== bySource) continue
            const g = groups.get(e.source) ?? { source: e.source, count: 0 }
            ;(g.shadowed ??= []).push({ name: e.name, title: e.title, file: e.file })
            groups.set(e.source, g)
          }
        }
        const sources = [...groups.values()].sort((a, b) => b.count - a.count)
        if (bySource && !sources.some((g) => g.source === bySource)) {
          throw new Error(`来源不存在或未启用：${bySource}；可用来源见不带参数的 list_experts`)
        }
        return { sources, total: experts.length }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'summon_expert',
      description:
        "Summon a domain expert from the merged expert roster to complete a task: a specialist subagent runs with that expert's full persona and returns its result. Use for tasks that clearly belong to a specialist domain. This call waits for the expert's result. Call list_experts first if you do not know the expert name.",
      parameters: {
        expert: { type: 'string', required: true, description: 'Expert name to summon (roster native name, or a legacy alias listed in roster-aliases.json).' },
        task: { type: 'string', required: true, description: 'The complete, self-contained task for the expert (max 8000 chars).' },
        readOnly: { type: 'boolean', description: 'Declare this delegation read-only: it will not contend for the per-cwd write lock. Omit (default) for write-capable delegations.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { expert: { type: 'string', required: true }, answer: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.answer }],
      },
      async execute(args, exec) {
        return runExpert(args?.expert, args?.task, exec, { readOnly: args?.readOnly === true })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'summon_experts',
      description:
        'Summon multiple experts in parallel, each with its own task, running as specialist subagents with their own personas. At most 8 experts run with concurrency 4; if some fail, successful answers are still returned. Use this to assemble a specialist team.',
      parameters: {
        experts: {
          type: 'array',
          required: true,
          description: 'The experts to summon, each with an expert name and its own task.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              expert: { type: 'string', required: true, description: 'Expert name to summon.' },
              task: { type: 'string', required: true, description: 'The complete, self-contained task for this expert.' },
              readOnly: { type: 'boolean', description: 'Declare this item read-only: it will not contend for the per-cwd write lock.' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { results: { type: 'array', required: true, items: { type: 'json' } } },
        },
        render: (_args, value) => {
          const lines = (value.results ?? []).map((r) => `- ${r.expert}: ${r.ok ? '完成' : `失败（${r.error ?? '未知错误'}）`}`)
          return [{ type: 'text', text: ['召唤结果：', ...lines].join('\n') }]
        },
      },
      async execute(args, exec) {
        if (exec?.agent === undefined) throw new Error('summon_experts 必须在有 agent 的会话中调用')
        const raw = Array.isArray(args?.experts) ? args.experts : []
        if (raw.length === 0) throw new Error('experts 不能为空')
        if (raw.length > 8) throw new Error('一次最多召唤 8 位专家')
        const specs = raw.map((item, index) => {
          const expert = typeof item?.expert === 'string' ? item.expert.trim() : ''
          const task = typeof item?.task === 'string' ? item.task.trim() : ''
          if (!expert) throw new Error(`experts[${index}].expert 必填`)
          if (!task) throw new Error(`experts[${index}].task 必填`)
          if ([...task].length > SUMMON_TASK_MAX_CHARS) throw new Error(`experts[${index}].task 超长（> ${SUMMON_TASK_MAX_CHARS} 码点）`)
          return { expert, task, readOnly: item?.readOnly === true }
        })
        // WP-4a：批量召唤共享一个去重集合——同一任务 id 只回写一次
        const claimedIds = new Set()
        const results = await mapPool(specs, SUMMON_CONCURRENCY, async (spec) => {
          try {
            const r = await runExpert(spec.expert, spec.task, exec, { claimedIds, readOnly: spec.readOnly })
            return { expert: r.expert, ok: true, answer: r.answer }
          } catch (error) {
            return { expert: spec.expert, ok: false, error: String(error?.message ?? error) }
          }
        })
        return {
          results: results.map((item) => ({
            expert: item.expert,
            ok: item.ok,
            // T9 缺陷 B：失败条目无 answer——不得写显式 undefined 属性，否则
            // 宿主对成功返回值的 lossless JSON 快照直接拒绝（ToolOutputError
            // "value is not lossless JSON"，整次召唤报错）。
            ...(item.answer === undefined ? {} : { answer: item.answer }),
            ...(item.error === undefined ? {} : { error: item.error }),
          })),
        }
      },
    }),
  )

  // 父会话系统提示注入：花名册引导（被召唤的子代理不注入——parentSession 守卫）。
  if (typeof ctx?.systemPrompt?.section === 'function') {
    ctx.systemPrompt.section({
      name: 'expert-orchestrator:roster',
      order: 117,
      text: (context) => {
        const agent = context?.agent
        if (agent?.session?.header?.parentSession !== undefined) return ''
        return [
          '## 专家召唤模式（expert-orchestrator）',
          '父会话拥有合并花名册（bundled core + 已启用来源包 + 自定义专家）。',
          '需要领域专家时：先调用 `list_experts()` 看来源与数量，必要时 `list_experts(bySource)` 展开名单，',
          '再用 `summon_expert(expert, task)` 召唤（同步等结果）或 `summon_experts` 组建小队（≤8，并发 4）。',
          'summon 是默认委派通道；`subagent`/`subagent_fork` 仅限：召唤通道异常回退、联调/续作/长任务后台、自带库短 persona 的轻量委派——其余场景一律 summon。',
          '长任务一律后台委派并依赖完成通知回交，回合自然结束等待；编排场景不使用 goal 工具（create_goal/get_goal/update_goal），也不做定时轮询等待。',
          '子代理一次性使用：一份任务书一次委派，完成后不 send_message 续派；下一任务=全新子代理。',
          '断点续跑（新一代宿主）：summon 通道的专家 run 中断后由工具自动按持久会话恢复恰好一个续跑 turn（折入任务板检查点与 bus 汇报进度）；旧宿主或续跑再失败按检查点+全新代理重跑。',
          '被停用（disabled）或去重 shadowed 的专家不可召唤。被召唤的专家无法再派生子代理。',
        ].join('\n')
      },
    })
  }
  return true
}
