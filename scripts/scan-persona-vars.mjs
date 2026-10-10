#!/usr/bin/env node
// scripts/scan-persona-vars.mjs — 发布门禁⑦ CLI 入口。
// 用法: node scripts/scan-persona-vars.mjs [file1 file2 ...]
// 缺省扫描仓库根的 agent.cordis.yml 与 cordis.patch.yml（源头+生成物都扫，
// 两者与生成器的一致性由 gen-preset-declaration 既有校验/T14 承担）。
// 退出码: 0=通过, 1=存在违规（含文件缺失/无 persona 块，不静默跳过）。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { scanPersonaTemplateVars } from '../lib/persona-vars-gate.js'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..')
const targets = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [join(repoRoot, 'agent.cordis.yml'), join(repoRoot, 'cordis.patch.yml')]

const { ok, violations } = scanPersonaTemplateVars(targets)
for (const v of violations) console.error(`${v.file}: ${v.message}`)
console.log(ok
  ? `persona-vars gate⑦ PASS (${targets.length} file${targets.length > 1 ? 's' : ''}, vars ⊆ {provider, model})`
  : `persona-vars gate⑦ FAIL (${violations.length} violation${violations.length > 1 ? 's' : ''})`)
process.exit(ok ? 0 : 1)
