// One-shot generator: build the new cordis.patch.yml by inlining the preset
// composition (agent.cordis.yml) as a `preset-expert-orchestrator` declaration
// row, re-indented mechanically, with the skill-filesystem customSkillDirs
// expression replaced by an absolute-path formula that mirrors the deployer's
// own resolvePresetTargetDir().
import { readFileSync, writeFileSync } from 'node:fs'

const agent = readFileSync('agent.cordis.yml', 'utf8')

// Drop the header comment block: keep from the first row line onward.
const lines = agent.split('\n')
const firstRow = lines.findIndex((l) => /^- id:/.test(l))
if (firstRow < 0) throw new Error('no row found in agent.cordis.yml')
const body = lines.slice(firstRow)
  // Strip trailing comment-only lines / trailing blanks at EOF.
  .map((l) => (/^\s*#/.test(l) ? null : l))

// Replace the skill-filesystem customSkillDirs expression (baseUrl no longer
// points at the preset directory under declaration-row mounts).
const out = []
let replaced = 0
for (const line of body) {
  if (line === null) { out.push(null); continue }
  if (line.includes("new URL('skills/', baseUrl)")) {
    out.push("      - !!js \"process.getBuiltinModule('node:path').join(process.env.DSH_HOME || process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), '.dsh'), '.agent-presets', 'expert-orchestrator', 'skills')\"")
    replaced++
    continue
  }
  out.push(line)
}
if (replaced !== 1) throw new Error(`expected exactly 1 skill-dir expression, replaced ${replaced}`)

// Re-indent by 8 spaces (top-level rows move under insert > row > config.plugins).
// Comment lines become '\0COMMENT' markers dropped at the end; genuine blank
// lines MUST survive as empty lines — they carry meaning inside block scalars
// (the persona prefix and plan-mode section both contain paragraph breaks).
const indented = out
  .map((l) => {
    if (l === null) return '\0COMMENT'
    if (l.trim() === '') return ''
    return '        ' + l
  })
  .filter((l) => l !== '\0COMMENT')

const description = [
  'PM 先行规划 + 合并花名册优先委派的编排 Agent：每条消息先归类分诊（实施请求或上下文变化才重开全流程），',
  '实施一律委派专家；任务板管理依赖与状态，消息总线并行落盘，交付门禁分级（小型实施免独立评审与 PM 检查点、',
  'commit 前检查不可豁免），按需沉淀经验池。',
].join('')

const header = `# dsh-expert-orchestrator plugin registration
# This patch is the plugin's ONLY activation surface, and it carries TWO kinds
# of rows:
#
# 1. Host-plane rows (the deployer and the expert-source Typert remote).
# 2. The \`preset-expert-orchestrator\` declaration row (\`@deepseek-ai/dsh-agent-preset\`):
#    since DSH 0.1.7-alpha, agent presets are declaration rows carried by bundle
#    patches — the legacy \`~/.dsh/.agent-presets/<id>/\` directory is no longer
#    read by anything. The full composition therefore lives INLINE below, kept
#    in the \`plugins\` config of that row; \`agent.cordis.yml\` remains deployed
#    only as a pointer document for the runtime data directory.
#
# Composition notes (moved here from the old agent.cordis.yml header):
# - This is an AGENT-PLANE composition. The registry mounts it ONCE under a
#   standing scope; every session naming it joins by scope parentage, so the
#   tools and prompt sections registered here cover each joined agent while a
#   session's own state stays keyed per Session/Agent inside the plugins.
# - A service row here MUST sit inside a group carrying an \`isolate\` realm.
#   Without one it publishes into the root realm, where it is process-global —
#   another preset publishing the same name collides, and a host reader would
#   resolve one preset's instance for every session; \`dsh-agent-presets\`
#   rejects that at mount. \`true\` means an entry-local realm: this standing
#   mount's own private instance, apart from every other preset's. (A shared
#   label does NOT pool instances — \`provide()\` throws on the second
#   registration under the same realm symbol; labels join REALMS, and are not
#   what this composition needs.)
# - \`skill-filesystem\`'s \`customSkillDirs\` resolves the deployed runtime data
#   directory (\`DSH_HOME || ~/.dsh\` + \`.agent-presets/expert-orchestrator/skills\`)
#   with the exact formula the deployer (\`resolvePresetTargetDir\`) uses, so the
#   bundled expert-orchestration skill resolves wherever the plugin deployed.
#   \`baseUrl\` is NOT usable here: under declaration-row mounts it points at the
#   preset registry's own resolution base, not at this preset.
- insert:
  - id: dsh-expert-orchestrator
    name: dsh-expert-orchestrator
  # Typert Remote root service for expert source management: exposes the
  # \`expertSources\` namespace (getSources/addSource/removeSource/
  # setSourceEnabled/downloadSource/updateSource/setMirrorPrefixes, all
  # returning a SourcesSnapshot with an expectedRevision optimistic lock)
  # so the api-gateway discovers the route and the settings page (T3,
  # lib/client.js EXPERT_SOURCES_DESCRIPTORS) can read/write source state.
  # \`./lib/remote.js\` is anchored to a file URL beside this patch by the
  # host's anchorInsertedPluginNames — required because the package \`exports\`
  # map (added for the ./client entry) blocks bare deep-path specifiers like
  # \`dsh-expert-orchestrator/lib/remote.js\`.
  - id: expert-sources-remote
    name: ./lib/remote.js
  # ── agent preset declaration (DSH >= 0.1.7-alpha) ─────────────────────────
  # The Loader row id follows the \`preset-<id>\` convention and addresses
  # Loader edits; \`config.id\` is the preset identity sessions save. Kept LAST
  # in this insert list so the deployer row above has laid down the runtime
  # data directory (skills/, experts/, lessons) before the registry eagerly
  # mounts the composition on a fresh install.
  - id: preset-expert-orchestrator
    name: '@deepseek-ai/dsh-agent-preset'
    config:
      id: expert-orchestrator
      order: 10
      name: 专家编排模式
      description: >-
        ${description}
      plugins:
`

writeFileSync('cordis.patch.yml', header + indented.join('\n') + '\n')
console.log('written, lines:', (header + indented.join('\n')).split('\n').length, 'skill-fix:', replaced)
