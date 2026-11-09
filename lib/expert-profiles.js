// per-expert 异构档案加载器（v2.8 WP-6 余项 #19 / T15；T6 gh-issues-1-2 扩展）
//
// 每位专家可配置 model / 工具权限（tools） / Skills 白名单（skills） / MCP 白名单
// （mcp）档案；summon 在 persona 组装处（lib/tools.js runExpert）消费档案：
//   - model            → start request 的 agentOptions.model（provider 声明
//                        capabilities.agentOptions 时生效；旧代宿主降级可见）；
//   - effort           → start request 的 agentOptions.reasoningEffort（T26 #22 effort
//                        预检：能力缺失一行告警降级不阻断；值级词表 adapter-owned，静态
//                        不猜——见 lib/effort-preflight.js 文件头边界声明）；
//   - tools.allow/deny → toolFilter 白/黑名单（与递归防护 deny 求并，永不放宽）；
//   - mcp              → MCP server 白名单，展开为非白名单 server 的 mcp__* 工具
//                        deny（需宿主 tools.schemas() 枚举面，缺失时降级可见）；
//   - skills           → 提示级白名单约束注入 persona（宿主 start request 无
//                        per-child 技能缝，两代一致可用的只有提示级，如实声明）。
//
// T6 组/默认层（仅承载 model，结构留扩展位；优先级链解析 resolveExpertModel
// 由 T8 接线至 summon，见 lib/tools.js persona 组装处）：
//   - groups  = { 组名: { model?, members[] } }——领域组：成员名集合 → 组级默认；
//   - defaults = { model? }——全档案兜底默认。
//   两者为档案文档的顶层附加键（experts 之外），与 per-expert 条目同级；随
//   loadExpertProfiles 以纯增量字段（.groups/.defaults）透出：无这两个键时返回
//   结构与 v2.9 现状逐字节一致（现有 deepEqual 断言与消费方零影响）；有键时
//   profileForExpert 以保留键守卫保证增量字段永不作为专家名命中（已知边：专家
//   字面名恰为 "groups"/"defaults" 且顶层同键已配置时被增量字段遮蔽，概率≈0，
//   T8 接线时若成为现实问题再收敛）。
//
// 存储形态（对齐 WP-6a/T13 文件层专家的既有惯例，不引入第二套命名）：
//   - 全局层 = <DSH_HOME|~/.dsh>/expert-profiles.json（与 experts/ 同一 home 定位）；
//   - 项目层 = <会话工作区 cwd>/.dsh/expert-profiles.json；
//   - 同名专家项目层覆盖全局层（groups 按组名、defaults 按字段同语义）；两目录均
//     在 preset 部署树（dst）之外，PROTOCOL/USER_DATA 刷新机制永不触碰（用户数据
//     语义，与文件层专家同裁定）。
//
// 热调语义（验收 (d)）：执行期重读（无任何缓存）——每次 summon 现场读文件，改文
// 件后**新 summon 即生效**、恢复文件即回滚到原值；档案在 summon 入口一次性快照，
// 在途 summon/run 不被任何机制触碰（热改只影响新 summon，边界成立是构造性的）。
//
// 容错（对齐 expert-files.js S1④）：文件缺失 = 正常态（静默、零变化）；单条目/
// 单字段非法 → stderr 告警 + 跳过该条目/字段（该专家退回无档案行为），绝不炸
// summon 主流程。零第三方依赖。读侧容错（历史/手写文件逐字段降级）与写侧严格
// （validateExpertProfileDocument 零告警才落盘）的不对称性是设计裁定：写侧把好
// 落盘关，读侧不拒绝历史文件。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 档案文件名（全局层与项目层同名）。 */
export const EXPERT_PROFILES_FILENAME = 'expert-profiles.json'

/** 全局层档案路径：<DSH_HOME|~/.dsh>/expert-profiles.json——home 定位与
 *  expert-files.js globalExpertsDir 同源（env 注入即测试沙箱锚点）。 */
export function globalProfilesPath(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, EXPERT_PROFILES_FILENAME)
}

/** 项目层档案路径：<cwd>/.dsh/expert-profiles.json（cwd 锚点 = 文件层项目层
 *  专家同源：宿主进程 cwd，即会话工作区）。 */
export function projectProfilesPath(cwd = process.cwd()) {
  return join(cwd, '.dsh', EXPERT_PROFILES_FILENAME)
}

