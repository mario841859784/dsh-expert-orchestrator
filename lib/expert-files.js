// 专家定义文件层加载器（v2.7 WP-6a / T13）
//
// 三层覆盖语义（用户裁决 2026-10-07 Q4=4A）：项目层 > 全局层 > 内置/来源包。
// 内置 11 位与来源包保留只读兜底层，.md 文件层是叠加不是修改——同名专家由
// summon 解析链在文件层命中时优先取用；跨源重名去重语义（dedup 代表规则）只
// 在文件层未覆盖时生效；来源包专家 sha256 钉定不受影响。
//
// 路径约定（与 lib/index.js resolvePresetTargetDir 的 .dsh 定位约定同源）：
// - 全局层 = <home>/experts/*.md，home = env.DSH_HOME || join(homedir(), '.dsh')
//   （宿主根即 .dsh 目录所在层级；部署副本 DSH_HOME=/vol2/…/Harness/.dsh 时
//   全局层落在 <宿主根>/.dsh/experts/）；
// - 项目层 = <会话工作区 cwd>/.dsh/experts/*.md（cwd 锚点 = autoClaimCwd 同源：
//   「宿主进程 cwd，即会话工作区」）。
//
// 部署机制兼容性：两个目录均在 preset 部署树（dst）之外，lib/index.js 的
// PROTOCOL 清单（VERSION 变更整目录覆盖）与 USER_DATA 清单（只缺才补）都不
// 触碰它们——.md 文件层属用户数据语义，刷新/重装永不覆盖用户定义。
//
// 执行期重读（S3）：无进程级缓存、无 mtime 失效缓存——loadFileExperts 每次调
// 用现场扫描两层目录、summon 现场读 .md 全文，改文件立即生效，无需重启宿主。
//
// 容错（S1④）：单文件解析失败/读取失败 → stderr 告警 + 跳过，绝不炸整个花名
// 册；目录缺失/不可读 → 视为空层。零第三方依赖：frontmatter 为行式 key: value
// 子集解析（对齐 extractPersonaMethod 的行解析惯例，不做完整 YAML）。
import { join } from 'node:path'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'

/** 文件层专家在 summon 解析链中的伪来源 id（花名册来源 id 语义独立，不进
 *  sources 状态机；不参与 getExpertContent/安装流水线）。
 *  回炉 m4（命名空间隔离）：id 首字符 '.' 不满足来源 id 白名单 SOURCE_ID_RE
 *  （/^[a-z0-9]…/，见 lib/index.js）——任何来源包/自定义来源的 id 都不可能与
 *  它撞名，list_experts 的 bySource 分组互不干扰（'file' 等合法来源 id 保留给
 *  花名册来源组，文件层永不占用 SOURCE_ID_RE 字符空间内的名字）。 */
export const FILE_LAYER_SOURCE_ID = '.file-layer'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

const normName = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

const defaultWarn = (msg) => console.warn(`[dsh-expert-orchestrator] ${msg}`)

/** 全局层目录：<DSH_HOME | ~/.dsh>/experts（与 lib/index.js resolvePresetTargetDir
 *  同一 .dsh 定位约定，env 注入即测试沙箱锚点）。 */
export function globalExpertsDir(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'experts')
}

/** 项目层目录：<cwd>/.dsh/experts。 */
export function projectExpertsDir(cwd = process.cwd()) {
  return join(cwd, '.dsh', 'experts')
}

/** 行式 frontmatter 解析。name 必填；其余键（title/method/描述等）原样保留为
 *  字符串（可选字段对齐既有 persona frontmatter 惯例，不定义 schema 超集）。
 *  注释行（# 开头）与空行跳过；无法解析的行 → 整文件拒绝（定义文件格式错误
 *  应显式暴露，静默吞键会产出与作者意图不符的专家）。 */
