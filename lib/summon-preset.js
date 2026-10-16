// dsh-expert-orchestrator — per-summon Agent Preset 挂载/选择方案（T3 ③）
//
// 背景（dsh-expert-alpha4-t2-api-report.md ①1b/③、⑤）：DSH 0.2.1-alpha.3 起
// subagent spawn 通道的 persona/toolFilter 直传消费面归零（manager 新建路径
// composition 只读 request.agentPreset；dsh-subagent-spawn-in-process capabilities
// 删 persona/toolFilter、增 agentPreset:true）——专家 persona 与工具收窄改经
// Agent Preset 交付：宿主 child-agent.applyChildComposition 对
// composition.agentPreset 调 presets.mount(childCtx, id)（spawn 专属；fork
// inheritsParentContext 被 assertCapabilities 拒收独立选择）。
//
// 本模块实现 per-summon 的 preset 挂载/选择：
// 1. 组合内容 = -standing preset（cordis.patch.yml preset-expert-orchestrator）
//    工具组合的**静态副本**（SUMMON_PRESET_BASE_PLUGINS）——preset 绑定的子代理
//    工具视域 = 全局层 ∪ 本 generation 层（scope 链 child → generation → root），
//    standing preset 组合层工具（bash/fs/web/todo/…）不在副本里就全部失明
//    （2.9.5 真机实证的视域纪律前提）；副本**整体省略 delegation 组**
//    （subagent/subagent_fork/workflow/ralph/workflow_ptc/subagent-control）——
//    组合级省略比 ≤alpha.2 的 restrict deny 更强：那些工具本就是 generation 层
//    名字，全局视域探测（filterRestrictableTools）从来探不到、deny 不进去，
//    而组合省略让它们在子代理链上根本不存在（递归防护升级，宿主 maxDepth=1
//    深度熔断继续兜底）。
// 2. persona 行（@deepseek-ai/dsh-persona config.prefix）承载专家 persona——
//    宿主文档明示该行「Mounted inside an agent preset it shadows the deployment
//    persona for that one session, exactly like the per-child persona
//    dsh-subagent installs」（dsh-persona/lib/index.js 模块注释），与直传通道
//    applyChildOverrides 的 persona section 同名同序，等价交付。
// 3. 全局层收窄（EXPERT_TOOLS_DENY_LIST ∩ 全局注册 ∪ 档案 deny ∪ MCP 白名单
//    展开）经 lib/summon-preset-restrict.js 组合行在 generation scope 调
//    ctx.tools.restrict 交付——全局层名字对绑定会话是 inherited，restriction
//    层沿 scope 链生效，等价于直传通道的 childCtx.tools.restrict。
// 4. 定义经 ctx.agentPresets.register(definition) 动态注册（dsh-agent-preset-
//    registry register()：Parsed configuration supplied by the declaring plugin，
//    返回 disposer；与静态声明行走同一 activate→mountPreset 通道），request 携
//    带 agentPreset=<id> 即完成选择（one-shot 与 continuable 两路 manager 均
//    composition: { agentPreset: request.agentPreset }，dsh-subagent/lib/types/
//    manager.js:386 alpha.4 实证）。
//
// 生命周期纪律（T12「用完即注」，用户裁决方案 A：preset 列表只保留主 expert 入口）：
// 按 {persona, toolFilter} 内容 sha256 去重缓存；引用计数防并发同键召唤误注——
// ensureSummonPreset 成功路径（缓存命中/新注册/Duplicate 复用皆算）计数 +1，
// runExpert 收尾边沿（成功/失败/兜底，幂等）-1，归零即调 register 返回的
// unregister（宿主 registry disposer 幂等自防，dsh-agent-preset-registry
// lib/index.js:480-493）并删缓存项（防下次缓存命中悬空 id）；负数/未知键不注销
// （fail-open，warn 可见）。冷恢复语义：run 在途（含中断自动续跑窗口）计数 >0
// 定义必存活；run 收尾后注销——**同进程重物化窗口不再保障**（coldResume 对独立
// preset 子代理重物化经 presets.mount(id)，注销后同进程冷恢复 not-found，
// dsh-subagent/lib/index.js:2141-2187），跨重启本就随 registry 内存态消失。
// 代价（如实声明）：persona 文件热改产生新 hash → 新定义按召唤生命周期进出，
// 稳态残留 = Duplicate 复用（无注销句柄）定义与 broken 定义；ctx.effect 把
// disposer 挂到插件服务卸载面（卸载后编排面整体下线，无残留绑定会话）——兜底
// 行为不变。同 hash 重复注册（插件热重载竞态残留）复用既有定义——内容同 hash
// （sha256 全文），无语义漂移；该路径下本实例不持有 disposer，引用归零只能
// warn 保留（旧实例卸载面/进程收尾清理）。已知残余（评审💭）：HMR 多实例下
// 复用定义时其 disposer 绑定旧实例，新实例卸载面注销不到旧定义——单实例现状
// （宿主不并行装载两个本插件实例）风险可忽略；多实例共存落地前需把注销面迁移
// 到内容键登记表。
//
// 允许降级面（如实声明，不静默）：档案 tools.allow 白名单在 preset 通道暂不
// 执法（见 buildPresetChannelToolFilter）——allow 名单出自插件 ctx 全局枚举视域，
// 遮蔽不到本 generation 副本层工具，强行 restrict 会重蹈 2.9.5「allow 白名单
// 遮蔽核心工具全通道」缺陷；提示级剪除（isToolAvailable）仍生效。
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** per-summon preset id 前缀（registry 定义 id 需非空；前缀保证命名空间隔离）。 */
export const SUMMON_PRESET_ID_PREFIX = 'expert-orchestrator-summon-'

