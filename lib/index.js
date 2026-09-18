/**
 * dsh-expert-orchestrator — DSH agent-preset plugin
 *
 * An AGENT-PRESET plugin: ships the 专家编排模式 (Expert Orchestrator) preset
 * and deploys it into the DSH preset discovery directory on mount.
 *
 * Deploy policy (deliberately different from wipe-and-copy installers):
 *   - protocol files (agent.cordis.yml, preset.yml, SKILL.md, tools/,
 *     source-registry.json) are refreshed only when the deployed version
 *     marker differs, so editing them locally survives host restarts and
 *     `dsh plugin update` refreshes;
 *   - trim-cli SKILL.md router, entries/ and reference/ refresh with the
 *     version marker; bin/ and scripts/ exist only in the deployed copy;
 *   - lessons.md is RUNTIME USER DATA — copied only when missing, never
 *     overwritten, never deleted;
 *   - skills/expert-orchestration/experts/ now ships the 11 bundled-core
 *     experts ONLY and refreshes with the version marker (T2 source
 *     management): non-core experts live under expert-sources/<source-id>/
 *     and are migrated out of experts/ on first apply after upgrade;
 *   - nothing in the target directory is ever removed (the merged view under
 *     expert-sources/merged/ is the single derived subtree that gets rebuilt).
 *
 * Source management runtime (T2):
 *   - registry: skills/expert-orchestration/source-registry.json (shipped);
 *   - installed state: expert-sources/sources.json
 *     ({version, sources:[{id, enabled, kind, version, sha256, upstream, lastSync, fileCount}]});
 *   - install: download (GitHub direct → configurable mirror prefixes →
 *     release pack fallback) → sha256 verify (mismatch = reject) → raw unpack
 *     (zero rename, zero content edit) → security scan (credentials +
 *     instruction-injection patterns; scan-policy revision per user ruling:
 *     registry sources hit by the scan require an ackScan confirmation before
 *     they register — findings are persisted for UI review; custom/local
 *     sources keep the hard reject) → symlink members are always skipped and
 *     recorded (skippedSymlinks), never followed → register + per-source
 *     manifest;
 *   - enable/disable per source; merged stable roster view under
 *     expert-sources/merged/ (bundled-core always present + enabled sources
 *     organised as <source-id>/<upstream-relative-path>, cross-source name
 *     collisions coexist and are annotated in merged/roster.json);
 *   - migration: legacy experts/ copies that are not bundled-core are moved
 *     to expert-sources/legacy-adapted/ (frozen local source, enabled by
 *     default) — idempotent, nothing is lost.
 */

import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, copyFileSync, readdirSync, existsSync, readFileSync, writeFileSync,
  statSync, lstatSync, rmSync, renameSync,
} from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')
const PRESET_ID = 'expert-orchestrator'
const VERSION = '2.0.0'
/** Deploy marker revision: derived from VERSION (security review M6 — a stale
 *  literal left existing 1.5.0+sources1 deployments without the 2.0.0 PROTOCOL
 *  refresh); the `+sources1` suffix marks the source-management runtime so the
 *  one-off refresh also lands source-registry.json into existing deployments. */
const DEPLOY_REV = `${VERSION}+sources1`
const MARKER = '.deployed-version'

const REGISTRY_REL = 'skills/expert-orchestration/source-registry.json'
const EXPERTS_REL = 'skills/expert-orchestration/experts'
const LESSONS_REL = 'skills/expert-orchestration/lessons.md'
const SOURCES_DIRNAME = 'expert-sources'
const MERGED_DIRNAME = 'merged'
const SOURCES_JSON = 'sources.json'
const LEGACY_SOURCE_ID = 'legacy-adapted'
const CORE_SOURCE_ID = 'bundled-core'

/** Bundled core experts: the only files shipped in experts/ (no 来源 annotation). */
export const CORE_EXPERTS = [
  'backend-engineer.md',
  'code-reviewer.md',
  'data-analyst.md',
  'devops-engineer.md',
  'frontend-engineer.md',
  'generalist.md',
  'product-designer.md',
  'project-manager.md',
  'qa-test-engineer.md',
  'security-auditor.md',
  'tech-writer.md',
]

/** Runtime user data: copy only when missing, never overwrite. */
const USER_DATA = [
  LESSONS_REL,
]

/** Protocol files: refreshed when the version marker changes. */
const PROTOCOL = [
  'agent.cordis.yml',
  'preset.yml',
  REGISTRY_REL,
  'skills/expert-orchestration/SKILL.md',
  'skills/expert-orchestration/routing.md',
  EXPERTS_REL,
  'skills/expert-orchestration/tools/taskboard.py',
  'skills/expert-orchestration/tools/bus.py',
  'skills/trim-cli/SKILL.md',
  'skills/trim-cli/manifest.json',
  'skills/trim-cli/entries',
  'skills/trim-cli/reference',
]

// ── security scan patterns (上架核查同源标准) ────────────────────────────────