/** 档案条目的合法顶层字段（未知字段告警忽略——防拼写错误悄悄放宽能力面）。
 *  effort 为 T26 #22 effort 预检新增（可选字符串，随 agentOptions.reasoningEffort 下发）。 */
export const EXPERT_PROFILE_FIELDS = Object.freeze(['model', 'tools', 'skills', 'mcp', 'effort'])

/** 文档顶层保留键（experts 之外，T6 新增）：groups/defaults。顶层未知键豁免
 *  循环与 profileForExpert 保留键守卫共用此表（单一真相）。 */
export const EXPERT_PROFILE_DOC_KEYS = Object.freeze(['experts', 'groups', 'defaults'])

/** 组条目的合法字段（T6 本期仅 model/members；结构留扩展位，扩字段时在此登记
 *  并同步 parseExpertGroup/validateExpertProfileDocument）。 */
export const EXPERT_GROUP_FIELDS = Object.freeze(['model', 'members'])

/** 排障开关（沿 DSH_EXPERT_RESUME 惯例）：'0' 或空串整体关闭档案消费（未设置
 *  或其他值均视为开启）。 */
export function profilesEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_PROFILES
  return !(flag === '0' || flag === '')
}

const defaultWarn = (msg) => console.warn(`[dsh-expert-orchestrator] ${msg}`)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 非空字符串数组校验：全部合法 → 原样（trim 保序）；否则 null（字段级丢弃）。 */
const nameList = (v) => {
  if (!Array.isArray(v)) return null
  const out = []
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim()) return null
    out.push(item.trim())
  }
  return out
}

/** 单条档案条目解析（字段级容错）：合法字段收敛为紧凑 profile；无任何有效字段
 *  → null（该条目视同不存在，行为零变化）；未知键逐个告警（roles 先例：未知键
 *  拒绝而非忽略，此处降一档为告警+忽略——档案是可选增强面，硬拒会炸 summon）。 */
export function parseExpertProfile(raw, warn = defaultWarn) {
  if (!isPlainObject(raw)) return { ok: false, error: '条目不是对象' }
  const profile = {}
  const unknown = Object.keys(raw).filter((k) => !EXPERT_PROFILE_FIELDS.includes(k))
  for (const k of unknown) warn(`专家档案存在未知字段，已忽略：${k}（合法字段：${EXPERT_PROFILE_FIELDS.join('/')}）`)
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim()) profile.model = raw.model.trim()
    else warn('专家档案 model 非法（须为非空字符串），该字段已忽略')
  }
  if (raw.effort !== undefined) {
    if (typeof raw.effort === 'string' && raw.effort.trim()) profile.effort = raw.effort.trim()
    else warn('专家档案 effort 非法（须为非空字符串），该字段已忽略')
  }
  if (raw.tools !== undefined) {
    if (isPlainObject(raw.tools)) {
      const tools = {}
      if (raw.tools.allow !== undefined) {
        const allow = nameList(raw.tools.allow)
        if (allow) tools.allow = allow
        else warn('专家档案 tools.allow 非法（须为非空字符串数组），该字段已忽略')
      }
      if (raw.tools.deny !== undefined) {
        const deny = nameList(raw.tools.deny)
        if (deny) tools.deny = deny
        else warn('专家档案 tools.deny 非法（须为非空字符串数组），该字段已忽略')
      }
      if (raw.tools.allow === undefined && raw.tools.deny === undefined) {
        warn('专家档案 tools 为空对象（无 allow/deny），该字段已忽略')
      } else if (Object.keys(tools).length > 0) {
        profile.tools = tools
      }
    } else {
      warn('专家档案 tools 非法（须为 {allow?, deny?} 对象），该字段已忽略')
    }
  }
  if (raw.skills !== undefined) {
    const skills = nameList(raw.skills)
    if (skills && skills.length > 0) profile.skills = skills
    else warn('专家档案 skills 非法（须为非空字符串数组；空数组视同未配置），该字段已忽略')
  }
  if (raw.mcp !== undefined) {
    const mcp = nameList(raw.mcp)
    if (mcp && mcp.length > 0) profile.mcp = mcp
    else warn('专家档案 mcp 非法（须为非空字符串数组；空数组视同未配置），该字段已忽略')
  }
  return { ok: true, profile: Object.keys(profile).length > 0 ? profile : null }
}

