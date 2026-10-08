/**
 * dsh-expert-orchestrator — host settings-page Config schema (WP-8 ①)
 *
 * 目标（SUMMARY #23 / v2.6-plan.md WP-8 第①项）：把插件的用户级配置注册到宿主
 * 「插件配置」页（设置 → 插件 → 插件配置）。机制以宿主 0.2.1-alpha.1 实测源码
 * 为准（@deepseek-ai/dsh-settings `SettingsForms`）：
 *   - 宿主读取每个活动插件 runtime 模块命名空间上的 `Config` 导出
 *     （schemastery schema），投影为 settings 命名空间（ns = Loader entry id，
 *     即本插件的 `dsh-expert-orchestrator` 部署行）；
 *   - 仅带 `volatile` 标记的字段进入活动表单（volatileForm 投影）；整份 schema
 *     没有任何 volatile 字段时，该命名空间**整体不出现**在设置页——这是宿主行
 *     为，不是缺陷；
 *   - 表单写入落 profile patch（cordis.patch.yml 顶层 `id: dsh-expert-orchestrator`
 *     config 段），因此随插件市场的 profile 备份/恢复走；
 *   - volatile 字段的编辑不重载插件（fiber 原地更新 Volatile 引用）；普通字段
 *     的编辑走常规重载（apply 以新 config 重新执行）。两者都是正确生效路径。
 *
 * 降级纪律（坑②：少一个开关，好过注册失败拖垮插件加载）：
 *   1. 动态 import：静态 import schemastery 会让从仓库路径 import lib/ 的测试
 *      直接 ERR_MODULE_NOT_FOUND（expert-team 同款教训）；
 *   2. 逐能力特性探测：`.volatile()` 只在宿主 schemastery 提供时才调用（较旧的
 *      副本没有该方法）；`.description()` 同理；任何装饰失败都退回未装饰字段；
 *   3. 全部失败路径收敛为「不导出 Config」——lib/index.js 侧把本模块任何异常
 *      折叠为 `Config = undefined`，宿主视为「无设置页」，插件照常装载；
 *   4. 设置降级值一律 undefined 语义（default 显式声明），绝不写 null——null
 *      会随文档往返并拖垮整份设置文档（经验池教训）。
 *
 * 消费方契约：`config.autoClaim` 由 apply() 原样传给 lib/tools.js 的
 * registerExpertTools；该值可能是 Volatile 引用（宿主 volatile 生效路径）或
 * 普通布尔，读取端必须两者都接受（readSetting 帮手在本模块导出，tools.js 使用）。
 */

/** schemastery 解析顺序：scoped 宿主包优先（0.2.x 宿主实测存在），裸包名兜底
 *  （市场安装形态下由其他市场插件的依赖提升提供——见 profile node_modules）。
 *  DSH_EXPERT_ORCHESTRATOR_SCHEMASTERY 允许测试注入桩模块（置于最前）。 */
const SPECIFIERS = ['@deepseek-ai/schemastery', 'schemastery']

export async function loadSchemastery(inject = process.env.DSH_EXPERT_ORCHESTRATOR_SCHEMASTERY) {
  for (const spec of [...(inject ? [inject] : []), ...SPECIFIERS]) {
    try {
      return await import(spec)
    } catch {
      /* resolution misses are expected on bare checkouts — try the next specifier */
    }
  }
  return null
}

/** Best-effort decoration: apply `.method(...)` only when the host schemastery
 *  actually provides it; a throwing decoration downgrades to the bare schema
 *  instead of failing the build. */
function optional(schema, method, ...args) {
  try {
    if (schema && typeof schema[method] === 'function') return schema[method](...args)
  } catch {
    /* decoration is best-effort */
  }
  return schema
}

/** Build the plugin Config schema from a resolved schemastery module.
 *  Returns null (never throws) when the module is unusable — callers treat
 *  null as "no settings page". Fields:
 *   - expertTools.provider  普通 string（默认 'spawn'）：召唤工具的 subagent
 *     provider；编辑走插件重载后生效（工具注册发生在 apply 期，不能热改）。
 *   - autoClaim             boolean（默认 true，尽量 volatile）：派工自动认领
 *     开关（WP-4a）。volatile 可用时编辑即时生效（summon 期读 Volatile 引用）；
 *     不可用时注册为普通字段，编辑后随插件重载生效——语义不变，只是生效时点
 *     后移。 */
export function buildConfigSchema(mod) {
  try {
    const z = mod?.default ?? mod
    if (typeof z?.object !== 'function' || typeof z?.string !== 'function' || typeof z?.boolean !== 'function') {
      return null
    }
    const provider = optional(
      z.string().default('spawn'),
      'description',
      'summon_expert 使用的 subagent provider；修改后插件重载生效（subagent provider for summon_expert; takes effect after the plugin reloads）',
    )
    const autoClaim = optional(
      z.boolean().default(true),
      'description',
      '派工自动认领已派任务 id（WP-4a auto-claim）；volatile 支持时即时生效，否则插件重载后生效（auto-claim dispatched task ids; live when volatile is supported, otherwise after plugin reload）',
    )
    const schema = z.object({
      expertTools: z.object({ provider }),
      autoClaim: optional(autoClaim, 'volatile'),
    })
    // Host seam contract: a Config the settings service can project must carry
    // toJSON (SettingsForms.schema checks `"toJSON" in schema`). Anything else
    // is treated as unusable rather than half-registered.
    return typeof schema?.toJSON === 'function' ? schema : null
  } catch {
    return null
  }
}

/** Load + build in one step; resolves null when schemastery is unavailable. */
export async function buildPluginConfigSchema() {
  try {
    return buildConfigSchema(await loadSchemastery())
  } catch {
    return null
  }
}

/** Read a config value that may be a host Volatile reference (a `get()`
 *  function returning an immutable snapshot) or a plain value. The duck-type
 *  check avoids importing @deepseek-ai/cosmokit into the plugin. */
export function readSetting(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}