export const SCAN_PATTERNS = [
  { kind: 'credential', name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'credential', name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'credential', name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b/ },
  { kind: 'credential', name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'credential', name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'credential', name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'credential', name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'credential', name: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  { kind: 'credential', name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'credential', name: 'generic-secret-assignment', re: /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][A-Za-z0-9+/_.-]{16,}["']/i },
  { kind: 'injection', name: 'ignore-prior-instructions', re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i },
  { kind: 'injection', name: 'disregard-rules', re: /disregard\s+(?:all\s+)?(?:previous|prior|your|the)\s+(?:instructions|rules|guidelines)/i },
  { kind: 'injection', name: 'reveal-system-prompt', re: /(?:reveal|print|output|repeat)\s+(?:your\s+)?(?:full\s+)?system\s+prompt/i },
  { kind: 'injection', name: 'pipe-to-shell', re: /\b(?:curl|wget)\s+\S+\s*\|\s*(?:ba)?sh\b/ },
  { kind: 'injection', name: 'exfiltrate-credentials', re: /\bexfiltrat\w*\b[^.\n]{0,60}\b(?:credentials?|api[_ -]?keys?|tokens?|secrets?|private[_ -]?keys?)\b/i },
  { kind: 'injection', name: 'solicit-secrets', re: /\bsend\s+(?:me\s+)?(?:the\s+)?(?:api[_ ]?keys?|credentials|tokens?|secrets?)\b/i },
  { kind: 'injection', name: 'base64-decode-exec', re: /\bbase64\s+(?:--)?decode[^|]*\|\s*(?:ba)?sh\b/ },
]

/** Scan file contents for credential leaks / instruction-injection patterns.
 *  Returns [{file, name, kind, line}]; empty array = clean. */
export function scanSecurity(files) {
  const findings = []
  for (const file of files) {
    const content = typeof file.content === 'string'
      ? file.content
      : readFileSync(file.path, 'utf-8')
    const lines = content.split('\n')
    for (const p of SCAN_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (p.re.test(lines[i])) findings.push({ file: file.rel || file.path, name: p.name, kind: p.kind, line: i + 1 })
      }
    }
  }
  return findings
}

/** Persistence caps: scan findings / skipped symlinks kept per entry (the full
 *  detail would bloat sources.json; caps are far above any real source). */
export const MAX_SCAN_FINDINGS = 100
export const MAX_SKIPPED_SYMLINKS = 100

/** Scan-hit confirmation gate (user ruling, host side): a REGISTRY source
 *  (source-registry.json, pinned sha256) whose content trips the security
 *  scan is no longer rejected outright. First attempt WITHOUT `ackScan`
 *  aborts the install (nothing lands, revision untouched) and surfaces this
 *  error, which remoteDownloadSourceLocked turns into a `confirmRequired`
 *  marker carrying the findings; the caller retries with `ackScan: true` to
 *  register the source with the findings persisted for UI review.
 *  CUSTOM/local-path sources keep the hard reject (scan hit = reject). */
export class ScanConfirmationRequired extends Error {
  constructor(sourceId, findings) {
    const head = findings.slice(0, 3).map(f => `${f.file}:${f.line} [${f.kind}] ${f.name}`).join('; ')
    super(`security scan flagged ${sourceId} (${findings.length} finding(s)) — registration requires confirmation (retry with ackScan:true): ${head}`)
    this.name = 'ScanConfirmationRequired'
    this.code = 'SCAN_CONFIRM_REQUIRED'
    this.scanFindings = findings
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function sha256File(path) {
  return sha256OfBuffer(readFileSync(path))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, path)
}

/** Convert a glob (`**`, `*`, `?`) into a RegExp. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ } else { re += '[^/]*' }
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchInclude(relPath, include = [], exclude = []) {
  const inc = include.some(g => globToRegExp(g).test(relPath))
  if (!inc) return false
  return !exclude.some(g => globToRegExp(g).test(relPath))
}

/** Same resolution the remote service must use (security review M4 — lib/remote.js
 *  previously defaulted to `~/.agent-presets` and landed state in another tree). */
export function resolvePresetTargetDir(config = {}) {
  if (config.targetDir) return config.targetDir
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, '.agent-presets', PRESET_ID)
}

function targetDir(config = {}) {
  return resolvePresetTargetDir(config)
}

function sourcesDirOf(dst) { return join(dst, SOURCES_DIRNAME) }
function mergedDirOf(dst) { return join(sourcesDirOf(dst), MERGED_DIRNAME) }
function sourcesJsonPath(dst) { return join(sourcesDirOf(dst), SOURCES_JSON) }

// ── source-id safety (security review M1) ───────────────────────────────────
//
// A source id becomes a path segment under expert-sources/ (and merged/), so
// it must never be '.', '..' or anything that could climb out of that dir.

/** Whitelist for source ids (also enforced against stored ids on load). */
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/

/** Reject ids outside the whitelist; '.'/'..' are called out explicitly. */
export function assertValidSourceId(id, what = 'source id') {
  const s = String(id)
  if (s === '.' || s === '..' || !SOURCE_ID_RE.test(s)) {
    throw new Error(
      `invalid ${what}: ${JSON.stringify(s).slice(0, 80)} — must match /^[a-z0-9][a-z0-9._-]{0,127}$/ and must not be "." or ".."`)
  }
  return s
}

/** Path-traversal seatbelt: resolve(expert-sources/<id>) must stay strictly
 *  inside resolve(expert-sources/). Defense in depth — the id whitelist above
 *  already excludes traversal segments, this asserts it before every rm/copy. */
function assertSourceDirInside(dst, id, what = 'source dir') {
  const base = resolve(sourcesDirOf(dst))
  const target = resolve(join(base, id))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`${what} escapes expert-sources/ — refused (id: ${JSON.stringify(id).slice(0, 80)})`)
  }
  return target
}

// ── installed-state (sources.json) ──────────────────────────────────────────

export function loadSourcesState(dst) {
  const p = sourcesJsonPath(dst)
  if (!existsSync(p)) {
    return { version: 1, revision: 0, mirrorPrefixes: null, sources: [], mergedStateHash: '' }
  }
  try {
    const state = readJson(p)
    if (!Array.isArray(state.sources)) throw new Error('sources must be an array')
    // Security review M1: a stored id becomes a path segment under
    // expert-sources/ — refuse to load a state file carrying ids outside the
    // whitelist (report them instead of silently using them as paths).
    const illegal = state.sources
      .filter(s => !s || typeof s !== 'object' || s.id === '.' || s.id === '..' || !SOURCE_ID_RE.test(String(s.id)))
      .map(s => String(s && s.id))
    if (illegal.length) {
      throw new Error(
        `illegal source id(s) in state (refusing to load): ${illegal.map(i => JSON.stringify(i)).join(', ')} — ` +
        'ids must match /^[a-z0-9][a-z0-9._-]{0,127}$/; fix expert-sources/sources.json manually or reinstall the affected sources')
    }
    // T3 remote contract fields (tolerate pre-T3 state files):
    //   revision       — optimistic-lock counter bumped on every successful mutation
    //   mirrorPrefixes — user-configured mirror chain; null/[] = defaults
    if (!Number.isInteger(state.revision) || state.revision < 0) state.revision = 0
    if (state.mirrorPrefixes !== null && !Array.isArray(state.mirrorPrefixes)) state.mirrorPrefixes = null
    return state
  } catch (err) {
    throw new Error(`expert-sources/${SOURCES_JSON} is corrupt: ${err.message}`)
  }
}

export function saveSourcesState(dst, state) {
  writeJsonAtomic(sourcesJsonPath(dst), state)
}

function upsertSource(state, entry) {
  const i = state.sources.findIndex(s => s.id === entry.id)
  if (i >= 0) state.sources[i] = { ...state.sources[i], ...entry }
  else state.sources.push(entry)
}

// ── registry ────────────────────────────────────────────────────────────────

export function loadRegistry(dst) {
  const candidates = [join(dst, REGISTRY_REL), join(PKG_ROOT, REGISTRY_REL)]
  for (const p of candidates) {
    if (existsSync(p)) return readJson(p)
  }
  throw new Error(`source registry not found (looked at: ${candidates.join(', ')})`)
}

// ── download channels: direct → mirrors (prefix configurable) → pack ────────

const FETCH_TIMEOUT_MS = 30_000

/** Fetch a URL as Buffer; retries once on transient TLS/network resets. */
export async function fetchBuffer(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|terminated|aborted|fetch failed|network/i.test(String(err?.cause?.code || err?.message || err))
      if (attempt === 2 || !transient) throw new Error(`download failed: ${url}: ${err.message}`)
    }
  }
}

/** Resolve the ordered channel URL list for one registry source.
 *  opts.channel: 'github' = direct first (legacy default); 'cdn' = mirror
 *  prefixes first, direct fallback. opts.mirrorPrefixes overrides env/registry. */
