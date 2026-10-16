// dsh-expert-orchestrator — per-summon preset 的工具收窄组合行（T3 ③）
//
// 形状对齐 @deepseek-ai/dsh-persona 的组合行插件（name/inject/apply，零依赖）：
// 它是 lib/summon-preset.js 生成的 per-summon preset 定义里的一个组合行
// （row name = 本模块的 file URL，Loader 按 dsh-app-boot anchorInsertedPluginNames
// 同款 file URL 语义解析），在 preset generation scope 挂载期执行一次
// ctx.tools.restrict(config)，把 summon 期计算好的全局工具收窄（deny 名单，
// 可选 allow）记录到该 generation 的 restriction 层——绑定到本 preset 的被召唤
// 专家子代理经 scope 链（child → generation → root）继承该限制，等价于
// ≤alpha.2 直传通道里宿主 applyChildOverrides 的 childCtx.tools.restrict。
//
// 边界（与 ≤alpha.2 直传语义逐项对齐）：
// - 只收全局层确证名（lib/tools.js filterRestrictableTools 已在构建侧探测过滤），
//   restrict 的未知名校验（dsh-tools lib/index.js:2984）因此不炸；
// - allow/deny 双缺（空过滤器）不调用 restrict——宿主对 no-op 过滤器直接 throw
//   （dsh-tools lib/index.js:2977），构建侧保证仅在名单非空时携带本行；
// - generation scope 是 scoped context，满足 restrict 的作用域前置校验
//   （dsh-tools lib/index.js:2974）；own 层豁免语义不受影响（本行不注册工具）。
//
// 失败路径：restrict throw（未知名/作用域缺失）会令 preset 挂载失败
// （dsh-agent-preset-registry activate → record.broken），ensureSummonPreset 经
// registry.resolve(id).broken fail-fast 暴露——不静默丢工具收窄。
const name = 'expert-orchestrator-summon-restrict'

/** 依赖 tools 服务（restrict 调用面）；声明注入保证挂载序。 */
const inject = ['tools']

/**
 * Apply one global-tool restriction for the mounting preset generation scope.
 * @param ctx - preset generation scope context（mountPreset 的 scoped ctx）。
 * @param config - { allow?: string[], deny?: string[] }，构建侧已探测过滤且非空。
 */
function apply(ctx, config) {
  const allow = Array.isArray(config?.allow) ? config.allow : undefined
  const deny = Array.isArray(config?.deny) ? config.deny : undefined
  if (allow === undefined && deny === undefined) return
  ctx.tools.restrict({
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
  })
}

export { name, inject, apply }