export function parseExpertFrontmatter(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '内容不是文本' }
  // 回炉 m2：剥一个前导 UTF-8 BOM（Windows 编辑器常见）——BOM 文件不再被误报
  // 「缺少 frontmatter 块」；仅剥首个 \uFEFF，正文中的 BOM 字符不在此处理。
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { ok: false, error: '缺少 frontmatter 块（文件须以 --- 包裹的 frontmatter 开头）' }
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const kv = /^([^\s:#][^:]*):[ \t]*(.*)$/.exec(line)
    if (!kv) return { ok: false, error: `frontmatter 行无法解析：${line.trim().slice(0, 40)}` }
    fm[kv[1].trim()] = kv[2].trim()
  }
  const name = typeof fm.name === 'string' ? fm.name.trim() : ''
  if (!name) return { ok: false, error: 'frontmatter 缺少必填 name 字段' }
  return { ok: true, fm, name }
}

/** 单文件解析：成功 → { ok, expert:{name, title, method} }；失败 → { ok:false,
 *  error }（调用方负责 stderr 告警与跳过）。title/method 为可选键，缺失 → null。 */
export function parseExpertFile(raw) {
  const p = parseExpertFrontmatter(raw)
  if (!p.ok) return p
  const title = typeof p.fm.title === 'string' && p.fm.title.trim() ? p.fm.title.trim() : null
  const method = typeof p.fm.method === 'string' && p.fm.method.trim() ? p.fm.method.trim() : null
  return { ok: true, expert: { name: p.name, title, method } }
}

/** 扫描单层目录顶层 *.md（非递归，文件名排序保证确定性）。返回条目数组：
 *  { source:'file', layer, file, name, title, method, path }。坏文件告警跳过；
 *  同层同名（name 归一重复）首文件胜出、后者告警跳过。 */
export function scanExpertDir(dir, layer, warn = defaultWarn) {
  if (typeof dir !== 'string' || !dir) return []
  // 回炉 M1-R2（目录级守卫，对齐 lib/index.js 来源根符号链接直接拒绝的先例）：
  // 对目录本身 lstat（不用 existsSync——它跟随链接）。<proj>/.dsh/experts 可随
  // 仓库 clone 携带目录符号链接，成员级 lstat 只查末段组件，链接目录外的 .md
  // 将未经检查入册并可读——目录本身为符号链接（含悬空）→ 空层 + stderr 告警。
  // 只拒 experts 目录自身为链接，不检查祖先组件（~/.dsh 经 dotfiles 软链部署
  // 不受影响）；全局层/项目层两处入口同经本守卫。目录缺失/不可及 → 按空层
  // （既有 S1④ 容错语义不变，静默）。
  let dst = null
  try {
    dst = lstatSync(dir)
  } catch {
    return []
  }
  if (dst.isSymbolicLink()) {
    warn(`专家定义目录是符号链接，按空层处理（symlink 永不进信任面）：${dir}`)
    return []
  }
  if (!dst.isDirectory()) {
    warn(`专家定义路径不是目录，按空层处理：${dir}`)
    return []
  }
  let names
  try {
    names = readdirSync(dir)
  } catch (err) {
    warn(`专家定义目录不可读，按空层处理：${dir}——${err?.message ?? err}`)
    return []
  }
  const entries = []
  const seen = new Map() // norm(name) -> path（同层重名首胜）
  for (const fn of names.filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
    const path = join(dir, fn)
    // 回炉 M1（对齐 lib/index.js listFilesRecursive 的 M2 安全裁决：symlink
    // members never enter the trust face）：lstat（永不 stat）——符号链接（文
    // 件或目录、含悬空）一律跳过并 stderr 告警，其指向的内容永不被解析。全局
    // 层为用户自有；项目层 <cwd>/.dsh/experts 可随仓库 clone 引入他人提交的链
    // 接，「用户自写=可信」不覆盖「clone 进来的链接」，故与来源包同一裁决。
    let st = null
    try {
      st = lstatSync(path)
    } catch (err) {
      warn(`专家定义文件不可读，已跳过：${path}——${err?.message ?? err}`)
      continue
    }
    if (st.isSymbolicLink()) {
      warn(`专家定义文件是符号链接，已跳过（symlink 永不进信任面）：${path}`)
      continue
    }
    // 回炉 m7（对齐 lib/index.js listFilesRecursive 先例：regular files only）：
    // 非 .md 普通文件（FIFO/socket/设备/目录等）一律跳过并告警——FIFO 若无此
    // 过滤会在下方 readFileSync 挂起（git 不携带 FIFO，仅本地自伤面，仍按同
    // 先例收紧；.md 命名的目录亦不再落入 EISDIR「不可读」歧义文案）。
    if (!st.isFile()) {
      warn(`专家定义路径不是普通文件，已跳过：${path}`)
      continue
    }
    let raw = null
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (err) {
      warn(`专家定义文件不可读，已跳过：${path}——${err?.message ?? err}`)
      continue
    }
    const p = parseExpertFile(raw)
    if (!p.ok) {
      warn(`专家定义文件解析失败，已跳过：${path}——${p.error}`)
      continue
    }
    const key = normName(p.expert.name)
    if (seen.has(key)) {
      warn(`文件层同层重名专家，后者已跳过：${path}（name=${p.expert.name} 与 ${seen.get(key)} 重复）`)
      continue
    }
    seen.set(key, path)
    entries.push({
      source: FILE_LAYER_SOURCE_ID,
      layer,
      file: fn,
      name: p.expert.name,
      title: p.expert.title,
      method: p.expert.method,
      path,
    })
  }
  return entries
}