export function resolveChannels(source, registry, env = process.env, opts = {}) {
  const urls = []
  const fill = (tpl) => tpl
    .replaceAll('{repo}', source.upstream.repo)
    .replaceAll('{ref}', source.upstream.ref)
  const prefixes = opts.mirrorPrefixes
    ?? (env.DSH_GH_MIRROR_PREFIXES
      ? env.DSH_GH_MIRROR_PREFIXES.split(',').map(s => s.trim()).filter(Boolean)
      : registry.defaults.mirrorPrefixes)
  const mirrorFirst = opts.channel === 'cdn'
  const pushDirect = () => urls.push({ channel: 'direct', url: fill(registry.defaults.directTemplate) })
  const pushMirrors = () => {
    for (const prefix of prefixes) {
      urls.push({ channel: `mirror:${prefix}`, url: fill(registry.defaults.mirrorTemplate).replaceAll('{prefix}', prefix.endsWith('/') ? prefix : `${prefix}/`) })
    }
  }
  if (mirrorFirst) { pushMirrors(); pushDirect() } else { pushDirect(); pushMirrors() }
  const pack = registry.pack
  if (pack?.url && pack.sha256 && pack.sha256 !== 'PENDING_BUILD') {
    urls.push({ channel: 'pack', url: pack.url, pack: true })
  }
  return urls
}