/** 组条目解析（T6，字段级容错，对齐 parseExpertProfile 降档纪律）：合法字段收敛
 *  为紧凑组档案；无任何有效字段 → null（该组视同不存在）；未知键逐个告警。
 *  model：非空字符串；members：非空字符串数组（nameList 复用，成员名 trim）。 */
export function parseExpertGroup(raw, warn = defaultWarn) {
  if (!isPlainObject(raw)) return null
  const group = {}
  const unknown = Object.keys(raw).filter((k) => !EXPERT_GROUP_FIELDS.includes(k))
  for (const k of unknown) warn(`专家档案组存在未知字段，已忽略：${k}（合法字段：${EXPERT_GROUP_FIELDS.join('/')}）`)
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim()) group.model = raw.model.trim()
    else warn('专家档案组 model 非法（须为非空字符串），该字段已忽略')
  }
  if (raw.members !== undefined) {
    const members = nameList(raw.members)
    if (members && members.length > 0) group.members = members
    else warn('专家档案组 members 非法（须为非空字符串数组；空数组视同未配置），该字段已忽略')
  }
  return Object.keys(group).length > 0 ? group : null
}

/** defaults 解析（T6，字段级容错）：本期仅 { model? }；非法 → null（视同未配置）；
 *  未知键逐个告警。 */
export function parseExpertDefaults(raw, warn = defaultWarn) {
  if (!isPlainObject(raw)) return null
  const out = {}
  const unknown = Object.keys(raw).filter((k) => k !== 'model')
  for (const k of unknown) warn(`专家档案 defaults 存在未知字段，已忽略：${k}（合法字段：model）`)
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim()
    else warn('专家档案 defaults model 非法（须为非空字符串），该字段已忽略')
  }
  return Object.keys(out).length > 0 ? out : null
}

// groups/defaults 映射面的公共收敛：条目名（组名）非空字符串 trim，条目体经
// parse（字段级容错），null 条目跳过。返回 null 表示顶层键本身形状非法。
function parseGroupDefaultsMap(raw, kind, parseEntry, warn) {
  if (!isPlainObject(raw)) {
    warn(`专家档案文件 ${kind} 键须为对象，已忽略`)
    return null
  }
  const out = {}
  for (const [name, entry] of Object.entries(raw)) {
    const key = typeof name === 'string' ? name.trim() : ''
    if (!key) {
      warn(`专家档案 ${kind} 条目名为空，已跳过`)
      continue
    }
    const parsed = parseEntry(entry, (msg) => warn(`专家档案 ${kind} ${key}：${msg}`))
    if (parsed) out[key] = parsed
  }
  return out
}

/** 单层档案文件读取：缺失 → undefined（正常态静默）；损坏/顶层形状非法或 experts
 *  键非法 → null（告警后视同该层缺失——experts 仍是文档主键，其缺席即整层缺席，
 *  groups/defaults 不单独成层）；合法 → { experts: {名: profile}, groups?,
 *  defaults? }（groups/defaults 仅在配置了且可解析时出现，纯增量字段）。 */
function loadProfilesLayer(path, warn) {
  if (typeof path !== 'string' || !path || !existsSync(path)) return undefined
  let raw = null
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    warn(`专家档案文件 JSON 损坏，整层按缺失处理：${path}——${err?.message ?? err}`)
    return null
  }
  if (!isPlainObject(raw)) {
    warn(`专家档案文件顶层须为对象，整层按缺失处理：${path}`)
    return null
  }
  for (const k of Object.keys(raw)) {
    if (!EXPERT_PROFILE_DOC_KEYS.includes(k)) warn(`专家档案文件存在未知顶层键，已忽略：${k}（${path}）`)
  }
  const experts = raw.experts
  if (!isPlainObject(experts)) {
    if (experts !== undefined) warn(`专家档案文件 experts 键须为对象，整层按缺失处理：${path}`)
    return null
  }
  const out = { experts: {} }
  for (const [name, entry] of Object.entries(experts)) {
    const key = typeof name === 'string' ? name.trim() : ''
    if (!key) {
      warn(`专家档案条目名为空，已跳过：${path}`)
      continue
    }
    const p = parseExpertProfile(entry, (msg) => warn(`专家 ${key} 档案：${msg}`))
    if (!p.ok) {
      warn(`专家 ${key} 档案条目非法，已跳过（该专家按无档案行为）：${p.error}（${path}）`)
      continue
    }
    if (p.profile) out.experts[key] = p.profile
  }
  // T6 附加层：仅承载 model（本期），字段级容错；experts 非法时整层已按缺失
  // 处理，不会走到这里（groups/defaults 不独立成层）。
  if (raw.groups !== undefined) {
    const groups = parseGroupDefaultsMap(raw.groups, 'groups', parseExpertGroup, warn)
    if (groups && Object.keys(groups).length > 0) out.groups = groups
  }
  if (raw.defaults !== undefined) {
    const defaults = parseExpertDefaults(raw.defaults, (msg) => warn(`专家档案 defaults：${msg}`))
    if (defaults) out.defaults = defaults
  }
  return out
}

