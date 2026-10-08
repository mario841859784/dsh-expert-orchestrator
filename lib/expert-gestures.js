// /expert- 零 token 用户手势生成逻辑（v2.7 WP-6b / T14）
//
// 设计裁决（留档，任务书 S1/S2）：
// - 手势技能 = 宿主技能形态的专家注册：每个 bundled-core 专家生成一个
//   `expert-<name>.md`（flat 形态，置于 skills/expert-gestures/，作为声明行里
//   skill-filesystem customSkillDirs 的第二个挂载根）。frontmatter
//   `disable-model-invocation: true` → 宿主注册为 modelInvocable:false：
//   不进模型技能目录（目录消息 filter(isModelInvocable)）、模型经 skill 工具
//   调用被宿主拒绝；只有用户消息里的 `/expert-<name>` 手势 token 触发宿主
//   pre-step 钩子确定性注入（渲染整份技能内容为合成 user 消息）——注入环节
//   零模型调用、零模型自主决策。两代宿主（0.1.7-alpha.2 与 0.2.x）上述机制
//   逐维一致（T14 两代验证记录见 docs/internal/verification/）。
// - 手势内容不含 persona 副本：注入文本是确定性加载指令，persona 按 T13 三层
//   链现场解析（项目 > 全局 > 内置，仅 name 精确匹配）——文件层同名覆盖对手势
//   同样生效，与 summon_expert 语义同源；三层全部未命中则显式失败（fail-closed，
//   禁止凭记忆模拟专家）。
// - 仅注册稳定花名册（内置 11 位）：文件层专家（.dsh/experts/*.md）随建随变，
//   不进声明、不注册手势——声明随 preset 生成、不做动态热更（避免过度设计）。
// - 生成可复现 + 零回归：cordis.patch.yml 由本模块从 agent.cordis.yml 组合行
//   生成；花名册为空时逐字节复现手势化之前的声明面（gen 脚本空输入幂等），
//   花名册非空时仅在既有 skills 挂载行后追加一行 expert-gestures 挂载行并在
//   头注追加手势说明块——除此之外逐字节不动。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseExpertFile } from './expert-files.js'

/** 手势技能目录（相对 preset 部署根）。父目录 skills/ 同时是既有挂载根——
 *  本目录无 SKILL.md，父根扫描按缺文件静默跳过（两代宿主同语义），不会被误
 *  认成一个技能；它只经声明行里专属挂载根的子扫描生效。 */
export const GESTURE_SKILL_DIR = 'skills/expert-gestures'

/** 与两代宿主 @deepseek-ai/dsh-skill 的 SKILL_NAME 逐字一致
 *  （/^[a-z0-9]+(?:-[a-z0-9]+)*$/，0.1.7-alpha.2 与 0.2.x 实测同值）。
 *  不满足即声明行注册不出合法技能——构建期硬失败，不静默。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 手势技能名：expert-<专家名>。/expert- 前缀使命名空间与既有技能
 *  （expert-orchestration / trim-cli / 用户自建）结构性隔离；同名的进一步
 *  冲突由宿主两态裁决（同层 rank 升序：项目 .dsh/skills=100 < 项目
 *  .agents/skills=200 < preset customSkillDirs=300 < 全局 ~/.dsh/skills=400 <
 *  ~/.agents/skills=500；跨层就近层整体胜出；败者告警忽略）——用户项目层
 *  自建同名技能 > 本 preset 手势 > 用户全局层同名技能，确定性、告警可见。 */
export function gestureSkillName(expertName) {
  if (typeof expertName !== 'string' || !SKILL_NAME_RE.test(expertName)) {
    throw new Error(`专家名不满足宿主技能名规则（${SKILL_NAME_RE}），无法注册手势：${JSON.stringify(expertName)}`)
  }
  const skill = `expert-${expertName}`
  if (!SKILL_NAME_RE.test(skill)) {
    throw new Error(`手势技能名不满足宿主技能名规则：${skill}`)
  }
  return skill
}

const normName = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

const defaultWarn = (msg) => console.warn(`[dsh-expert-orchestrator] ${msg}`)

/** 花名册读取（构建期严格语义，区别于运行时文件层的「坏文件告警跳过」）：
 *  目录缺失/不可读 → 抛错；单文件解析失败 / 同名 / 技能名非法 → 抛错。
 *  返回 [{ file, name, title, skill }]（文件名排序，确定性）。 */