/** Extract a .tar.gz buffer into destDir using the system tar. */
export function untar(buffer, destDir) {
  mkdirSync(destDir, { recursive: true })
  const tmp = join(destDir, `.pack-${process.pid}.tgz`)
  writeFileSync(tmp, buffer)
  try {
    const res = spawnSync('tar', ['-xzf', tmp, '-C', destDir], { encoding: 'utf-8' })
    if (res.status !== 0) throw new Error(`tar exited ${res.status}: ${(res.stderr || '').trim()}`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Walk a directory collecting regular files only. Security review M2: lstat
 *  (never stat) — symbolic links (file or directory) are skipped, never
 *  followed, never dereferenced into the install/scan/merged pipeline. */
function listFilesRecursive(dir, prefix = '') {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    let st
    try { st = lstatSync(full) } catch { continue }
    if (st.isSymbolicLink()) continue // M2: symlink members never enter the trust face
    if (st.isDirectory()) out.push(...listFilesRecursive(full, rel))
    else if (st.isFile()) out.push({ rel, path: full })
  }
  return out
}

/** Security policy revision (user ruling, host side): symlink members are
 *  SKIPPED, not rejected. Walk the tree (staging copy for archives, the real
 *  directory for local sources), record every symbolic link (file or
 *  directory) rel path into `out`, and NEVER follow it — listFilesRecursive
 *  skips them so they never enter the install/scan/merged pipeline. The list
 *  is persisted on the sources.json entry (skippedSymlinks) for UI display. */
function collectSkippedSymlinks(dir, top = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = full.slice(top.length + 1)
    let st
    try { st = lstatSync(full) } catch { continue }
    if (st.isSymbolicLink()) { out.push(rel); continue } // skip + record, never follow
    if (st.isDirectory()) collectSkippedSymlinks(full, top, out)
  }
  return out
}

// ── install ─────────────────────────────────────────────────────────────────

/**
 * Install one registry source into <dst>/expert-sources/<id>/ (raw unpack:
 * zero rename, zero content edit; provenance lives in a sidecar manifest so
 * upstream files stay byte-identical).
 * Scan-hit policy (user ruling): registry sources hit by the security scan
 * abort with ScanConfirmationRequired unless opts.ackScan === true; an acked
 * install registers with the findings persisted (scanFindings + scanAckAt).
 * Symlink members are always skipped and recorded (skippedSymlinks).
 * @returns the registered sources.json entry.
 */
export async function installSource(dst, sourceId, opts = {}) {
  assertValidSourceId(sourceId, 'registry source id')
  const registry = opts.registry || loadRegistry(dst)
  const entry = registry.sources.find(s => s.id === sourceId)
  if (!entry) throw new Error(`unknown source id: ${sourceId}`)
  const log = opts.log || []

  // 1) download through the ordered channel list
  const channels = resolveChannels(entry, registry, opts.env, { channel: opts.channel, mirrorPrefixes: opts.mirrorPrefixes })
  let buffer = null
  let usedChannel = null
  const errors = []
  for (const ch of channels) {
    try {
      log.push(`channel ${ch.channel}: ${ch.url}`)
      buffer = await fetchBuffer(ch.url)
      usedChannel = ch
      break
    } catch (err) {
      errors.push(`${ch.channel}: ${err.message}`)
    }
  }
  if (!buffer) throw new Error(`all channels failed for ${sourceId}:\n  ${errors.join('\n  ')}`)

  // 2) verify: archive-channel → pinned archive sha256; pack-channel → pack sha256
  const staging = assertSourceDirInside(dst, `.staging-${sourceId}-${process.pid}`, 'staging dir')
  rmSync(staging, { recursive: true, force: true })
  try {
    let perFileManifest = null
    if (usedChannel.pack) {
      if (sha256OfBuffer(buffer) !== registry.pack.sha256) {
        throw new Error(`sha256 mismatch for pack (expected ${registry.pack.sha256}) — rejected`)
      }
      untar(buffer, staging)
      const manifestPath = join(staging, 'MANIFEST.json')
      if (!existsSync(manifestPath)) throw new Error('pack is missing MANIFEST.json')
      perFileManifest = readJson(manifestPath)
    } else {
      if (sha256OfBuffer(buffer) !== entry.sha256) {
        throw new Error(`sha256 mismatch for ${sourceId} archive (expected ${entry.sha256}) — rejected`)
      }
      untar(buffer, staging)
    }
    // 3) locate the unpacked repo root, select files by include/exclude
    //    (pack channel: sources live under <sourceId>/ inside the pack)
    let root = staging
    if (usedChannel.pack) {
      const packSourceRoot = join(staging, sourceId)
      if (!existsSync(packSourceRoot)) {
        throw new Error(`pack does not carry a classic subset for ${sourceId}`)
      }
      root = packSourceRoot
    } else {
      const unpacked = readdirSync(staging)
      // M2-edge: lstat (never stat) — a symlink-to-dir top member must not be
      // treated as the unpacked root. Wrapped layout = the ONLY top-level
      // member is a real directory; otherwise stay at staging.
      if (unpacked.length === 1 && lstatSync(join(staging, unpacked[0])).isDirectory()) {
        root = join(staging, unpacked[0])
      }
    }
    // Symlink policy (user ruling): members are skipped + recorded, never
    // followed and never rejected — rel paths are relative to the source root.
    const skippedSymlinks = collectSkippedSymlinks(root).slice(0, MAX_SKIPPED_SYMLINKS)
    const all = listFilesRecursive(root)
    const selected = all
      .filter(f => !f.rel.split('/').includes('..')) // archive path-traversal guard
      .filter(f => matchInclude(f.rel, entry.include, entry.exclude))
    if (!selected.length) throw new Error(`no files matched include patterns for ${sourceId}`)

    // 4) security scan before anything is registered. Registry sources:
    //    hit → confirmation gate (ScanConfirmationRequired) unless acked;
    //    acked hit → register with the findings persisted for UI review.
    const findings = scanSecurity(selected)
    if (findings.length && opts.ackScan !== true) {
      throw new ScanConfirmationRequired(sourceId, findings)
    }
    if (findings.length) log.push(`scan: ${findings.length} finding(s) acknowledged by user (ackScan) — registering with persisted findings`)

    // 5) raw unpack into expert-sources/<id>/ (replace previous install atomically enough)
    const sourceDir = assertSourceDirInside(dst, sourceId) // M1: prefix seatbelt
    rmSync(sourceDir, { recursive: true, force: true })
    mkdirSync(sourceDir, { recursive: true })
    const manifest = {
      id: sourceId,
      kind: 'download',
      version: entry.version,
      license: entry.license,
      upstream: entry.upstream,
      channel: usedChannel.channel,
      installedAt: new Date().toISOString(),
      scanFindings: findings.slice(0, MAX_SCAN_FINDINGS),
      skippedSymlinks,
      files: [],
    }
    for (const f of selected) {
      const dest = join(sourceDir, f.rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(f.path, dest)
      const digest = sha256File(dest)
      const upstreamEntry = perFileManifest
        ? (perFileManifest.sources || []).flatMap(s => s.files || []).find(x => x.path === `${sourceId}/${f.rel}`)
        : null
      if (upstreamEntry && upstreamEntry.sha256 && upstreamEntry.sha256 !== digest) {
        throw new Error(`pack file sha256 mismatch: ${f.rel} — rejected`)
      }
      manifest.files.push({ path: f.rel, sha256: digest, upstreamPath: `${entry.upstream.repo}/${f.rel}@${entry.upstream.ref}` })
    }
    writeJsonAtomic(join(sourceDir, '.source-manifest.json'), manifest)

    // 6) register + rebuild merged view
    const state = loadSourcesState(dst)
    const registered = {
      id: sourceId,
      enabled: opts.enabled ?? true,
      kind: 'download',
      version: usedChannel.pack ? `${entry.version}+classic-pack` : entry.version,
      sha256: usedChannel.pack ? registry.pack.sha256 : entry.sha256,
      upstream: { repo: entry.upstream.repo, url: entry.upstream.url, ref: entry.upstream.ref },
      lastSync: new Date().toISOString(),
      fileCount: manifest.files.length,
      scanFindings: findings.slice(0, MAX_SCAN_FINDINGS),
      skippedSymlinks,
    }
    if (findings.length) registered.scanAckAt = new Date().toISOString() // persisted user confirmation
    upsertSource(state, registered)
    saveSourcesState(dst, state)
    rebuildMergedView(dst, { log })
    log.push(`installed ${sourceId} v${entry.version} via ${usedChannel.channel} (${manifest.files.length} files)`)
    return registered
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Enable/disable one installed source; rebuilds the merged view. */
export function setSourceEnabled(dst, sourceId, enabled) {
  assertValidSourceId(sourceId)
  const state = loadSourcesState(dst)
  const entry = state.sources.find(s => s.id === sourceId)
  if (!entry) throw new Error(`source not installed: ${sourceId}`)
  entry.enabled = !!enabled
  saveSourcesState(dst, state)
  rebuildMergedView(dst)
  return entry
}

// ── T3 remote contract: SourcesSnapshot + 7-method expertSources API ────────
//
// The settings page (lib/client.js, T3) declares the client side of this
// contract; the host side below is the single source of truth for behaviour.
// All mutating methods take `expectedRevision` (optimistic lock against
// sources.json `revision`); all of them (plus getSources) resolve to a
// SourcesSnapshot: { revision, sources[], mirrorPrefixes[], conflicts[] }.
// A failed mutation never bumps the revision, so the client's cached
// snapshot stays valid and the conflict-check loop cannot dead-lock.

const CUSTOM_INCLUDE = ['*.md', '**/*.md'] // globToRegExp: '**/' requires a directory segment
const CUSTOM_EXCLUDE = ['.github/**', 'README*.md', 'node_modules/**']
const MAX_MIRROR_PREFIXES = 16
const GITHUB_REPO_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/
const LOCAL_PATH_RE = /^(~\/|\/|\.\/|\.\.\/)/

/** Mirror chain actually used for downloads: user config → env → registry. */
function effectiveMirrorPrefixes(registry, state, env = process.env) {
  if (Array.isArray(state.mirrorPrefixes) && state.mirrorPrefixes.length) return state.mirrorPrefixes
  if (env.DSH_GH_MIRROR_PREFIXES) {
    return env.DSH_GH_MIRROR_PREFIXES.split(',').map(s => s.trim()).filter(Boolean)
  }
  return registry.defaults.mirrorPrefixes
}

/** Optimistic-lock guard: expectedRevision must equal the stored revision. */
function assertRevision(state, expectedRevision) {
  const current = state.revision ?? 0
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error(`expectedRevision must be a non-negative integer (got ${JSON.stringify(expectedRevision)})`)
  }
  if (expectedRevision !== current) {
    throw new Error(`expert sources state changed since it was read (expectedRevision ${expectedRevision}, current revision ${current}) — reload sources and retry`)
  }
}

function commitSourcesState(dst, state) {
  state.revision = (state.revision ?? 0) + 1
  saveSourcesState(dst, state)
  rebuildMergedView(dst)
}

/** Record a terminal failure status on one entry WITHOUT bumping the
 *  revision (a failed mutation leaves the client's snapshot valid). An entry
 *  that was never installed gets a stub so the settings page can still show
 *  the failure on its row; a later successful install upserts over it. */
function recordSourceFailure(dst, sourceId, message) {
  try {
    const state = loadSourcesState(dst)
    let entry = state.sources.find(s => s.id === sourceId)
    if (!entry) {
      entry = {
        id: sourceId, enabled: false, kind: 'registry', version: null,
        sha256: null, upstream: null, lastSync: null, fileCount: 0,
      }
      state.sources.push(entry)
    }
    entry.status = /sha256 mismatch|verify/i.test(message)
      ? 'verifyFailed'
      : /security scan/i.test(message) ? 'scanRejected' : 'error'
    entry.statusDetail = String(message).slice(0, 512)
    saveSourcesState(dst, state)
  } catch { /* status recording is best-effort; the original error wins */ }
}

/** Persist the scan-hit confirmation gate state on one entry WITHOUT bumping
 *  the revision (mirrors recordSourceFailure). Reuses the existing client-side
 *  `scanRejected` status (client codec validates status against a fixed enum)
 *  with a statusDetail explaining that an ackScan confirmation is pending.
 *  The full findings list is persisted (scanFindings) so the details stay
 *  queryable from sources.json / the snapshot even before confirmation. */
function recordScanConfirmation(dst, sourceId, findings) {
  try {
    const state = loadSourcesState(dst)
    let entry = state.sources.find(s => s.id === sourceId)
    if (!entry) {
      entry = {
        id: sourceId, enabled: false, kind: 'registry', version: null,
        sha256: null, upstream: null, lastSync: null, fileCount: 0,
      }
      state.sources.push(entry)
    }
    const first = findings[0] ? ` (first: ${findings[0].file}:${findings[0].line} [${findings[0].kind}] ${findings[0].name})` : ''
    entry.status = 'scanRejected'
    entry.statusDetail = `security scan: ${findings.length} finding(s) — awaiting ackScan confirmation, nothing registered; retry download with ackScan:true${first}`.slice(0, 512)
    entry.scanFindings = findings.slice(0, MAX_SCAN_FINDINGS)
    saveSourcesState(dst, state)
  } catch { /* best-effort; the marker return below still carries the findings */ }
}

/** Cross-source expert-name collisions among enabled sources (incl. core). */
function computeConflicts(dst, state) {
  const byName = new Map()
  const add = (name, id) => {
    if (!byName.has(name)) byName.set(name, [])
    const ids = byName.get(name)
    if (!ids.includes(id)) ids.push(id)
  }
  for (const name of CORE_EXPERTS) add(name, CORE_SOURCE_ID)
  for (const s of state.sources) {
    if (!s.enabled) continue
    const manifestPath = join(sourcesDirOf(dst), s.id, '.source-manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try { manifest = readJson(manifestPath) } catch { continue }
    for (const f of manifest.files ?? []) add(basename(f.path), s.id)
  }
  return [...byName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([expert, ids]) => ({ expert, sources: ids }))
}

/** Build the SourcesSnapshot consumed by the settings page. */
export function buildSourcesSnapshot(dst) {
  const registry = loadRegistry(dst)
  const state = loadSourcesState(dst)
  const installed = new Map(state.sources.map(s => [s.id, s]))
  const sources = []

  sources.push({
    id: CORE_SOURCE_ID,
    name: 'Bundled Core',
    upstream: '',
    license: 'MIT',
    installedVersion: VERSION,
    enabled: true,
    builtin: true,
    status: 'ok',
    statusDetail: null,
    lastUpdated: null,
  })

  const legacy = installed.get(LEGACY_SOURCE_ID)
  if (legacy) {
    sources.push({
      id: LEGACY_SOURCE_ID,
      name: 'Legacy Adapted',
      upstream: '',
      license: 'MIT',
      installedVersion: legacy.version ?? null,
      enabled: !!legacy.enabled,
      builtin: false, // toggle allowed; removal is refused host-side (frozen data)
      status: legacy.status ?? 'ok',
      statusDetail: legacy.statusDetail ?? null,
      lastUpdated: legacy.lastSync ?? null,
    })
  }

  for (const reg of registry.sources) {
    const inst = installed.get(reg.id)
    sources.push({
      id: reg.id,
      name: reg.title || reg.id,
      upstream: reg.upstream?.url ?? '',
      license: reg.license ?? '',
      installedVersion: inst?.version ?? null,
      enabled: !!inst?.enabled,
      builtin: false,
      status: inst ? (inst.status ?? 'ok') : 'idle',
      statusDetail: inst?.statusDetail ?? null,
      lastUpdated: inst?.lastSync ?? null,
      // Scan-policy revision (user ruling): per-source findings / skipped
      // symlink lists for UI display (null = never installed).
      scanFindings: inst?.scanFindings ?? null,
      skippedSymlinks: inst?.skippedSymlinks ?? null,
    })
  }

  for (const s of state.sources) {
    if (s.kind !== 'custom') continue
    if (registry.sources.some(r => r.id === s.id)) continue
    sources.push({
      id: s.id,
      name: s.name || s.id,
      upstream: s.upstream?.url ?? '',
      license: s.license ?? '',
      installedVersion: s.version ?? null,
      enabled: !!s.enabled,
      builtin: false,
      status: s.status ?? (s.version ? 'ok' : 'idle'),
      statusDetail: s.statusDetail ?? null,
      lastUpdated: s.lastSync ?? null,
      scanFindings: null, // custom sources: scan hit = hard reject, nothing persisted
      skippedSymlinks: s.skippedSymlinks ?? null,
    })
  }

  return {
    revision: state.revision ?? 0,
    sources,
    mirrorPrefixes: [...effectiveMirrorPrefixes(registry, state)],
    conflicts: computeConflicts(dst, state),
  }
}

/** Enable/disable one source (security review M3). Non-registry sources
 *  (kind='custom': user-added GitHub repos and local paths) carry third-party
 *  experts straight into the model context — enabling one the first time
 *  requires an explicit ack: call again with `ackRisks: true` after the user
 *  confirmed in the UI. The refusal does NOT mutate anything and does NOT bump
 *  the revision; the returned snapshot carries a `confirmRequired` marker the
 *  client renders as a confirmation prompt. After a confirmed enable the
 *  decision is persisted (`confirmedAt`) and later toggles need no ack. */
export function remoteSetSourceEnabled(dst, sourceId, enabled, expectedRevision, ackRisks) {
  assertValidSourceId(sourceId)
  const state = loadSourcesState(dst)
  assertRevision(state, expectedRevision)
  if (sourceId === CORE_SOURCE_ID) {
    throw new Error('bundled-core is built-in and cannot be disabled or removed')
  }
  const entry = state.sources.find(s => s.id === sourceId)
  if (!entry) {
    const registry = loadRegistry(dst)
    if (registry.sources.some(s => s.id === sourceId)) {
      throw new Error(`source not installed: ${sourceId} — download it first`)
    }
    throw new Error(`unknown source: ${sourceId}`)
  }
  const enabling = !!enabled
  if (enabling && entry.kind === 'custom' && !entry.confirmedAt && ackRisks !== true) {
    const pending = buildSourcesSnapshot(dst)
    pending.confirmRequired = {
      id: sourceId,
      method: 'setSourceEnabled',
      ackField: 'ackRisks',
      reason: 'non-registry source: enabling it loads third-party experts into the model context — confirm after reviewing the upstream content',
    }
    return pending // refusal marker; state and revision untouched
  }
  if (enabling && entry.kind === 'custom') {
    entry.confirmedAt = new Date().toISOString() // persist the one-time user confirmation
  }
  entry.enabled = !!enabled
  delete entry.status // a user action clears a stale failure marker
  delete entry.statusDetail
  commitSourcesState(dst, state)
  return buildSourcesSnapshot(dst)
}

export function remoteAddSource(dst, input, expectedRevision) {
  const state = loadSourcesState(dst)
  assertRevision(state, expectedRevision)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('addSource: input must be an object {url, name}')
  }
  const url = String(input.url ?? '').trim()
  const name = String(input.name ?? '').trim().slice(0, 80)
  if (!url || url.length > 512) throw new Error('addSource: url is required (max 512 chars)')
  const registry = loadRegistry(dst)
  let repo = null
  const gh = GITHUB_REPO_RE.exec(url)
  if (gh) {
    repo = `${gh[1]}/${gh[2]}`
  } else if (!LOCAL_PATH_RE.test(url)) {
    throw new Error(`addSource: unsupported source url "${url}" — expected a GitHub repository URL or a local path`)
  }
  if (repo && (state.sources.some(s => s.upstream?.repo === repo) || registry.sources.some(s => s.upstream.repo === repo))) {
    throw new Error(`source already available: ${repo}`)
  }
  // M1: derive a whitelist-safe id from the repo name / path basename. The
  // raw derivation could yield '.'/'..' (e.g. url "https://github.com/foo/..")
  // — that used to produce id=".." and let removeSource rm -rf the whole
  // preset target directory. Anything not fitting the whitelist is rejected.
  const baseId = (repo ? repo.split('/')[1] : basename(url))
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!SOURCE_ID_RE.test(baseId)) {
    throw new Error(`addSource: cannot derive a safe source id from "${url.slice(0, 120)}" — refusing (derived id must match /^[a-z0-9][a-z0-9._-]{0,127}$/)`)
  }
  let id = baseId
  let n = 2
  while (
    id === CORE_SOURCE_ID || id === LEGACY_SOURCE_ID
    || state.sources.some(s => s.id === id)
    || registry.sources.some(s => s.id === id)
  ) id = `${baseId}-${n++}`
  state.sources.push({
    id,
    name: name || (repo ? repo.split('/')[1] : baseId),
    enabled: false,
    kind: 'custom',
    version: null,
    sha256: null,
    upstream: { repo, url, ref: null },
    lastSync: null,
    fileCount: 0,
    status: 'idle',
    statusDetail: null,
  })
  commitSourcesState(dst, state)
  return buildSourcesSnapshot(dst)
}

export function remoteRemoveSource(dst, sourceId, expectedRevision) {
  assertValidSourceId(sourceId) // M1: no '.', '..', no traversal segments
  const state = loadSourcesState(dst)
  assertRevision(state, expectedRevision)
  if (sourceId === CORE_SOURCE_ID) {
    throw new Error('bundled-core is built-in and cannot be disabled or removed')
  }
  if (sourceId === LEGACY_SOURCE_ID) {
    throw new Error('legacy-adapted is frozen (migrated local experts) and cannot be removed')
  }
  const i = state.sources.findIndex(s => s.id === sourceId)
  if (i < 0) throw new Error(`unknown source: ${sourceId}`)
  state.sources.splice(i, 1)
  rmSync(assertSourceDirInside(dst, sourceId), { recursive: true, force: true }) // M1 seatbelt
  commitSourcesState(dst, state)
  return buildSourcesSnapshot(dst)
}

export function remoteSetMirrorPrefixes(dst, prefixes, expectedRevision) {
  const state = loadSourcesState(dst)
  assertRevision(state, expectedRevision)
  if (!Array.isArray(prefixes)) throw new Error('setMirrorPrefixes: prefixes must be an array of strings')
  const clean = prefixes.map(p => String(p).trim()).filter(p => p !== '')
  for (const p of clean) {
    if (!/^https?:\/\//.test(p)) {
      throw new Error(`setMirrorPrefixes: every prefix must start with http:// or https:// — got "${p.slice(0, 64)}"`)
    }
    if (p.length > 256) throw new Error('setMirrorPrefixes: prefix too long (max 256 chars)')
  }
  if (clean.length > MAX_MIRROR_PREFIXES) {
    throw new Error(`setMirrorPrefixes: too many prefixes (max ${MAX_MIRROR_PREFIXES})`)
  }
  state.mirrorPrefixes = clean // [] = restore defaults (client contract)
  commitSourcesState(dst, state)
  return buildSourcesSnapshot(dst)
}

/** Install a custom (user-added) source: local path copy or GitHub archive
 *  with ref discovery (main → master). No pinned sha256 exists for custom
 *  sources; the security scan is still mandatory before anything lands. */
async function installCustomSource(dst, entry, channel, opts = {}) {
  assertValidSourceId(entry?.id, 'custom source id') // M1
  const url = entry.upstream?.url ?? ''
  const log = opts.log ?? []
  let selected = null
  let staging = null
  let usedChannel = null
  let version = null
  let archiveSha = null
  let skippedSymlinks = [] // symlink members skipped + recorded (never followed)
  const cleanup = () => { if (staging) rmSync(staging, { recursive: true, force: true }) }

  if (!entry.upstream?.repo) {
    const local = url.startsWith('~/') ? join(os.homedir(), url.slice(1)) : url
    // M2: only real directories are ingested — a symlinked root (or anything
    // dangling) is refused; inner symlinks are skipped by listFilesRecursive.
    let lst = null
    try { lst = lstatSync(local) } catch { /* missing → handled below */ }
    if (lst && lst.isSymbolicLink()) {
      throw new Error(`local source path is a symbolic link: ${local} — refused (symlink-injection guard)`)
    }
    if (!lst || !lst.isDirectory()) {
      throw new Error(`download failed: local source path not found or not a directory: ${local}`)
    }
    selected = listFilesRecursive(local).filter(f => matchInclude(f.rel, CUSTOM_INCLUDE, CUSTOM_EXCLUDE))
    skippedSymlinks = collectSkippedSymlinks(local).slice(0, MAX_SKIPPED_SYMLINKS)
    if (!selected.length) throw new Error(`no .md files matched under ${local}`)
    usedChannel = 'local'
    version = 'local'
  } else {
    const repo = entry.upstream.repo
    const refs = entry.upstream.ref ? [entry.upstream.ref] : ['main', 'master']
    const candidates = []
    if (channel === 'cdn') {
      for (const prefix of opts.mirrorPrefixes ?? []) {
        const p = prefix.endsWith('/') ? prefix : `${prefix}/`
        for (const ref of refs) {
          candidates.push({ channel: `mirror:${p}`, url: `${p}https://github.com/${repo}/archive/${ref}.tar.gz`, ref })
        }
      }
    }
    for (const ref of refs) {
      candidates.push({ channel: 'direct', url: `https://codeload.github.com/${repo}/tar.gz/${ref}`, ref })
    }
    const errors = []
    let buffer = null
    for (const c of candidates) {
      try {
        log.push(`channel ${c.channel}: ${c.url}`)
        buffer = await fetchBuffer(c.url)
        usedChannel = c.channel
        version = `@${c.ref}`
        break
      } catch (err) {
        errors.push(`${c.channel}: ${err.message}`)
      }
    }
    if (!buffer) throw new Error(`all channels failed for ${entry.id}:\n  ${errors.join('\n  ')}`)
    archiveSha = sha256OfBuffer(buffer)
    staging = assertSourceDirInside(dst, `.staging-${entry.id}-${process.pid}`, 'staging dir') // M1
    rmSync(staging, { recursive: true, force: true })
    untar(buffer, staging)
    // Symlink policy (user ruling): archive symlink members are skipped and
    // recorded — no longer a whole-archive rejection (never followed).
    let skippedSymlinks = []
    // M2-edge: lstat (never stat) — wrapped layout = the ONLY top-level member
    // is a real directory; a symlink-to-dir member is never a root.
    const unpacked = readdirSync(staging)
    if (unpacked.length !== 1 || !lstatSync(join(staging, unpacked[0])).isDirectory()) {
      cleanup()
      throw new Error(`unexpected archive layout for ${entry.id} (${unpacked.length} top-level entries)`)
    }
    const root = join(staging, unpacked[0])
    skippedSymlinks = collectSkippedSymlinks(root).slice(0, MAX_SKIPPED_SYMLINKS)
    selected = listFilesRecursive(root)
      .filter(f => !f.rel.split('/').includes('..'))
      .filter(f => matchInclude(f.rel, CUSTOM_INCLUDE, CUSTOM_EXCLUDE))
    if (!selected.length) {
      cleanup()
      throw new Error(`no files matched include patterns for ${entry.id}`)
    }
  }

  const findings = scanSecurity(selected)
  if (findings.length) {
    cleanup()
    const head = findings.slice(0, 20).map(f => `${f.file}:${f.line} [${f.kind}] ${f.name}`).join('\n  ')
    throw new Error(`security scan rejected ${entry.id} (${findings.length} finding(s)):\n  ${head}`)
  }

  const sourceDir = assertSourceDirInside(dst, entry.id) // M1 seatbelt
  rmSync(sourceDir, { recursive: true, force: true })
  mkdirSync(sourceDir, { recursive: true })
  const manifest = {
    id: entry.id,
    kind: 'custom',
    version,
    license: entry.license ?? '',
    upstream: entry.upstream?.url ?? '',
    channel: usedChannel,
    installedAt: new Date().toISOString(),
    skippedSymlinks,
    files: [],
  }
  try {
    for (const f of selected) {
      const dest = join(sourceDir, f.rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(f.path, dest)
      manifest.files.push({
        path: f.rel,
        sha256: sha256File(dest),
        upstreamPath: entry.upstream?.repo ? `${entry.upstream.repo}/${f.rel}@${version}` : null,
      })
    }
    writeJsonAtomic(join(sourceDir, '.source-manifest.json'), manifest)
  } catch (err) {
    rmSync(sourceDir, { recursive: true, force: true })
    throw err
  } finally {
    cleanup()
  }

  const state = loadSourcesState(dst)
  upsertSource(state, {
    id: entry.id,
    enabled: entry.enabled ?? true,
    kind: 'custom',
    version,
    sha256: archiveSha,
    upstream: entry.upstream,
    lastSync: new Date().toISOString(),
    fileCount: manifest.files.length,
    skippedSymlinks,
  })
  saveSourcesState(dst, state)
  rebuildMergedView(dst, { log })
  return state.sources.find(s => s.id === entry.id)
}

/** downloadSource/updateSource shared handler. A failed download records a
 *  terminal status on the entry (verifyFailed / scanRejected / error) and
 *  rethrows WITHOUT bumping the revision; a success marks the entry 'ok',
 *  bumps the revision and rebuilds the merged view.
 *  Security review M5: the whole sequence spans await boundaries with
 *  load-modify-save blocks — concurrent downloads could interleave and
 *  overwrite each other's sources.json (lost registration). Every call is
 *  therefore serialized through a per-target in-process mutex. */
const SOURCE_STATE_LOCKS = new Map()

function withSourcesLock(dst, fn) {
  const key = resolve(String(dst))
  const prev = SOURCE_STATE_LOCKS.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) // run regardless of the previous outcome
  SOURCE_STATE_LOCKS.set(key, run.catch(() => {})) // keep the chain alive on errors
  return run
}

export function remoteDownloadSource(dst, sourceId, channel, expectedRevision, opts = {}) {
  return withSourcesLock(dst, () => remoteDownloadSourceLocked(dst, sourceId, channel, expectedRevision, opts))
}

async function remoteDownloadSourceLocked(dst, sourceId, channel, expectedRevision, opts = {}) {
  assertValidSourceId(sourceId)
  const state = loadSourcesState(dst)
  assertRevision(state, expectedRevision)
  if (sourceId === CORE_SOURCE_ID) {
    throw new Error('bundled-core is built-in — there is nothing to download')
  }
  const registry = loadRegistry(dst)
  const regEntry = registry.sources.find(s => s.id === sourceId)
  const stateEntry = state.sources.find(s => s.id === sourceId)
  if (!regEntry && !stateEntry) throw new Error(`unknown source: ${sourceId}`)
  if (stateEntry?.kind === 'legacy-frozen') {
    throw new Error('legacy-adapted is frozen — download/update is not applicable')
  }
  if (channel !== 'github' && channel !== 'cdn') {
    throw new Error('downloadSource: channel must be "github" or "cdn"')
  }
  const mirrorPrefixes = effectiveMirrorPrefixes(registry, state)
  try {
    if (regEntry) {
      await installSource(dst, sourceId, { registry, channel, mirrorPrefixes, ackScan: opts.ackScan === true })
    } else {
      await installCustomSource(dst, stateEntry, channel, { mirrorPrefixes })
    }
  } catch (err) {
    // Scan-hit confirmation gate (user ruling): a REGISTRY source whose scan
    // found hits is not rejected outright — nothing registered, revision
    // untouched, findings persisted, and a confirmRequired marker returned
    // carrying the findings (ackField 'ackScan', same shape as the M3 gate).
    if (err instanceof ScanConfirmationRequired) {
      recordScanConfirmation(dst, sourceId, err.scanFindings)
      const pending = buildSourcesSnapshot(dst)
      pending.confirmRequired = {
        id: sourceId,
        method: opts.update ? 'updateSource' : 'downloadSource',
        ackField: 'ackScan',
        reason: `security scan hit (${err.scanFindings.length} finding(s)) — nothing was registered; confirm to register with the findings persisted for review`,
      }
      // Top-level findings for the client confirm dialog (the strict client
      // codec strips unknown fields inside confirmRequired; sourcesSnapshot
      // carries an optional top-level scanFindings as the display fallback).
      pending.scanFindings = err.scanFindings.slice(0, MAX_SCAN_FINDINGS)
      return pending
    }
    recordSourceFailure(dst, sourceId, err?.message ?? String(err))
    throw err
  }
  const after = loadSourcesState(dst)
  after.revision = (after.revision ?? 0) + 1
  const entry = after.sources.find(s => s.id === sourceId)
  if (entry) {
    entry.status = 'ok'
    delete entry.statusDetail
  }
  saveSourcesState(dst, after)
  rebuildMergedView(dst)
  return buildSourcesSnapshot(dst)
}

// ── merged stable roster view ───────────────────────────────────────────────

function mergedStateHash(dst) {
  const hash = crypto.createHash('sha256')
  const expertsDir = join(dst, EXPERTS_REL)
  for (const name of CORE_EXPERTS) {
    const p = join(expertsDir, name)
    hash.update(name)
    hash.update(existsSync(p) ? sha256File(p) : 'missing')
  }
  const state = loadSourcesState(dst)
  for (const s of state.sources) {
    hash.update(s.id)
    hash.update(String(!!s.enabled))
    const manifestPath = join(sourcesDirOf(dst), s.id, '.source-manifest.json')
    hash.update(existsSync(manifestPath) ? sha256File(manifestPath) : 'missing')
  }
  return hash.digest('hex')
}

/**
 * Rebuild expert-sources/merged/: the stable roster view.
 *   merged/bundled-core/<core>.md                — always present (11 core)
 *   merged/<source-id>/<upstream-relative-path>  — enabled sources, raw files
 * Cross-source basename collisions coexist per source dir and are annotated
 * in merged/roster.json (source provenance per file).
 */
export function rebuildMergedView(dst, opts = {}) {
  const state = loadSourcesState(dst)
  const want = typeof opts.force === 'boolean' ? opts.force : state.mergedStateHash !== mergedStateHash(dst)
  if (!want) return { skipped: true }

  const merged = mergedDirOf(dst)
  rmSync(merged, { recursive: true, force: true })
  mkdirSync(merged, { recursive: true })

  const roster = { generatedAt: new Date().toISOString(), core: [], sources: [], conflicts: [] }
  const byBasename = new Map()

  // bundled-core: always present
  const coreDir = join(merged, CORE_SOURCE_ID)
  mkdirSync(coreDir, { recursive: true })
  const expertsDir = join(dst, EXPERTS_REL)
  for (const name of CORE_EXPERTS) {
    const src = join(expertsDir, name)
    if (!existsSync(src)) continue
    copyFileSync(src, join(coreDir, name))
    const row = { source: CORE_SOURCE_ID, file: name, sha256: sha256File(src) }
    roster.core.push(row)
    byBasename.set(name, [{ source: CORE_SOURCE_ID, path: `${CORE_SOURCE_ID}/${name}` }])
  }

  // enabled sources
  for (const s of state.sources) {
    if (!s.enabled) continue
    assertValidSourceId(s.id) // M1: id becomes a path segment under merged/
    const sourceDir = assertSourceDirInside(dst, s.id)
    const files = listFilesRecursive(sourceDir).filter(f => f.rel !== '.source-manifest.json' && f.rel.endsWith('.md'))
    const rows = []
    for (const f of files) {
      const dest = join(merged, s.id, f.rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(f.path, dest)
      const row = { source: s.id, file: f.rel, sha256: sha256File(f.path) }
      rows.push(row)
      const base = basename(f.rel)
      if (!byBasename.has(base)) byBasename.set(base, [])
      byBasename.get(base).push({ source: s.id, path: `${s.id}/${f.rel}` })
    }
    roster.sources.push({ id: s.id, version: s.version, fileCount: rows.length, files: rows })
  }

  roster.conflicts = [...byBasename.entries()]
    .filter(([, occ]) => occ.length > 1)
    .map(([name, occ]) => ({ basename: name, occurrences: occ }))
  writeJsonAtomic(join(merged, 'roster.json'), roster)

  state.mergedStateHash = mergedStateHash(dst)
  saveSourcesState(dst, state)
  return { skipped: false, fileCount: roster.core.length + roster.sources.reduce((n, s) => n + s.fileCount, 0), conflicts: roster.conflicts.length }
}

export function readMergedRoster(dst) {
  const p = join(mergedDirOf(dst), 'roster.json')
  if (!existsSync(p)) throw new Error('merged view not built yet')
  return readJson(p)
}

// ── legacy migration (apply-time) ───────────────────────────────────────────

/**
 * Migrate legacy non-core experts out of experts/ into
 * expert-sources/legacy-adapted/ (frozen local source, enabled by default).
 * Idempotent: after migration experts/ holds only bundled core; re-runs are
 * no-ops. Nothing is deleted — files are moved, the ledger records them.
 */
export function migrateLegacyExperts(dst, opts = {}) {
  const log = opts.log || []
  const expertsDir = join(dst, EXPERTS_REL)
  if (!existsSync(expertsDir)) return { moved: 0 }
  const legacyDir = join(sourcesDirOf(dst), LEGACY_SOURCE_ID)
  const moved = []
  for (const name of readdirSync(expertsDir).sort()) {
    if (!name.endsWith('.md')) continue
    if (CORE_EXPERTS.includes(name)) continue
    const src = join(expertsDir, name)
    mkdirSync(legacyDir, { recursive: true })
    renameSync(src, join(legacyDir, name))
    moved.push(name)
  }
  if (!moved.length && existsSync(join(legacyDir, '.source-manifest.json'))) {
    return { moved: 0 } // fully migrated on a previous apply — nothing to do
  }
  if (moved.length) log.push(`migrated ${moved.length} legacy expert(s) -> ${LEGACY_SOURCE_ID}/`)

  const state = loadSourcesState(dst)
  const already = state.sources.find(s => s.id === LEGACY_SOURCE_ID)
  const files = listFilesRecursive(legacyDir).filter(f => f.rel.endsWith('.md'))
  if (!files.length) return { moved: moved.length }
  const ledger = {
    id: LEGACY_SOURCE_ID,
    enabled: already?.enabled ?? true,
    kind: 'legacy-frozen',
    version: 'legacy-1.5.0-frozen',
    sha256: sha256OfBuffer(Buffer.from(files.map(f => `${f.rel}:${sha256File(f.path)}`).join('\n'), 'utf-8')),
    upstream: null,
    lastSync: new Date().toISOString(),
    fileCount: files.length,
  }
  upsertSource(state, ledger)
  writeJsonAtomic(join(legacyDir, '.source-manifest.json'), {
    id: LEGACY_SOURCE_ID,
    kind: 'legacy-frozen',
    note: 'Adapted copies migrated from the pre-2.0 bundled experts/ (frontmatter adaptation layer only; upstream bodies byte-identical per T1 diff). Frozen as-of migration.',
    migratedAt: new Date().toISOString(),
    files: files.map(f => ({ path: f.rel, sha256: sha256File(f.path), upstreamPath: null })),
  })
  saveSourcesState(dst, state)
  return { moved: moved.length, registered: ledger }
}

// ── deploy (unchanged semantics + sources runtime) ──────────────────────────

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

function refreshEntry(rel, dst, log) {
  const s = join(PKG_ROOT, rel)
  const d = join(dst, rel)
  if (statSync(s).isDirectory()) refreshDir(s, d, log)
  else {
    mkdirSync(dirname(d), { recursive: true })
    copyFileSync(s, d)
    log.push(`~ ${d}`)
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
    if (deployed !== DEPLOY_REV) {
      for (const rel of PROTOCOL) refreshEntry(rel, dst, log)
      writeFileSync(markerPath, DEPLOY_REV)
    }

    for (const rel of USER_DATA) {
      const s = join(PKG_ROOT, rel)
      const d = join(dst, rel)
      if (statSync(s).isDirectory()) deployDir(s, d, log)
      else copyIfMissing(s, d, log)
    }

    // T2 source-management runtime: migrate legacy experts, then keep the
    // merged stable roster view in sync. Both are idempotent.
    const migration = migrateLegacyExperts(dst, { log })
    if (migration.registered || existsSync(sourcesJsonPath(dst))) {
      rebuildMergedView(dst, { log })
    }

    console.log(`[dsh-expert-orchestrator] preset ready at ${dst} (deploy ${DEPLOY_REV})`)
    if (log.length) console.log('[dsh-expert-orchestrator] ' + log.join('\n[dsh-expert-orchestrator] '))
    if (migration.moved) console.log(`[dsh-expert-orchestrator] legacy migration: moved ${migration.moved}`)
    // NOTE: apply 不得返回普通对象——宿主 cordis _execute 只接受 undefined /
    // dispose 函数 / thenable / (async) iterable，其余值抛 "Invalid effect"
    // （cordis/lib/index.js _execute 末尾 else throw）。迁移与路径信息经 log 输出。
  },
}