/** 单层档案文档读取（T6，Remote 读缝数据源）：缺失/损坏/非法层 → 空 doc（读侧
 *  容错，绝不抛）；合法层 → { experts, groups, defaults }（groups/defaults 未配置
 *  时为空对象——Remote 视图恒三键齐全）。 */
export function loadExpertProfilesDoc(path, warn = defaultWarn) {
  const layer = loadProfilesLayer(path, warn)
  return {
    experts: layer?.experts ?? {},
    groups: layer?.groups ?? {},
    defaults: layer?.defaults ?? {},
  }
}

/** 双层级档案加载（执行期重读入口，热调锚点）：项目层覆盖全局层（同名专家/组名/
 *  字段），返回 { 专家名: profile } 平面对象 + T6 纯增量字段 .groups/.defaults
 *  （仅任一层配置了对应键且可解析时出现——无键时返回结构与 v2.9 现状逐字节一致）；
 *  两层都缺失/关闭 → {}（零变化）。每次调用现场读文件，无任何缓存。导出供自测。 */
export function loadExpertProfiles({ homePath, projectPath } = {}, warn = defaultWarn, env = process.env) {
  if (!profilesEnabled(env)) return {}
  const project = loadProfilesLayer(projectPath, warn)
  const global = loadProfilesLayer(homePath, warn)
  const merged = {}
  // 全局层先铺底、项目层后覆盖：同名专家项目层胜（对齐文件层 项目>全局 语义）。
  for (const [name, profile] of Object.entries(global?.experts ?? {})) merged[name] = profile
  for (const [name, profile] of Object.entries(project?.experts ?? {})) merged[name] = profile
  // T6 增量字段：groups 按组名覆盖、defaults 按字段覆盖（项目层胜）。
  if (global?.groups || project?.groups) {
    const groups = {}
    for (const [name, group] of Object.entries(global?.groups ?? {})) groups[name] = group
    for (const [name, group] of Object.entries(project?.groups ?? {})) groups[name] = group
    merged.groups = groups
  }
  if (global?.defaults || project?.defaults) {
    merged.defaults = { ...(global?.defaults ?? {}), ...(project?.defaults ?? {}) }
  }
  return merged
}

const normName = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** 取某专家的档案：精确名（trim）命中优先，其次归一名（trim+lower）命中——
 *  与 summon 解析链的归一口径一致；未配置 → null（调用方按无档案走）。
 *  T6 保留键守卫：.groups/.defaults 增量字段永不作为专家名命中（T8 组/默认层
 *  消费它们，per-expert 查询必须先于组层直达专家条目语义）。
 *  T2（gh-issues-1-2 追问）别名反查：档案键常以惯用名（roster-aliases 键）或
 *  花名册 title（bundled-core 中文显示名）书写，而查询名是 summon 已解析的原生
 *  名——直查双遍全未命中时，若传入可选 aliasResolver（(key) => 原生名 | null，
 *  由 lib/tools.js profileKeyAliasResolver 产出），则对档案键逐个反查归一后再
 *  比对（normName 口径，键序取首个命中——确定性）；未传/反查不命中 → 行为与
 *  既有双遍逐字节一致。保留键守卫同样约束反查遍。 */