/** 副本组合行引用的收窄行模块 file URL（row name；Loader 支持 file URL 行名，
 *  dsh-app-boot anchorInsertedPluginNames 同款语义）。 */
export const SUMMON_RESTRICT_ROW_URL = pathToFileURL(fileURLToPath(new URL('./summon-preset-restrict.js', import.meta.url))).href

/** skill-filesystem customSkillDirs（与 cordis.patch.yml preset 行内 !!js 表达式
 *  同语义的 JS 直算：DSH_HOME 优先，回退 ~/.dsh）。 */
export function summonCustomSkillDirs(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return [
    join(base, '.agent-presets', 'expert-orchestrator', 'skills'),
    join(base, '.agent-presets', 'expert-orchestrator', 'skills', 'expert-gestures'),
  ]
}

/** plan-mode section（与 cordis.patch.yml preset 行 planning 组逐字副本；
 *  scripts/gen-preset-declaration.mjs 是该文本的权威源，测试层做结构漂移对账）。 */
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
`

/** per-summon preset 的工具组合静态副本：standing preset（cordis.patch.yml
 *  preset-expert-orchestrator 行 config.plugins）**去掉 persona 行**（被专家
 *  persona 替换）与 **delegation 组**（组合级递归防护，见文件头②）。行序与
 *  行名以生成器源 agent.cordis.yml 为权威；测试层做结构漂移对账
 *  （test/tools.selftest.mjs preset 副本漂移用例）。平台条件行按 !!js 语义
 *  直算为 disabled 布尔（flattenRows 的 Boolean(value) 路径）。 */
export function summonPresetBasePlugins(env = process.env) {
  return [
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    {
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { customSkillDirs: summonCustomSkillDirs(env) },
    },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_MODE_SECTION } },
      ],
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 32768, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    // delegation 组（tool-subagent/tool-subagent-fork/workflow-ptc/tool-workflow/
    // tool-ralph/subagent-control）刻意缺席：组合级递归防护，见文件头②。
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  ]
}

/** 组装 per-summon preset 定义（registry.register 直收的形状：{id, plugins}，
 *  与 cordis.patch.yml preset 行 config 同构）。persona 行恒为首行（与 standing
 *  preset 行序一致）；收窄行恒为末行（仅 toolFilter 非空时携带）。
 *
 *  展示名（name）可区分化（T11）：每位专家一条 per-summon 定义且存活期不注销，
 *  固定名「dsh-expert-orchestrator 专家召唤组合」在 UI preset 列表不可区分、形似
 *  重复——name 改为「dsh-expert-orchestrator · 召唤：<专家名> · <内容键前 8 位>」。
 *  name **不参与** summonPresetKey 内容键（键只覆盖 {persona, toolFilter}）：id 与
 *  幂等语义不变，name 变化不会导致同内容键定义重注册（Duplicate 复用路径不受
 *  展示名影响）。expertName/contentKey 缺省（旧调用形态/自测直调）降级为占位
 *  展示名，行为向后兼容。 */
export function buildSummonPresetDefinition({ id, persona, toolFilter, env = process.env, expertName, contentKey }) {
  if (typeof id !== 'string' || !id) throw new Error('per-summon preset id 必填')
  const displayExpert = typeof expertName === 'string' && expertName ? expertName : '未知专家'
  const shortKey = typeof contentKey === 'string' && contentKey ? contentKey.slice(0, 8) : 'nokey'
  return {
    id,
    name: `dsh-expert-orchestrator · 召唤：${displayExpert} · ${shortKey}`,
    description: `per-summon Agent Preset（专家「${displayExpert}」）：专家 persona（dsh-persona 行）+ 工具组合静态副本（delegation 组合级省略）+ 全局层工具收窄（summon-restrict 行）。展示名含内容键短哈希（${shortKey}）供 UI 区分同内容键定义；name 不参与内容键，id 与注册幂等语义不受影响。由 dsh-expert-orchestrator 召唤期动态注册。`,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: persona ?? '' } },
      ...summonPresetBasePlugins(env),
      ...(toolFilter ? [{ id: 'summon-restrict', name: SUMMON_RESTRICT_ROW_URL, config: toolFilter }] : []),
    ],
  }
}

/** per-summon preset 内容键：{persona, toolFilter} 稳定序列化 sha256 前 16 hex
 *  （同一 persona+收窄组合跨 summon 复用同一定义——冷恢复 id 稳定的前提）。 */
export function summonPresetKey({ persona, toolFilter }) {
  const canonical = JSON.stringify({ v: 1, persona: persona ?? '', toolFilter: toolFilter ?? null })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** preset 通道的全局层收窄面（T3 ③）：与 ≤alpha.2 直传 toolFilter 同源——
 *  档案 deny（已含递归防护清单 ∪ 档案 tools.deny ∪ MCP 白名单展开，且经
 *  filterRestrictableTools 全局视域过滤）或无档案时的递归防护 deny。allow 白
 *  名单在此通道降级可见（不执法，见文件头允许降级面）。返回 {deny:[...]} 或
 *  null（空名单不携带 restrict 行）。导出供自测。
 *  @param profileEffect resolveProfileEffect 结果（null=无档案）
 *  @param legacyToolFilter 召唤期按既有语义组装的直传 toolFilter（deny 求交
 *    结果；allow 名单仅直传通道消费）——本函数只取其 deny 分量，绝不复用 allow。 */
export function buildPresetChannelToolFilter(profileEffect, legacyToolFilter) {
  if (profileEffect?.toolFilter?.allow) {
    console.warn('[dsh-expert-orchestrator] 专家档案 tools.allow 白名单在 agentPreset（preset 组合）通道暂不执法：allow 名单出自全局枚举视域，遮蔽不到 preset 组合层工具，强行 restrict 会重蹈 2.9.5 全遮蔽缺陷——本次派发按 deny-only 执法，提示级剪除（persona 段）仍生效')
  }
  const deny = profileEffect?.toolFilter?.deny ?? legacyToolFilter?.deny
  return Array.isArray(deny) && deny.length > 0 ? { deny } : null
}

/** per-summon preset 注册缓存工厂（registerExpertTools 每实例一份）。 */
export function createSummonPresetCache() {
  return new Map()
}

/** per-summon preset 引用计数面工厂（T12 用完即注；registerExpertTools 每实例
 *  一份，与注册缓存同生命周期）。键 = preset id（= 前缀 + 内容键，双射），
 *  值 = { key: 内容键（归零清缓存用）, refs: 在途召唤数, unregister: register
 *  返回的注销句柄 | null }。 */
export function createSummonPresetRefs() {
  return new Map()
}

/**
 * 归还一次 summon run 的 preset 引用（runExpert 收尾边沿调用；幂等由调用方
 * 边沿标志保证，本函数再对未知键/负数 fail-open 双保险）。
 *
 * 语义（T12 方案 A）：refs -1；归零 → 调 register 返回的 unregister 并删缓存项
 * （缓存项不删会让下次同内容键召唤缓存命中一个已注销 id——悬空派发，绝不允许）；
 * 负数/未知键不注销（fail-open，warn 可见）；无注销句柄（Duplicate 复用旧实例
 * 定义）warn 保留，随旧实例卸载面/进程收尾清理。unregister 异常吞掉并 warn
 * （定义状态以 registry 为准，绝不掩盖 run 的成功/失败结果）。
 *
 * @param refs createSummonPresetRefs() 的 Map
 * @param cache createSummonPresetCache() 的 Map（归零删缓存项用）
 * @param id ensureSummonPreset 返回的 preset id
 * @param expertName 专家名（warn 可读性；缺省占位）
 */
export async function releaseSummonPreset(refs, cache, id, expertName = '未知专家') {
  if (!(refs instanceof Map) || !(cache instanceof Map) || typeof id !== 'string' || !id) return
  const entry = refs.get(id)
  if (!entry) {
    console.warn(`[dsh-expert-orchestrator] per-summon preset 释放遇到未知键（fail-open，不注销）：${id}（专家「${expertName}」）`)
    return
  }
  entry.refs -= 1
  if (entry.refs > 0) return
  if (entry.refs < 0) {
    entry.refs = 0
    console.warn(`[dsh-expert-orchestrator] per-summon preset 引用计数为负（fail-open，不注销）：${id}（专家「${expertName}」）`)
    return
  }
  refs.delete(id)
  // 缓存键 = 内容键（entry.key），非 preset id——删错键会让缓存残留悬空 id。
  cache.delete(entry.key ?? id.slice(SUMMON_PRESET_ID_PREFIX.length))
  if (typeof entry.unregister !== 'function') {
    console.warn(`[dsh-expert-orchestrator] per-summon preset 引用归零但无注销句柄（Duplicate 复用旧实例定义，fail-open 保留）：${id}（专家「${expertName}」）`)
    return
  }
  try {
    await entry.unregister()
  } catch (error) {
    console.warn(`[dsh-expert-orchestrator] per-summon preset 注销异常（已忽略，定义状态以 registry 为准）：${id}：${error?.message ?? error}`)
  }
}

/** 取宿主 agentPresets 服务。
 *
 *  T10（0.2.1-alpha.4 真机实证）：cordis ctx 是 Proxy（ReflectService get trap，
 *  cordis/lib/index.js:665-690），插件 ctx 上对**未在 inject 声明**的服务做属性
 *  访问会直接 throw `cannot get property "agentPresets" without inject`——get
 *  trap 沿 fiber 链上溯找服务，兄弟 fiber（dsh-agent-preset-registry）提供的
 *  服务不可达，至 root fiber（runtime=null）即抛。旧实现的属性面首查
 *  （`if (ctx?.agentPresets)`）正落此抛点，ctx.get 兜底永远走不到（真机 summon
 *  全体不可用的根因）。
 *
 *  故**注入式读取优先**：`ctx.get` 是 reflect.get 的 mixin 访问器（cordis
 *  lib/index.js:736 mixin / :756 「without the inject requirement」——服务未
 *  提供时返回 undefined 而非抛错），宿主同款用法见 dsh-agent-preset-registry
 *  lib/index.js:172 `fiber.ctx.get(name)`。属性面仅作纯对象 mock / 已声明
 *  inject ctx 的兜底，且全程 try/catch（在 cordis Proxy 上对未注入服务的属性
 *  访问 throw，catch 后按缺失处理，由调用方 fail-fast 文案接管）。
 *
 *  为什么不把 agentPresets 加进插件 inject 声明（lib/index.js）：cordis inject
 *  是硬依赖（Fiber._refresh 缺任一声明项即 INACTIVE 拒载）——≤alpha.2 宿主无
 *  agent-presets 服务，声明会让本插件整体拒载，违反「≤alpha.2 行为零变化」。 */
export function agentPresetsService(ctx) {
  if (ctx == null) return undefined
  // ① 注入式读取：ctx.get 访问器（cordis 全 ctx 皆有；纯对象 mock 无此面则跳过）
  try {
    if (typeof ctx.get === 'function') return ctx.get('agentPresets')
  } catch { /* 访问器面异常 → 属性面兜底 */ }
  // ② 属性面兜底：cordis Proxy 上未声明 inject 的服务属性访问会 throw（T10），
  //    catch 后按缺失处理。
  try {
    if (ctx.agentPresets) return ctx.agentPresets
  } catch { /* 服务未注入：按缺失处理 */ }
  return undefined
}

/**
 * 确保 per-summon preset 已注册并激活，返回其 id（summon 期调用；同内容键幂等）。
 * 失败一律 throw（fail-fast）——preset 通道下 persona 无替代交付缝，静默降级=
 * 专家失明失格（本任务修复的缺陷本身）；错误信息附 preset id 供定位。
 *
 * @param ctx 插件服务 ctx（取 agentPresets 服务 + 卸载面 effect）
 * @param cache createSummonPresetCache() 的 Map
 * @param param {{persona: string, toolFilter: {deny?: string[], allow?: string[]}|null, expertName: string}}
 * @param refs 可选 createSummonPresetRefs() 的 Map（T12 用完即注引用计数；缺省
 *   不计数，行为与旧版一致）。成功返回路径计数 +1：缓存命中 / 新注册 / Duplicate
 *   复用三路皆算——每一路都对应一次真实 summon run 在途窗口（含续跑）。
 * @returns {Promise<string>} preset id（request.agentPreset 直接可用）
 */
export async function ensureSummonPreset(ctx, cache, { persona, toolFilter, expertName }, refs) {
  const registry = agentPresetsService(ctx)
  if (!registry || typeof registry.register !== 'function') {
    throw new Error(`专家 "${expertName}" 派发失败：provider 声明 agentPreset 能力但 agent-presets 服务不可用（preset 通道无 persona 替代交付缝）`)
  }
  const key = summonPresetKey({ persona, toolFilter })
  const hit = cache.get(key)
  if (typeof hit === 'string') {
    // T12：缓存命中也是一次真实在途召唤，引用 +1（entry 缺失只可能出自测试直调
    // 形态——refs 与 cache 生产同生同灭——此时建无句柄 entry，归零 fail-open）。
    if (refs instanceof Map) {
      const entry = refs.get(hit)
      if (entry) entry.refs += 1
      else refs.set(hit, { key, refs: 1, unregister: null })
    }
    return hit
  }
  const id = SUMMON_PRESET_ID_PREFIX + key
  const definition = buildSummonPresetDefinition({ id, persona, toolFilter, expertName, contentKey: key })
  let disposer = null
  try {
    disposer = await registry.register(definition)
  } catch (error) {
    const msg = String(error?.message ?? error)
    // 同内容键的既有定义（插件热重载残留竞态）：复用，不重复注册。
    if (!msg.includes('Duplicate agent preset')) {
      throw new Error(`per-summon preset 注册失败（${id}）：${msg}`)
    }
  }
  if (typeof registry.resolve === 'function') {
    let resolved = null
    try {
      resolved = await registry.resolve(id)
    } catch (error) {
      throw new Error(`per-summon preset 解析失败（${id}）：${error?.message ?? error}`)
    }
    // 挂载失败（组合行兼容性/restrict 未知名等）在 activate 期落为 broken 诊断
    // ——此处 fail-fast 暴露，绝不带着坏 preset 派发。broken 定义会永驻注册表
    // definitions（同内容键后续召唤 duplicate 复用 → 再 resolve → 持续 fail-fast），
    // 错误文案附运维提示：修好组合行/收窄配置后经插件热重载或重启宿主清理旧定义。
    if (resolved?.broken) {
      throw new Error(`per-summon preset 挂载失败（${id}）：${resolved.broken}（该 broken 定义已驻留注册表且本缓存未记入，同内容键后续召唤将持续 fail-fast；修复后经插件热重载或重启宿主清理旧定义再试）`)
    }
  }
  cache.set(key, id)
  // T12 用完即注：成功路径计数 +1（新注册持有 disposer；Duplicate 复用无句柄，
  // 归零时 fail-open warn 保留——旧实例卸载面/进程收尾清理）。
  if (refs instanceof Map) {
    const entry = refs.get(id)
    if (entry) entry.refs += 1
    else refs.set(id, { key, refs: 1, unregister: typeof disposer === 'function' ? disposer : null })
  }
  // 卸载面：插件服务停止时注销全部 per-summon 定义（此时编排面整体下线）——
  // T12 引用计数注销之外保持不变的进程收尾兜底（行为不变）。
  if (disposer && typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => disposer, 'expert-orchestrator:summon-preset')
    } catch { /* effect 面不可用（自测 mock）：跳过，定义随注册方进程生命周期 */ }
  }
  return id
}
