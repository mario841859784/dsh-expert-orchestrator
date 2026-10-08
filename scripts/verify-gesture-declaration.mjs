#!/usr/bin/env node
// T14 (WP-6b, rework) S3 verification instrument: exercise the /expert- zero-token
// gesture declaration against a REAL host generation's skill stack.
//
// Loads @deepseek-ai/dsh-skill-filesystem + @deepseek-ai/dsh-skill from a host
// node_modules tree (no cordis runtime needed — FileSystemSkillProvider is the
// same class the host registers; the registry-level name-collision precedence
// is verified statically and recorded in docs/internal/verification/) and
// checks, against this repo's shipped gesture layer:
//
//   0. PARSE THE SHIPPED PRODUCT first: the two !!js customSkillDirs formulas
//      of the skill-filesystem row are extracted from cordis.patch.yml and
//      evaluated with DSH_HOME = private scratch root (lib/expert-gestures.js
//      parseGestureMount — the same formula the host evaluates at mount time).
//      Every check below mounts THESE parsed dirs, never verifier-assumed
//      paths, and the deployed tree under them is simulated exactly as the
//      deployer lays it out (lib/index.js refreshEntry copies the package's
//      skills/ tree to <dst>/skills/) — review B1-①/M1: a check that mounts
//      hardcoded repo paths cannot see a wrong declaration.
//   1. Declaration shape (parsed): root#1 = <DSH_HOME>/.agent-presets/
//      expert-orchestrator/skills; root#2 = root#1/expert-gestures — the
//      'skills' segment is PRESENT (review B1: the pre-rework product mounted
//      <dst>/expert-gestures, a directory the deployer never creates).
//   2. Gesture dir (parsed root#2) mounts as a customSkillDir: 11 candidates
//      named expert-<bundled-core>, every one invocation.modelInvocable ===
//      false (frontmatter `disable-model-invocation: true`) and
//      userInvocable === true.
//   3. The model catalog filter (isModelInvocable) excludes every gesture
//      skill — zero catalog token overhead; isSkillName accepts every gesture name.
//   4. provider.get + renderSkillContent (the exact host gesture-injection
//      renderer) emits `<skill_content name="expert-…">` with a directory
//      resourceBase pointing at the parsed gesture root — the injected message
//      the pre-step hook produces for the /expert-<name> user token.
//   5. Parsed deployed shape [root#1, root#2] loads 13 unique skills: the two
//      pre-existing skills stay modelInvocable, the 11 gestures stay
//      modelInvocable:false.
//   6. Parent-root inertness: [root#1] alone yields exactly the 2 pre-existing
//      skills — skills/expert-gestures has no SKILL.md, so the parent scan
//      silently skips it (the flat-subdir placement stays invisible to the
//      pre-gesture declaration face).
//
// Usage:
//   node scripts/verify-gesture-declaration.mjs [nodeModulesDir]
//     nodeModulesDir defaults to $DSH_HOST_MODULES, then the reference host
//     checkout (/vol2/@appcenter/Harness/server/node_modules). Run it once per
//     host generation; see docs/internal/verification/ for the recorded runs
//     (0.2.1-alpha.1 reference tree + 0.1.7-alpha.2 npm-pinned tree).
//
// Exit codes: 0 all checks passed · 1 verification failed · 2 host modules not
// available at the given tree (skip — never a test failure; npm test does not
// invoke this script).
import { join, resolve, dirname } from 'node:path'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseGestureMount } from '../lib/expert-gestures.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const mods = resolve(process.argv[2] || process.env.DSH_HOST_MODULES || '/vol2/@appcenter/Harness/server/node_modules')
// private empty scratch root: never point dshHome/agentsHome/bundledSkillDir at
// a shared tmpdir root — the provider would scan other processes' files there
const scratch = mkdtempSync(join(tmpdir(), 't14-verify-'))

const load = async (spec) => {
  try {
    return await import(pathToFileURL(join(mods, spec)).href)
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      console.error(`SKIP: host modules not available under ${mods} (${spec})`)
      process.exit(2)
    }
    throw err
  }
}

const { FileSystemSkillProvider } = await load('@deepseek-ai/dsh-skill-filesystem/lib/index.js')
const { isModelInvocable, isSkillName, renderSkillContent } = await load('@deepseek-ai/dsh-skill/lib/index.js')

// 0. parse the shipped product declaration (NOT verifier-assumed paths)
const patchPath = join(REPO, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  console.error(`FAIL: shipped declaration not found: ${patchPath}`)
  process.exit(1)
}
const { dirs } = parseGestureMount(readFileSync(patchPath, 'utf8'), scratch)
const [skillsRoot, gesturesRoot] = dirs

// simulate the deployer layout (lib/index.js refreshEntry: package skills/ tree
// → <dst>/skills/) so the parsed roots point at a tree the host can scan
cpSync(join(REPO, 'skills'), skillsRoot, { recursive: true })