/** 双层级加载（执行期重读入口，S3）：每次调用现场扫描。all = 项目层在前、全
 *  局层在后——resolveFileExpert 首命中即实现「项目层 > 全局层」覆盖。 */
export function loadFileExperts({ homeDir, projectDir } = {}, warn = defaultWarn) {
  const globalEntries = scanExpertDir(homeDir, 'global', warn)
  const projectEntries = scanExpertDir(projectDir, 'project', warn)
  return { global: globalEntries, project: projectEntries, all: [...projectEntries, ...globalEntries] }
}

/** 文件层解析：① name 归一精确命中（all 已按 项目>全局 排序，首命中即覆盖
 *  语义）；② title 归一唯一命中（多命中 → ambiguous 附清单，宁拒勿猜）；
 *  ③ 未命中 → missing（调用方回落既有花名册解析链）。
 *  回炉裁决（编排者 q1：宁严勿宽，对齐 Q4=4A「同名」字面范围）：summon 解析链
 *  分段咨询本函数——mode='name' 只查 name（花名册同名覆盖的唯一通道）；mode=
 *  'title' 只查 title（仅花名册 name/惯用名/title 全部未命中后的文件层内部
 *  兜底解析）；缺省 name→title 完整链保留给文件层内部语义与既有调用方。 */
export function resolveFileExpert(entries, query, { mode } = {}) {
  const q = normName(query)
  if (!q) return { ok: false, reason: 'missing' }
  if (mode !== 'title') {
    const byName = entries.filter((e) => normName(e.name) === q)
    if (byName.length > 0) return { ok: true, expert: byName[0] }
    if (mode === 'name') return { ok: false, reason: 'missing' }
  }
  const byTitle = entries.filter((e) => normName(e.title) === q)
  if (byTitle.length === 1) return { ok: true, expert: byTitle[0] }
  if (byTitle.length > 1) return { ok: false, reason: 'ambiguous', candidates: byTitle }
  return { ok: false, reason: 'missing' }
}

/** 文件层 persona 全文读取（S3 执行期重读的读取半程）：scanExpertDir vet 过的
 *  path 现场再读一次。回炉 M1 读取侧防御纵深：先 lstat——扫描→读取间隙被换
 *  成符号链接的内容同样拒绝进信任面（显式失败，不静默换人）；文件被删/不可读
 *  → 显式报错（错误文案与既有 readPersona 契约逐字一致）。 */
export function readFileLayerPersona(path) {
  let st = null
  try {
    st = lstatSync(path)
  } catch { /* 已删除/不可及 → 落入下方统一「不可读」显式报错 */ }
  if (st && st.isSymbolicLink()) {
    throw new Error(`专家定义文件是符号链接，拒绝读取（symlink 永不进信任面）：${path}`)
  }
  let raw = null
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    throw new Error(`专家定义文件不可读：${path}——${err?.message ?? err}`)
  }
  return raw
}