export function readRoster(dir, warn = defaultWarn) {
  if (typeof dir !== 'string' || !dir) throw new Error('花名册目录为空')
  let names
  try {
    names = readdirSync(dir)
  } catch (err) {
    throw new Error(`花名册目录不可读：${dir}——${err?.message ?? err}`)
  }
  const experts = []
  const seen = new Map()
  for (const fn of names.filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
    const path = join(dir, fn)
    let raw
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (err) {
      throw new Error(`花名册文件不可读：${path}——${err?.message ?? err}`)
    }
    const p = parseExpertFile(raw)
    if (!p.ok) throw new Error(`花名册文件解析失败（构建期严格，不静默跳过）：${path}——${p.error}`)
    const key = normName(p.expert.name)
    if (seen.has(key)) throw new Error(`花名册同名专家：${path} 与 ${seen.get(key)}（name=${p.expert.name}）`)
    seen.set(key, path)
    experts.push({
      file: fn,
      name: p.expert.name,
      title: p.expert.title,
      skill: gestureSkillName(p.expert.name),
    })
  }
  if (experts.length === 0) warn(`花名册为空（空输入幂等模式）：${dir}`)
  return experts
}

/** 声明行里的 expert-gestures 挂载行（agent.cordis.yml 行空间，6 空格缩进 +
 *  '- '）。由既有 skills 挂载行机械派生（同一 !!js 公式，末尾**追加**
 *  'expert-gestures' 段、保留 'skills' 段——挂载根必须是 <dst>/skills/expert-gestures，
 *  与部署器 refreshEntry 的落盘位置一致；T14 回炉 B1：替换掉 'skills' 段会让
 *  声明挂载一个永不存在的 <dst>/expert-gestures，部署后手势注册 0 个且静默），
 *  公式不二次手写。 */
export function deriveGestureDeclarationLine(skillsLine) {
  const anchor = ", 'skills')"
  if (typeof skillsLine !== 'string' || !skillsLine.includes(anchor)) {
    throw new Error(`未找到可锚定的 skills 挂载行（期望包含 ${JSON.stringify(anchor)}）`)
  }
  const line = skillsLine.replace(anchor, ", 'skills', 'expert-gestures')")
  if (line === skillsLine || !line.includes("', 'skills', 'expert-gestures')")) {
    throw new Error('expert-gestures 挂载行派生失败（须保留 skills 段并追加 expert-gestures 段）')
  }
  return line
}

/** 产物声明解析（T14 回炉，评审 B1-配套①/M1）：从 cordis.patch.yml **产物文本**
 *  提取 skill-filesystem 行 customSkillDirs 下的 !!js 挂载公式，并以给定
 *  DSH_HOME 求值根解析出实际挂载目录——验证面「解析产物」而非「断言生成器
 *  源码行为」。表达式仅取自本仓库自己的产物文件，求值面与宿主一致（env 注入
 *  DSH_HOME，node:path 以真实 node:path.join 提供；node:os 分支在 DSH_HOME
 *  非空时不会求值，出现即抛错）。返回 { expressions, dirs }（与声明行同序）。 */
export function parseGestureMount(patchText, dshHome) {
  if (typeof patchText !== 'string' || !patchText.trim()) throw new Error('产物声明文本为空')
  if (typeof dshHome !== 'string' || !dshHome) throw new Error('解析产物挂载根需要非空 DSH_HOME 求值根')
  const lines = patchText.split('\n')
  const fsRow = lines.findIndex((l) => /^\s*- id: skill-filesystem\s*$/.test(l))
  if (fsRow < 0) throw new Error('产物声明中未找到 skill-filesystem 行')
  const dirsKey = lines.findIndex((l, i) => i > fsRow && /^\s*customSkillDirs:\s*$/.test(l))
  if (dirsKey < 0) throw new Error('skill-filesystem 行下未找到 customSkillDirs')
  const expressions = []
  for (let i = dirsKey + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+!!js\s+"(.+)"\s*$/)
    if (m) { expressions.push(m[1]); continue }
    if (lines[i].trim() === '' || /^\s*#/.test(lines[i])) continue
    break
  }
  if (expressions.length === 0) throw new Error('customSkillDirs 下未找到 !!js 挂载公式')
  const proc = {
    env: { __proto__: null, DSH_HOME: dshHome },
    getBuiltinModule: (id) => {
      if (id === 'node:path') return { join }
      throw new Error(`解析产物声明不允许 getBuiltinModule(${JSON.stringify(id)})`)
    },
  }
  const dirs = expressions.map((e) => new Function('process', `"use strict"; return (${e})`)(proc))
  return { expressions, dirs }
}

/** 手势技能文件内容（确定性模板；每专家一份）。frontmatter 仅
 *  name/description/disable-model-invocation 三键——两代宿主均拒绝 legacy
 *  invocation 键（modelInvocable/userInvocable/disableModelInvocation → 整文件
 *  忽略），故绝不书写；user-invocable 缺省即 true，无需显式。 */