const tmp = scratch
const failures = []
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures.push(label)
}

const makeProvider = (dirs) => new FileSystemSkillProvider(
  // minimal cordis-shaped ctx: get('fs') → undefined pins the provider onto
  // the node:fs fallback path; no logger output needed for a verification run
  { get: () => undefined, logger: { warn: () => {}, info: () => {}, error: () => {} } },
  { signal: new AbortController().signal, invalidate: () => {} },
  {
    includeDefaultRoots: false,
    watch: false,
    customSkillDirs: dirs,
    dshHome: tmp,
    agentsHome: tmp,
    bundledSkillDir: tmp,
    providerName: 't14-verify',
  },
)
const listNames = async (dirs) => (await makeProvider(dirs).list({ cwd: tmp })).map((c) => c)

console.log(`host modules: ${mods}`)
console.log(`declaration (parsed from ${'cordis.patch.yml'}): customSkillDirs = [${dirs.join(', ')}]`)

console.log('① parsed declaration shape: root#2 keeps the skills segment (review B1 lock)')
{
  ok('root#1 = <DSH_HOME>/.agent-presets/expert-orchestrator/skills', skillsRoot === join(scratch, '.agent-presets', 'expert-orchestrator', 'skills'), skillsRoot)
  ok('root#2 = root#1/expert-gestures (= <dst>/skills/expert-gestures, the deployer layout)', gesturesRoot === join(skillsRoot, 'expert-gestures') && gesturesRoot === join(scratch, '.agent-presets', 'expert-orchestrator', 'skills', 'expert-gestures'), gesturesRoot)
}

console.log('② gesture dir (parsed root#2) mounts with modelInvocable:false ×11 + userInvocable:true')
{
  const candidates = await listNames([gesturesRoot])
  const names = candidates.map((c) => c.name).sort()
  ok('exactly 11 candidates, all expert-*', candidates.length === 11 && names.every((n) => /^expert-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)), names.join(', '))
  ok('all modelInvocable:false (userInvocable:true)', candidates.every((c) => c.invocation?.modelInvocable === false && c.invocation?.userInvocable === true))
  ok('catalog filter (isModelInvocable) excludes all → zero catalog token overhead', candidates.every((c) => !isModelInvocable(c)))
  ok('every gesture name satisfies host isSkillName', candidates.every((c) => isSkillName(c.name)))
}

console.log('③ gesture injection render (provider.get + renderSkillContent, the pre-step path)')
{
  const provider = makeProvider([gesturesRoot])
  const candidates = await provider.list({ cwd: tmp })
  const target = candidates.find((c) => c.name === 'expert-backend-engineer')
  const skill = await provider.get(target, { signal: AbortSignal.timeout(5000) })
  ok('full skill loads with content', typeof skill?.content === 'string' && skill.content.includes('# /expert-backend-engineer'))
  const rendered = renderSkillContent(skill)
  ok('rendered injection opens <skill_content name="expert-backend-engineer">', rendered.startsWith('<skill_content name="expert-backend-engineer">'))
  ok('resourceBase is the parsed gesture directory (relative chain paths resolvable)', skill.resourceBase?.kind === 'directory' && skill.resourceBase.path === gesturesRoot)
  ok('injected body carries the T13 chain (project > global > bundled) + fail-closed', rendered.includes('.dsh/experts/backend-engineer.md') && rendered.includes('persona 加载失败'))
}

console.log('④ deployed declaration shape mounted AS PARSED: [root#1, root#2] → 13 skills')
{
  const candidates = await listNames(dirs)
  const names = candidates.map((c) => c.name)
  ok('13 unique skills load (2 existing + 11 gestures)', candidates.length === 13 && new Set(names).size === 13, `got ${candidates.length}: ${new Set(names).size} unique`)
  ok('existing skills stay modelInvocable', candidates.filter((c) => !c.name.startsWith('expert-')).every((c) => isModelInvocable(c) === true))
  ok('gestures stay modelInvocable:false in the combined mount', candidates.filter((c) => c.name.startsWith('expert-') && c.name !== 'expert-orchestration').every((c) => c.invocation?.modelInvocable === false))
}

console.log('⑤ parent-root inertness: parsed root#1 alone still yields exactly the 2 pre-existing skills')
{
  const candidates = await listNames([skillsRoot])
  const names = candidates.map((c) => c.name).sort()
  ok('only expert-orchestration + trim-cli', names.length === 2 && names[0] === 'expert-orchestration' && names[1] === 'trim-cli', names.join(', '))
}

console.log(failures.length === 0
  ? `\nPASS: gesture declaration (parsed from the shipped product) verified against ${mods}`
  : `\nFAIL (${failures.length}): ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