export function profileForExpert(profiles, name, aliasResolver) {
  if (!profiles || typeof name !== 'string') return null
  const key = name.trim()
  if (!key) return null
  if (!EXPERT_PROFILE_DOC_KEYS.includes(key) && profiles[key]) return profiles[key]
  const hit = Object.entries(profiles).find(([k]) => normName(k) === normName(key) && !EXPERT_PROFILE_DOC_KEYS.includes(k))
  if (hit) return hit[1]
  if (typeof aliasResolver !== 'function') return null
  const aliasHit = Object.entries(profiles).find(([k]) => {
    if (EXPERT_PROFILE_DOC_KEYS.includes(k)) return false
    const native = aliasResolver(k)
    return typeof native === 'string' && native.trim() !== '' && normName(native) === normName(key)
  })
  return aliasHit ? aliasHit[1] : null
}

/** 组层 members 匹配（T8）：复用 profileForExpert 的精确/归一名口径——精确（trim
 *  相等）优先于归一（trim+lower 相等），对组集做两遍扫描实现该优先序。
 *  T2 别名反查（可选 aliasResolver）：成员名以惯用名/花名册 title 书写时经反查
 *  归一为原生名再与 key 比对——同缝两遍扫描内叠加（精确遍比对 trim 相等、归一
 *  遍比对 normName 相等），未传 resolver 时两遍行为逐字节不变。 */
const groupMemberHit = (groups, groupNames, key, exact, aliasResolver) => groupNames.filter((g) => {
  const members = groups[g]?.members
  return Array.isArray(members) && members.some((m) => {
    if (exact) {
      if (typeof m === 'string' && m.trim() === key) return true
      if (typeof aliasResolver !== 'function') return false
      const native = aliasResolver(m)
      return typeof native === 'string' && native.trim() === key
    }
    if (normName(m) === normName(key)) return true
    if (typeof aliasResolver !== 'function') return false
    const native = aliasResolver(m)
    return typeof native === 'string' && normName(native) === normName(key)
  })
})

/** T8（gh-issues-1-2）：专家 model 优先级链解析（纯函数，导出供自测）。
 *  链（用户裁决）：① 逐专家档案 > ② 领域组 > ③ defaults 兜底 > ④ 未设置 = null
 *  （=主会话模型，summon 侧现状行为）。
 *  - ① 复用 profileForExpert（精确/归一口径 + groups/defaults 保留键守卫）；
 *  - ② 组间按声明顺序（对象键序）取首个 members 命中组；多组命中 stderr 告警
 *    （归组重叠提示）；首个命中组未声明 model → 组层无值，继续 ③；
 *  - ③ defaults.model；均未设置 → null。
 *  groups/defaults 仅承载 model（T6 裁决），tools/skills/mcp/effort 永不入组层。
 *  @param profiles loadExpertProfiles 返回的双层合并视图（{ 专家名: profile,
 *                  groups?, defaults? }）——手工构造对象须同形。
 *  @param warn 告警 sink（缺省 stderr；测试注入 noop）。
 *  @param aliasResolver T2 可选别名反查（(key) => 原生名 | null）：① 逐专家档案
 *                  与 ② 组层 members 同缝消费；未传 = 行为与现状逐字节一致。
 *  @returns 非空 model 字符串或 null；对无 groups/defaults 的平面视图返回值与
 *                  「直接取 per-expert 档案 model」逐字节一致（回归硬门）。 */
export function resolveExpertModel(profiles, name, warn = defaultWarn, aliasResolver) {
  if (!profiles || typeof name !== 'string') return null
  const key = name.trim()
  if (!key) return null
  const profile = profileForExpert(profiles, key, aliasResolver)
  if (profile?.model) return profile.model
  const groups = isPlainObject(profiles.groups) ? profiles.groups : {}
  const groupNames = Object.keys(groups)
  for (const exact of [true, false]) {
    const hits = groupMemberHit(groups, groupNames, key, exact, aliasResolver)
    if (hits.length === 0) continue
    if (hits.length > 1) {
      warn(`专家 ${key} 同属多个分组（${hits.join('、')}）——按声明顺序取「${hits[0]}」的组级 model（归组重叠提示：建议合并或去重分组成员）`)
    }
    const first = groups[hits[0]]
    if (first?.model) return first.model
    break // 首个命中组未声明 model → 组层无值，落 defaults 兜底
  }
  const defaults = isPlainObject(profiles.defaults) ? profiles.defaults : {}
  return defaults.model ?? null
}

