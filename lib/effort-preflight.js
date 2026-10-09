// #22 之三：effort 预检（v2.8 M8-2 / WP-7 ④，T26）
//
// 参考实现：expert-team lib/effort-preflight.js + swarm lib/preflight.js（调研
// C-expert-team-swarm §2/§3 ③；借鉴结论见 expert-team-research/C-expert-team-swarm.md
// 第 6 条）。定位与参考一致：**声明式预检、一行告警、不阻断**——档案里声明了推理档位
// （reasoning effort）但派发通道带不动时，在派发边界（summon 入口）就把失配喊出来，
// 而不是「先派谁先报谁」（调研实录的真实故障：能力表漏配 → 12 角色逐个失败）。
//
// 与参考实现的差异（本插件 seam 能力面实测后的诚实边界，2026-10-09）：
// - expert-team 会对「会话路由能力表」做值级比对（reasoningEfforts map 明确排除该 pin 才
//   strip，缺席=未知≠拒绝——被实测纠偏过的策略）。本插件可达的 seam（provider.capabilities
//   = {agentOptions, outputSchema, depthLimit, toolFilter, persona} 布尔面 + dsh-subagent
//   0.2.1 types）**没有 effort 词表/枚举缝**：ReasoningEffortId 是 adapter-owned 的 Branded
//   字符串（dsh-llm），各 adapter 自持词表（pi-ai 走 catalog.models[].reasoningEfforts，
//   不经 ctx 暴露）。因此本预检只覆盖两类**确定**失配：① 声明了 effort 但 provider 未声明
//   agentOptions 能力（整包降级，一行告警）；② 字段级形状非法（expert-profiles.js 解析层
//   已丢弃并告警）。值本身是否被路由接受=运行时事实，静态不猜（宁降级可见勿误杀合法 pin）。
// - 落地面：#19 档案新增可选字段 `effort`（字符串；与 model 同为 agentOptions 载荷）——
//   provider 声明 agentOptions 能力时随 agentOptions.reasoningEffort 下发（dsh-agent
//   AgentOptions 原生字段），否则一行告警降级；model 与 effort 可独立声明（effort-only
//   覆盖是 AgentOptions 合法形态）。
/** 排障开关（沿 DSH_EXPERT_* 惯例）：'0' 或空串整体关闭 effort 预检（档案 effort 字段
 *  本次派发不生效、零告警——model 分支不受影响照常走）。 */
export function effortPreflightEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_EFFORT
  return !(flag === '0' || flag === '')
}

/** 派发前预检（lib/tools.js runExpert 调用；无档案或档案无 model/effort → 行为零变化）。
 *  返回 { agentOptions, warnings, answerHints }：
 *  - agentOptions=组装后的覆盖包（无任何键时 undefined，start spec 形状与既有逐字节一致）；
 *  - warnings=全部降级告警（调用方 console.warn——host 日志面，model 降级告警的既有语义，
 *    T15 基线不漂移：不进 answer）；
 *  - answerHints=answer 尾部提示行子集（effort 预检告警——#22 新增可见面，非阻断）。
 *  导出供自测。 */
export function preflightEffort({ profile, caps, providerName, env = process.env, warn = (m) => console.warn(`[dsh-expert-orchestrator] ${m}`) } = {}) {
  const warnings = []
  const answerHints = []
  if (!profile || (!profile.model && !profile.effort)) return { agentOptions: undefined, warnings, answerHints }
  const agentOptions = {}
  if (profile.model) {
    // model 降级告警文本与既有实现逐字节一致（T15 起的行为面，不因本模块漂移）。
    if (caps?.agentOptions === true) agentOptions.model = profile.model
    else warnings.push(`专家档案 model=${profile.model} 未生效：provider "${providerName}" 未声明 agentOptions 能力（旧代宿主，降级可见）`)
  }
  if (profile.effort && effortPreflightEnabled(env)) {
    if (caps?.agentOptions === true) agentOptions.reasoningEffort = profile.effort
    else {
      warnings.push(`专家档案 effort=${profile.effort} 未生效（effort 预检）：provider "${providerName}" 未声明 agentOptions 能力（旧代宿主，降级可见）`)
      answerHints.push(...warnings.slice(-1))
    }
  }
  return { agentOptions: Object.keys(agentOptions).length > 0 ? agentOptions : undefined, warnings, answerHints }
}
