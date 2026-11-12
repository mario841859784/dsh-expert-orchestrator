// 方向 5 协议对接（dev/orchestration-economics-345）：合并花名册 → A2A AgentCard 生成器。
//
// 依据 docs/research/protocol-interop-mcp-a2a/00-protocol-interop.md（A2A AgentCard 规范：
// name/description/url/version/protocolVersion/capabilities/skills[AgentSkill]；发现路径
// /.well-known/agent-card.json）。定位：**card-first**——把「本编排者 + 专家花名册」描述成
// A2A 可发现的节点卡（每位专家=一个 AgentSkill），供外部代理生态注册表/发现面消费；
// A2A 最小 HTTP transport 已随插件交付（tools/a2a_taskboard.py，M1：message/send 同步 +
// tasks/get 轮询，exposure-crypto-trust 报告 §5.4 形状），本卡描述该能力面。
//
// 用法：node scripts/gen-agent-card.mjs [--out <path>] [--url <https://host>] [--skill-dir <dir>]
// - 花名册源：deployed merged roster（<skill-dir>/expert-sources/merged/roster.json，真实
//   schema=core[] + sources[].files[]，与 lib/tools.js rosterCandidates 同口径）优先，
//   bundled experts/ frontmatter 兜底（与 MCP list_experts 同一兜底口径）；
//   --skill-dir 可指向其他部署副本（自测/对账用），缺省=本仓技能目录；
// - version 取 package.json（单一事实源，不硬编码——发版三点 bump 后卡自动跟随）；
// - url 缺省为空串占位（卡只描述能力；url 非空=「此端点可用此传输」的可核查承诺，
//   部署 a2a_taskboard.py 后以 --url 宣称实际端点——如实边界，v0.3.0 §5.6）；
// - securitySchemes/security 按暴露面调研 N1 落地（exposure-crypto-trust 报告 §5.1）：
//   卡在「有端点」之前就如实声明接入需要什么（bearer、凭证带外分发、卡面不承载明文密钥）。
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}
const outPath = argOf('--out')
const url = (argOf('--url') ?? '').trim()
const skillDirArg = argOf('--skill-dir')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = skillDirArg ? resolve(skillDirArg) : join(ROOT, 'skills', 'expert-orchestration')
const ROSTER = join(SKILL_DIR, 'expert-sources', 'merged', 'roster.json')
const EXPERTS_DIR = join(SKILL_DIR, 'experts')