// ── T6 写侧严格校验（Remote 存储缝落盘门）────────────────────────────────────
//
// 读侧容错 / 写侧严格的不对称（设计裁定，见文件头）：本函数对**将落盘的整个文
// 档**做零告警检查——任何未知顶层键、条目未知字段、非法字段值都整体拒绝（fail
// closed），保证写入的文件读回时零告警零静默丢弃；拒绝时调用方（lib/index.js
// remoteSaveExpertProfiles）不得触碰原文件。

/** 档案文档写侧校验：合法 → { ok:true, doc:{experts,groups,defaults} }（归一化：
 *  名/值 trim、空 groups/defaults 收敛为缺省——落盘省略）；非法 → { ok:false,
 *  error }（error 含定位路径，未捕获 warn 直接抛由调用方兜底不适用——本函数不
 *  告警，纯判定）。experts 必须为对象（可为 {}，语义=清空全部 per-expert 档案）。 */
export function validateExpertProfileDocument(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: '顶层须为对象' }
  const unknownTop = Object.keys(raw).filter((k) => !EXPERT_PROFILE_DOC_KEYS.includes(k))
  if (unknownTop.length > 0) {
    return { ok: false, error: `未知顶层键：${unknownTop.join(', ')}（合法键：${EXPERT_PROFILE_DOC_KEYS.join('/')}）` }
  }
  const doc = { experts: {}, groups: {}, defaults: {} }
  const experts = raw.experts
  if (!isPlainObject(experts)) return { ok: false, error: 'experts 键须为对象' }
  for (const [name, entry] of Object.entries(experts)) {
    const key = typeof name === 'string' ? name.trim() : ''
    if (!key) return { ok: false, error: `experts 条目名为空（${JSON.stringify(name)}）` }
    const unknown = isPlainObject(entry) ? Object.keys(entry).filter((k) => !EXPERT_PROFILE_FIELDS.includes(k)) : []
    if (unknown.length > 0) {
      return { ok: false, error: `experts.${key} 存在未知字段：${unknown.join(', ')}（合法字段：${EXPERT_PROFILE_FIELDS.join('/')}）` }
    }
    const p = parseExpertProfile(entry ?? {}, () => {})
    if (!p.ok) return { ok: false, error: `experts.${key} 非法：${p.error}` }
    // 严格纪律：非空条目必须收敛出档案（有键但全非法 → 拒绝而非静默丢弃）；
    // 空对象条目 = 未配置（归一化省略）。
    if (!p.profile && isPlainObject(entry) && Object.keys(entry).length > 0) {
      return { ok: false, error: `experts.${key} 无任何合法字段（${JSON.stringify(entry)}）` }
    }
    if (p.profile) doc.experts[key] = p.profile
  }
  if (raw.groups !== undefined) {
    if (!isPlainObject(raw.groups)) return { ok: false, error: 'groups 键须为对象' }
    for (const [name, entry] of Object.entries(raw.groups)) {
      const key = typeof name === 'string' ? name.trim() : ''
      if (!key) return { ok: false, error: `groups 条目名为空（${JSON.stringify(name)}）` }
      const unknown = isPlainObject(entry) ? Object.keys(entry).filter((k) => !EXPERT_GROUP_FIELDS.includes(k)) : []
      if (unknown.length > 0) {
        return { ok: false, error: `groups.${key} 存在未知字段：${unknown.join(', ')}（合法字段：${EXPERT_GROUP_FIELDS.join('/')}）` }
      }
      const g = parseExpertGroup(entry ?? {}, () => {})
      if (!g) return { ok: false, error: `groups.${key} 无任何合法字段（${JSON.stringify(entry)}）` }
      doc.groups[key] = g
    }
  }
  if (raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults)) return { ok: false, error: 'defaults 键须为对象' }
    const unknown = Object.keys(raw.defaults).filter((k) => k !== 'model')
    if (unknown.length > 0) return { ok: false, error: `defaults 存在未知字段：${unknown.join(', ')}（合法字段：model）` }
    if (Object.keys(raw.defaults).length > 0) {
      // 空对象 = 未配置（归一化省略）；有键但全非法 = 严格拒绝（零告警落盘纪律）。
      const d = parseExpertDefaults(raw.defaults, () => {})
      if (!d) return { ok: false, error: `defaults 无任何合法字段（${JSON.stringify(raw.defaults)}）` }
      doc.defaults = d
    }
  }
  if (Object.keys(doc.groups).length === 0) delete doc.groups
  if (Object.keys(doc.defaults).length === 0) delete doc.defaults
  return { ok: true, doc }
}
