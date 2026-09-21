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
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { getExpertContent } from './index.js'

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

/** 递归防护 deny 名单按宿主实际注册过滤（T9 缺陷 A）：宿主 tools.restrict()
 *  对未知名直接抛错（dsh-tools 校验 known global tools），而部署差异可能使
 *  名单含宿主未注册的工具名（如 subagent 只在部分部署面存在）。用公开 API
 *  ctx.tools.get(name) 逐名探测：已注册才 deny；未注册名剔除并 console.warn
 *  ——未注册名本就不可见，剔除不放宽防护；探测 API 缺失或异常时保守原样
 *  传递（退回宿主报错，不静默）。导出供自测。 */
export function filterRestrictableTools(ctx, names) {
  if (typeof ctx?.tools?.get !== 'function') return [...names]
  return names.filter((name) => {
    try {
      if (ctx.tools.get(name) !== undefined) return true
      console.warn(`[dsh-expert-orchestrator] toolFilter deny 跳过宿主未注册的全局工具：${name}`)
      return false
    } catch {
      return true
    }
  })
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

/** persona 注入前净化：剥离 frontmatter（防 frontmatter 注入面）→ 清理控制
 *  字符（保留 \n \t）→ 长度上限截断。 */
export function sanitizePersona(text) {
  if (typeof text !== 'string') return ''
  let out = text
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(out)
  if (fm) out = out.slice(fm[0].length)
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
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
 *  本插件承担 preset 部署职责，注册失败不得引发崩溃循环）。 */
export function registerExpertTools(ctx, { dst, providerName = 'spawn', getExpertContentImpl } = {}) {
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
    return (getExpertContentImpl ?? ((ref) => getExpertContent(dst, ref)))({ sourceId: expert.source, file: expert.file })
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

  const resolveOrThrow = (state, query) => {
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
    throw new Error(`专家不存在：${query}；可先调用 list_experts 浏览花名册（惯用名见 roster-aliases.json）`)
  }

  const runExpert = async (query, task, exec) => {
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
    const lesson = loadExpertLessons(dst, expertLessonSlug(expert.source, expert.file))
    const rawPersona = readPersona(expert).content
    const method = extractPersonaMethod(rawPersona)
    const persona = splitPersona(dst, sanitizePersona(rawPersona), method)
    const run = await ctx.subagents.start(providerName, {
      label: `expert:${expert.name ?? query}`,
      prompt: [{ type: 'text', text: withLessonHint(taskText, expert.name, lesson) }],
      parent: exec.agent,
      persona,
      toolFilter: { deny: filterRestrictableTools(ctx, EXPERT_TOOLS_DENY_LIST) },
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
        const experts = bySource ? state.candidates.filter((e) => e.source === bySource) : state.candidates
        const groups = new Map()
        for (const e of experts) {
          const g = groups.get(e.source) ?? { source: e.source, count: 0 }
          g.count += 1
          if (bySource) {
            (g.experts ??= []).push({
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
        return runExpert(args?.expert, args?.task, exec)
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
          return { expert, task }
        })
        const results = await mapPool(specs, SUMMON_CONCURRENCY, async (spec) => {
          try {
            const r = await runExpert(spec.expert, spec.task, exec)
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
          '被停用（disabled）或去重 shadowed 的专家不可召唤。被召唤的专家无法再派生子代理。',
        ].join('\n')
      },
    })
  }
  return true
}
