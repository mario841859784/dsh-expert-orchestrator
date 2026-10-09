// per-expert 异构档案加载器（v2.8 WP-6 余项 #19 / T15）
//
// 每位专家可配置 model / 工具权限（tools） / Skills 白名单（skills） / MCP 白名单
// （mcp）档案；summon 在 persona 组装处（lib/tools.js runExpert）消费档案：
//   - model            → start request 的 agentOptions.model（provider 声明
//                        capabilities.agentOptions 时生效；旧代宿主降级可见）；
//   - tools.allow/deny → toolFilter 白/黑名单（与递归防护 deny 求并，永不放宽）；
//   - mcp              → MCP server 白名单，展开为非白名单 server 的 mcp__* 工具
//                        deny（需宿主 tools.schemas() 枚举面，缺失时降级可见）；
//   - skills           → 提示级白名单约束注入 persona（宿主 start request 无
//                        per-child 技能缝，两代一致可用的只有提示级，如实声明）。
//
// 存储形态（对齐 WP-6a/T13 文件层专家的既有惯例，不引入第二套命名）：
//   - 全局层 = <DSH_HOME|~/.dsh>/expert-profiles.json（与 experts/ 同一 home 定位）；
//   - 项目层 = <会话工作区 cwd>/.dsh/expert-profiles.json；
//   - 同名专家项目层覆盖全局层；两目录均在 preset 部署树（dst）之外，PROTOCOL/
//     USER_DATA 刷新机制永不触碰（用户数据语义，与文件层专家同裁定）。
//
// 热调语义（验收 (d)）：执行期重读（无任何缓存）——每次 summon 现场读文件，改文
// 件后**新 summon 即生效**、恢复文件即回滚到原值；档案在 summon 入口一次性快照，
// 在途 summon/run 不被任何机制触碰（热改只影响新 summon，边界成立是构造性的）。
//
// 容错（对齐 expert-files.js S1④）：文件缺失 = 正常态（静默、零变化）；单条目/
// 单字段非法 → stderr 告警 + 跳过该条目/字段（该专家退回无档案行为），绝不炸
// summon 主流程。零第三方依赖。
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

/** 档案条目的合法顶层字段（未知字段告警忽略——防拼写错误悄悄放宽能力面）。 */
export const EXPERT_PROFILE_FIELDS = Object.freeze(['model', 'tools', 'skills', 'mcp'])

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

/** 单层档案文件读取：缺失 → undefined（正常态静默）；损坏/顶层形状非法 → null
 *  （告警后视同该层缺失）；合法 → { 专家名(trim): profile } 平面对象。 */
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
    if (k !== 'experts') warn(`专家档案文件存在未知顶层键，已忽略：${k}（${path}）`)
  }
  const experts = raw.experts
  if (!isPlainObject(experts)) {
    if (experts !== undefined) warn(`专家档案文件 experts 键须为对象，整层按缺失处理：${path}`)
    return null
  }
  const out = {}
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
    if (p.profile) out[key] = p.profile
  }
  return out
}

/** 双层级档案加载（执行期重读入口，热调锚点）：项目层覆盖全局层（同名专家），
 *  返回 { 专家名: profile } 平面对象；两层都缺失/关闭 → {}（零变化）。每次调用
 *  现场读文件，无任何缓存。导出供自测。 */
export function loadExpertProfiles({ homePath, projectPath } = {}, warn = defaultWarn, env = process.env) {
  if (!profilesEnabled(env)) return {}
  const project = loadProfilesLayer(projectPath, warn)
  const global = loadProfilesLayer(homePath, warn)
  const merged = {}
  // 全局层先铺底、项目层后覆盖：同名专家项目层胜（对齐文件层 项目>全局 语义）。
  for (const [name, profile] of Object.entries(global ?? {})) merged[name] = profile
  for (const [name, profile] of Object.entries(project ?? {})) merged[name] = profile
  return merged
}

const normName = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** 取某专家的档案：精确名（trim）命中优先，其次归一名（trim+lower）命中——
 *  与 summon 解析链的归一口径一致；未配置 → null（调用方按无档案走）。 */
export function profileForExpert(profiles, name) {
  if (!profiles || typeof name !== 'string') return null
  const key = name.trim()
  if (!key) return null
  if (profiles[key]) return profiles[key]
  const hit = Object.entries(profiles).find(([k]) => normName(k) === normName(key))
  return hit ? hit[1] : null
}
