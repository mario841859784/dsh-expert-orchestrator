// 方向 5 协议对接（dev/orchestration-economics-345）：合并花名册 → A2A AgentCard 生成器。
//
// 依据 docs/research/protocol-interop-mcp-a2a/00-protocol-interop.md（A2A AgentCard 规范：
// name/description/url/version/protocolVersion/capabilities/skills[AgentSkill]；发现路径
// /.well-known/agent-card.json）。定位：**card-first，transport 后置**——把「本编排者 +
// 专家花名册」描述成 A2A 可发现的节点卡（每位专家=一个 AgentSkill），供外部代理生态
// 注册表/发现面消费；实际 A2A HTTP transport（message/send 等）留后续（如实声明）。
//
// 用法：node scripts/gen-agent-card.mjs [--out <path>] [--url <https://host>] [--skill-dir <dir>]
// - 花名册源：deployed merged roster（expert-sources/merged/roster.json）优先，
//   bundled experts/ frontmatter 兜底（与 MCP list_experts 同一兜底口径）；
// - url 缺省为空串占位（卡只描述能力，不宣称已有 A2A transport 端点——如实边界）。
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(ROOT, 'skills', 'expert-orchestration')
const ROSTER = join(SKILL_DIR, 'expert-sources', 'merged', 'roster.json')
const EXPERTS_DIR = join(SKILL_DIR, 'experts')

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

function loadExperts() {
  if (existsSync(ROSTER)) {
    try {
      const raw = JSON.parse(readFileSync(ROSTER, 'utf-8'))
      const experts = Array.isArray(raw?.experts) ? raw.experts : (Array.isArray(raw) ? raw : [])
      if (experts.length > 0) return { experts, deployed: true }
    } catch { /* 损坏 → 兜底 */ }
  }
  return { experts: bundledExperts(), deployed: false }
}

const args = process.argv.slice(2)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}
const outPath = argOf('--out')
const url = (argOf('--url') ?? '').trim()

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
  description: '专家编排节点：分诊 → PM 规划 → 专家委派 → 依赖 DAG 任务板 → 分级交付门禁。任务板与专家花名册经 MCP（tools/mcp_taskboard.py，缺省只读）导出；本卡为 A2A 发现面（card-first，A2A HTTP transport 未部署）。',
  url,
  version: '2.13.10',
  protocolVersion: '0.3.0',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills,
  'dsh:rosterSource': deployed ? 'deployed-merged' : 'bundled-core-fallback',
}

const json = JSON.stringify(card, null, 2)
if (outPath) {
  writeFileSync(outPath, json + '\n')
  console.error(`AgentCard 写入 ${outPath}（${skills.length} skills，花名册源=${deployed ? 'deployed-merged' : 'bundled-core-fallback'}）`)
} else {
  process.stdout.write(json + '\n')
}
