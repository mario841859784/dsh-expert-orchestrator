/**
 * dsh-expert-orchestrator — DSH agent-preset plugin
 *
 * An AGENT-PRESET plugin: ships the 专家编排模式 (Expert Orchestrator) preset
 * and deploys it into the DSH preset discovery directory on mount.
 *
 * Deploy policy (deliberately different from wipe-and-copy installers):
 *   - protocol files (agent.cordis.yml, preset.yml, SKILL.md, tools/) are
 *     refreshed only when the deployed version marker differs, so editing
 *     them locally survives host restarts and `dsh plugin update` refreshes;
 *   - trim-cli SKILL.md router, entries/ and reference/ refresh with the version marker; bin/ and scripts/ exist only in the deployed copy;
 *   - lessons.md and experts/*.md are RUNTIME USER DATA — copied only when
 *     missing, never overwritten, never deleted;
 *   - nothing in the target directory is ever removed.
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { mkdirSync, copyFileSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')
const PRESET_ID = 'expert-orchestrator'
const VERSION = '1.4.2'
const MARKER = '.deployed-version'

/** Runtime user data: copy only when missing, never overwrite. */
const USER_DATA = [
  'skills/expert-orchestration/lessons.md',
  'skills/expert-orchestration/experts',
]

/** Protocol files: refreshed when the version marker changes. */
const PROTOCOL = [
  'agent.cordis.yml',
  'preset.yml',
  'skills/expert-orchestration/SKILL.md',
  'skills/expert-orchestration/tools/taskboard.py',
  'skills/expert-orchestration/tools/bus.py',
  'skills/trim-cli/SKILL.md',
  'skills/trim-cli/manifest.json',
  'skills/trim-cli/entries',
  'skills/trim-cli/reference',
]

function targetDir(config = {}) {
  if (config.targetDir) return config.targetDir
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, '.agent-presets', PRESET_ID)
}

function copyIfMissing(src, dst, log) {
  if (existsSync(dst)) return false
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  log.push(`+ ${dst}`)
  return true
}

function deployDir(srcDir, dstDir, log) {
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name)
    const d = join(dstDir, name)
    if (statSync(s).isDirectory()) {
      deployDir(s, d, log)
    } else {
      copyIfMissing(s, d, log)
    }
  }
}

/** Refresh copy: recursive overwrite — unlike deployDir's copyIfMissing it does not skip existing files; never removes extra target-side files. */
function refreshDir(srcDir, dstDir, log) {
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name)
    const d = join(dstDir, name)
    if (statSync(s).isDirectory()) {
      refreshDir(s, d, log)
    } else {
      mkdirSync(dirname(d), { recursive: true })
      copyFileSync(s, d)
      log.push(`~ ${d}`)
    }
  }
}

export default {
  name: PRESET_ID,
  inject: [],
  apply(ctx, config = {}) {
    const dst = targetDir(config)
    mkdirSync(dst, { recursive: true })
    const log = []

    const markerPath = join(dst, MARKER)
    const deployed = existsSync(markerPath) ? readFileSync(markerPath, 'utf-8').trim() : ''
    if (deployed !== VERSION) {
      for (const rel of PROTOCOL) {
        const s = join(PKG_ROOT, rel)
        const d = join(dst, rel)
        if (statSync(s).isDirectory()) {
          refreshDir(s, d, log)
        } else {
          mkdirSync(dirname(d), { recursive: true })
          copyFileSync(s, d)
          log.push(`~ ${d}`)
        }
      }
      writeFileSync(markerPath, VERSION)
    }

    for (const rel of USER_DATA) {
      const s = join(PKG_ROOT, rel)
      const d = join(dst, rel)
      if (statSync(s).isDirectory()) deployDir(s, d, log)
      else copyIfMissing(s, d, log)
    }

    console.log(`[dsh-expert-orchestrator] preset ready at ${dst} (v${VERSION})`)
    if (log.length) console.log('[dsh-expert-orchestrator] ' + log.join('\n[dsh-expert-orchestrator] '))
  },
}