export function renderGestureSkill({ name, title, skill }) {
  const s = skill ?? gestureSkillName(name)
  const t = (typeof title === 'string' && title.trim()) ? title.trim() : name
  return `---
name: ${s}
description: ${t}（${name}）——用户手势 /${s} 的确定性 persona 注入。宿主 pre-step 直接展开本技能（零模型调用，不经模型决策），persona 按项目层→全局层→内置链现场解析；本技能不进模型技能目录，模型不可自主调用。
disable-model-invocation: true
---

# /${s} → ${t}（bundled-core：${name}）

本技能由用户手势确定性触发（宿主 pre-step 注入，未消耗任何模型调用）。立即按下列顺序解析你的 persona 全文——确定性加载链，与 summon_expert 的文件层语义同源（项目 > 全局 > 内置，仅按 name 精确匹配；命中即停）：

1. 项目层：读取 \`<当前工作目录>/.dsh/experts/${name}.md\`（存在 → 跳到第 4 步）。
2. 全局层：读取 \`<DSH_HOME 环境变量 || ~/.dsh>/experts/${name}.md\`（存在 → 跳到第 4 步）。
3. 内置兜底：读取相对本技能目录的 \`../expert-orchestration/experts/${name}.md\`（宿主注入的 Base directory 即 \`…/.agent-presets/expert-orchestrator/skills/expert-gestures\`；同一文件的公式路径 \`<DSH_HOME || ~/.dsh>/.agent-presets/expert-orchestrator/skills/expert-orchestration/experts/${name}.md\`）。
4. 以读得文件的 frontmatter 之后全文为你的 persona（角色、工作方式、交付要求）；frontmatter 的 \`method\` 键指向方法论深读区时按 persona 内指引按需读取。
5. 三层全部未命中：明确回复「/${s} persona 加载失败（项目/全局/内置三层均未命中）」并停止——禁止凭记忆模拟专家。

加载成功后即以该 persona 执行用户当前消息中的任务；当前消息不含任务时，回复「${t}已就位，请下达任务」。

说明：/expert- 手势仅覆盖稳定花名册（内置 11 位，随 preset 声明由 scripts/gen-preset-declaration.mjs 生成）；文件层专家（.dsh/experts/*.md）随建随变、不注册手势，但文件层同名专家在第 1/2 步前置覆盖内置 persona——覆盖语义与 summon_expert 逐字一致（项目>全局，仅 name 精确匹配，title 不参与）。
`
}

/** 手势说明头注块（花名册非空时追加在 cordis.patch.yml 头注末尾、`- insert:`
 *  之前）。空花名册模式不含本块——空输入幂等的两个差异面之一。 */
export const GESTURE_HEADER_APPENDIX = `# - \`/expert-<name>\` zero-token user gestures (v2.7 WP-6b / T14): the
#   skill-filesystem row below ALSO mounts \`skills/expert-gestures/\` — one
#   generated skill per bundled-core expert, frontmatter
#   \`disable-model-invocation: true\` (modelInvocable:false). The host pre-step
#   hook injects such skills ONLY for the \`/expert-<name>\` user gesture
#   (SKILL_GESTURE scan → deterministic synthetic user message, zero model
#   invocations) and never lists them in the model skill catalog; the persona
#   resolves through the file layer (project > global) before the bundled
#   expert file — the same chain as summon_expert. The gesture declaration
#   line is generated from the bundled-core roster by
#   scripts/gen-preset-declaration.mjs; an empty roster reproduces this patch
#   WITHOUT the gesture line (and without this note), byte for byte.
`

/** cordis.patch.yml 组合（纯函数，可测试）：
 *  ① 从 agent.cordis.yml 提取首个 `- id:` 起的组合行（注释行剔除；内部空行
 *     逐字节保留，它们承载块标量语义；split 产生的末尾空元素照原 2.5.0 脚本
 *     语义保留——它与输出末尾的 '+ \n' 合成 HEAD 基线的尾随空行）；
 *  ② 花名册非空 → 在既有 skills 挂载行后追加 expert-gestures 挂载行（恰一行，
 *     锚定失败/多锚定均抛错）；
 *  ③ 整体缩进 8 空格落到声明行 plugins 下，拼回头注（花名册非空时附手势说明块）。
 *  空花名册输出 = 手势化之前的声明面逐字节（零回归保证，实测 = git HEAD）。 */
export function buildDeclarationPatch(agentText, roster) {
  const experts = Array.isArray(roster) ? roster : []
  const lines = agentText.split('\n')
  const firstRow = lines.findIndex((l) => /^- id:/.test(l))
  if (firstRow < 0) throw new Error('no row found in agent.cordis.yml')
  const body = lines.slice(firstRow)
    .map((l) => (/^\s*#/.test(l) ? null : l))

  const out = []
  let anchored = 0
  for (const line of body) {
    if (line === null) { out.push(null); continue }
    out.push(line)
    if (experts.length > 0 && line.includes("', 'skills')")) {
      out.push(deriveGestureDeclarationLine(line))
      anchored++
    }
  }
  if (experts.length > 0 && anchored !== 1) {
    throw new Error(`expected exactly 1 skill-dir anchor line for the gesture mount, matched ${anchored}`)
  }

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
${experts.length > 0 ? GESTURE_HEADER_APPENDIX : ''}- insert:
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

  return header + indented.join('\n') + '\n'
}