/** card version：package.json 单一事实源（读取失败 → 'unknown' 如实占位，不猜）。 */
const PLUGIN_VERSION = (() => {
  try {
    const v = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))?.version
    return typeof v === 'string' && v.trim() ? v.trim() : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** bundled experts frontmatter 兜底（name:/title: 行扫描，与 mcp_taskboard.py 同口径）。 */
function bundledExperts() {
  const out = []
  if (!existsSync(EXPERTS_DIR)) return out
  for (const fn of readdirSync(EXPERTS_DIR).sort()) {
    if (!fn.endsWith('.md')) continue
    let name = ''
    let title = ''
    let inFm = false
    const lines = readFileSync(join(EXPERTS_DIR, fn), 'utf-8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (i === 0 && line.trim() === '---') { inFm = true; continue }
      if (inFm && line.trim() === '---') break
      if (inFm && !name && line.startsWith('name:')) name = line.slice(5).trim()
      else if (inFm && !title && line.startsWith('title:')) title = line.slice(6).trim()
    }
    out.push({ source: 'bundled-core', file: fn, name: name || title || fn.replace(/\.md$/, ''), title, disabled: false, shadowed: false })
  }
  return out
}

/** merged roster 解析（真实 schema 与 lib/tools.js rosterCandidates 逐字段同口径）：
 *  { core: [{source?,file,name?,title?,shadowed?,disabled?}...],
 *    sources: [{id, files: [{source?,file,...}...]}...] }——core 缺 source 补
 *  bundled-core、files 缺 source 补所属来源 id。返回 null=文件缺失/损坏/形状非法
 *  （回落 bundled 兜底）。 */
function deployedRoster() {
  if (!existsSync(ROSTER)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(ROSTER, 'utf-8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const out = []
  for (const e of Array.isArray(raw.core) ? raw.core : []) {
    if (!e || typeof e.file !== 'string') continue
    out.push({ source: e.source ?? 'bundled-core', file: e.file, name: e.name ?? null, title: e.title ?? null, disabled: !!e.disabled, shadowed: !!e.shadowed })
  }
  for (const s of Array.isArray(raw.sources) ? raw.sources : []) {
    if (!s || typeof s !== 'object') continue
    for (const e of Array.isArray(s.files) ? s.files : []) {
      if (!e || typeof e.file !== 'string') continue
      out.push({ source: e.source ?? s.id ?? 'unknown', file: e.file, name: e.name ?? null, title: e.title ?? null, disabled: !!e.disabled, shadowed: !!e.shadowed })
    }
  }
  return out
}

function loadExperts() {
  const deployed = deployedRoster()
  if (deployed !== null) return { experts: deployed, deployed: true }
  return { experts: bundledExperts(), deployed: false }
}

const outPathResolved = outPath // 命名区分：--out 与 --skill-dir 已在顶部解析
const { experts, deployed } = loadExperts()
const skills = experts
  .filter((e) => e && typeof e === 'object' && !e.disabled && !e.shadowed)
  .map((e, i) => ({
    id: `expert-${String(e.name ?? e.title ?? e.file ?? i).replace(/\s+/g, '-')}`,
    name: String(e.name ?? e.title ?? e.file ?? `expert-${i}`),
    description: `领域专家（来源 ${e.source ?? 'unknown'}）：以该专家 persona 承接任务板子任务并交付——经任务板 claim/done 协作，身份为板面自报（防误用不防伪造）。`,
    tags: ['expert', String(e.source ?? 'unknown')],
  }))

const card = {
  name: 'dsh-expert-orchestrator',
  description: '专家编排节点：分诊 → PM 规划 → 专家委派 → 依赖 DAG 任务板 → 分级交付门禁。任务板与专家花名册经 MCP（tools/mcp_taskboard.py，缺省只读）导出；A2A JSON-RPC 最小面由 tools/a2a_taskboard.py 提供（message/send 同步 + tasks/get 轮询，写面 opt-in）。本卡为 A2A 发现面（card-first）。',
  url,
  version: PLUGIN_VERSION,
  protocolVersion: '0.3.0',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  // N1（exposure-crypto-trust §5.1）：卡面安全声明先于卡面端点——bearer + 带外分发，如实
  // 声明「接入需要什么」；凭证获取在 A2A 协议范围之外（v0.3.0 §5.6 带外口径），卡面不承载
  // 明文密钥（「NOT RECOMMENDED to include plaintext secrets」）。
  securitySchemes: {
    bearer: {
      type: 'http',
      scheme: 'bearer',
      description: 'A2A JSON-RPC 端点要求 bearer token；凭证经带外通道分发（服务端启动输出 / env 注入），不在卡面承载。',
    },
  },
  security: [{ bearer: [] }],
  skills,
  'dsh:rosterSource': deployed ? 'deployed-merged' : 'bundled-core-fallback',
  // 写面如实声明：message/send 落任务板属写面（外部写入=代理转达的板面变更），服务端
  // DSH_TASKBOARD_A2A_WRITES=1 opt-in 才暴露；tasks/get 只读缺省开放（与 MCP 导出面同纪律）。
  'dsh:writeFace': 'message/send 为写面（服务端 DSH_TASKBOARD_A2A_WRITES=1 opt-in，缺省只读）；tasks/get 只读。',
}

const json = JSON.stringify(card, null, 2)
if (outPathResolved) {
  writeFileSync(outPathResolved, json + '\n')
  console.error(`AgentCard 写入 ${outPathResolved}（${skills.length} skills，version=${PLUGIN_VERSION}，花名册源=${deployed ? 'deployed-merged' : 'bundled-core-fallback'}）`)
} else {
  process.stdout.write(json + '\n')
}
