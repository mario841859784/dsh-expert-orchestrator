#!/usr/bin/env node
// Revived one-shot generator (v2.7 WP-6b / T14): rebuild cordis.patch.yml from
// the composition rows kept in agent.cordis.yml, and generate the /expert-
// zero-token gesture skills from the bundled-core roster.
//
// The original 2.5.0 script went stale when agent.cordis.yml became a pointer
// document (no `- id:` rows left to read → 'no row found'). The rows now live
// at the bottom of that same file as the generator's source; the composition
// logic itself is in lib/expert-gestures.js (buildDeclarationPatch) so the
// selftest can verify reproducibility and the empty-roster zero-regression
// guarantee without spawning this CLI.
//
// Usage:
//   node scripts/gen-preset-declaration.mjs [--roster <dir>] [--empty-roster]
//                                           [--check] [--quiet]
//
//   --roster <dir>   roster of expert persona files (default:
//                    skills/expert-orchestration/experts — the bundled core).
//                    Parsed strictly: a bad file / duplicate name / invalid
//                    skill name fails the build loudly (build-time strictness,
//                    unlike the runtime file layer's warn-and-skip).
//   --empty-roster   zero-regression mode: compose the declaration with an
//                    empty roster — byte-identical to the pre-gesture patch,
//                    and skills/expert-gestures/ is expected empty (write mode
//                    prunes stray generated files; check mode verifies absence).
//   --check          verify instead of write: exit 1 listing every drift
//                    (declaration bytes, gesture file set and contents).
//   --quiet          suppress the summary line.
//
// Zero third-party dependencies: node:stdlib + lib/expert-files.js only.
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildDeclarationPatch, deriveGestureDeclarationLine, GESTURE_SKILL_DIR, readRoster, renderGestureSkill } from '../lib/expert-gestures.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
if (flag('--help') || flag('-h')) {
  console.log('see the header comment of scripts/gen-preset-declaration.mjs')
  process.exit(0)
}
const check = flag('--check')
const quiet = flag('--quiet')
const emptyRoster = flag('--empty-roster')
if (emptyRoster && value('--roster') !== undefined) {
  console.error('--empty-roster and --roster are mutually exclusive')
  process.exit(2)
}

const cwd = process.cwd()
const agentPath = resolve(cwd, 'agent.cordis.yml')
const patchPath = resolve(cwd, 'cordis.patch.yml')
const gesturesDir = resolve(cwd, GESTURE_SKILL_DIR)
const rosterDir = emptyRoster ? null : resolve(cwd, value('--roster') ?? join('skills', 'expert-orchestration', 'experts'))

// ── roster → gesture files ───────────────────────────────────────────────────
// Empty roster (or --empty-roster): expected file set is EMPTY. Otherwise one
// deterministic file per roster expert: skills/expert-gestures/<skill>.md.
let roster = []
if (rosterDir !== null) roster = readRoster(rosterDir)
const expectedFiles = new Map(roster.map((e) => [join(gesturesDir, `${e.skill}.md`), renderGestureSkill(e)]))

// Stray generated files (generated-name .md not in the current roster) are the
// generator's own artifacts — pruned in write mode, reported in check mode.
// Anything else in the directory is NOT ours and is left untouched.
const GENERATED_NAME = /^expert-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const strays = []
if (existsSync(gesturesDir)) {
  for (const fn of readdirSync(gesturesDir).sort()) {
    if (!GENERATED_NAME.test(fn)) continue
    const p = join(gesturesDir, fn)
    if (!expectedFiles.has(p)) strays.push(p)
  }
}

// ── declaration ──────────────────────────────────────────────────────────────
let agentText
try {
  agentText = readFileSync(agentPath, 'utf8')
} catch (err) {
  console.error(`agent.cordis.yml unreadable: ${agentPath} — ${err?.message ?? err}`)
  process.exit(2)
}
let patch
try {
  patch = buildDeclarationPatch(agentText, roster)
} catch (err) {
  console.error(`declaration composition failed: ${err?.message ?? err}`)
  process.exit(2)
}

// ── write / check ────────────────────────────────────────────────────────────
const drifts = []
if (check) {
  if (!existsSync(patchPath) || readFileSync(patchPath, 'utf8') !== patch) {
    drifts.push(`declaration drift: ${patchPath} differs from generated output`)
  }
  for (const [p, content] of expectedFiles) {
    if (!existsSync(p)) drifts.push(`gesture skill missing: ${p}`)
    else if (readFileSync(p, 'utf8') !== content) drifts.push(`gesture skill drift: ${p}`)
  }
  for (const p of strays) drifts.push(`stray generated file (empty-roster/roster removal residue): ${p}`)
  if (drifts.length > 0) {
    for (const d of drifts) console.error(`DRIFT: ${d}`)
    console.error(`gen --check failed: ${drifts.length} drift(s); run without --check to regenerate`)
    process.exit(1)
  }
  if (!quiet) console.log(`gen --check OK: declaration + ${expectedFiles.size} gesture skill(s) reproducible${roster.length === 0 ? ' (empty roster: pre-gesture declaration face)' : ''}`)
  process.exit(0)
}

writeFileSync(patchPath, patch)
if (roster.length > 0 || strays.length > 0) {
  // 仅当需要落文件/清理时才建目录——空花名册且无残留时不制造空目录。
  const { mkdirSync } = await import('node:fs')
  if (roster.length > 0) mkdirSync(gesturesDir, { recursive: true })
  for (const [p, content] of expectedFiles) writeFileSync(p, content)
  for (const p of strays) unlinkSync(p)
}
if (!quiet) {
  const gestureNote = roster.length === 0
    ? 'empty roster: declaration face = pre-gesture bytes (zero-regression mode)'
    : `roster ${roster.length} expert(s): gesture mount line appended + ${expectedFiles.size} gesture skill(s) written`
  console.log(`written: ${patchPath} (${patch.split('\n').length} lines) — ${gestureNote}`)
  if (strays.length > 0) console.log(`pruned stray generated file(s): ${strays.length}`)
}
