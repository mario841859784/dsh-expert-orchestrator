#!/usr/bin/env node
// scripts/scan-persona-vars.mjs — 发布门禁⑦ CLI 入口。
// 用法: node scripts/scan-persona-vars.mjs [file1 file2 ...]
// 缺省扫描仓库根的 agent.cordis.yml 与 cordis.patch.yml（源头+生成物都扫，
// 两者与生成器的一致性由 gen-preset-declaration 既有校验/T14 承担），并全扫
// expert persona / gesture md 目录（dsh-expert-292 T1-③：目录全扫而非清单式，
// 新增 md 自动纳入；目录缺失判 fail，语义由 listMarkdownTargets 定义并固化）。
// 退出码: 0=通过, 1=存在违规（含文件/目录缺失/无 persona 块，不静默跳过）。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { scanPersonaTemplateVars, listMarkdownTargets } from '../lib/persona-vars-gate.js'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..')
const MD_TARGET_DIRS = [
  join(repoRoot, 'skills', 'expert-orchestration', 'experts'),
  join(repoRoot, 'skills', 'expert-gestures'),
]
const explicit = process.argv.slice(2)
let targets
let dirViolations = []
if (explicit.length > 0) {
  targets = explicit
} else {
  const md = listMarkdownTargets(MD_TARGET_DIRS)
  dirViolations = md.violations
  targets = [join(repoRoot, 'agent.cordis.yml'), join(repoRoot, 'cordis.patch.yml'), ...md.files]
}

const { ok: fileOk, violations } = scanPersonaTemplateVars(targets)
const ok = fileOk && dirViolations.length === 0
const allViolations = [...dirViolations, ...violations]
for (const v of allViolations) console.error(`${v.file}: ${v.message}`)
console.log(ok
  ? `persona-vars gate⑦ PASS (${targets.length} file${targets.length > 1 ? 's' : ''}, vars ⊆ {provider, model})`
  : `persona-vars gate⑦ FAIL (${allViolations.length} violation${allViolations.length > 1 ? 's' : ''})`)
process.exit(ok ? 0 : 1)
