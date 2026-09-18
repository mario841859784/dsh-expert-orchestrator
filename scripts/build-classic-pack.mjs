#!/usr/bin/env node
/**
 * build-classic-pack.mjs — build the offline "classic" expert source pack (T2)
 *
 * The classic pack anchors the 67 historically-adapter copies of upstream
 * expert files that lived in skills/expert-orchestration/experts/ before the
 * source-management split (repo HEAD eafa0de). It redistributes the
 * UPSTREAM-ORIGINAL bytes (zero rename, zero content edit), organized per
 * upstream project:
 *
 *   awesome-claude-code-subagents/<upstream-relative-path>   (62 files)
 *   wshobson-agents/<upstream-relative-path>                 (4 files)
 *   agency-agents-zh/<upstream-relative-path>                (1 file)
 *   MANIFEST.json                                            (per-file sha256)
 *
 * How it works (deterministic, no hardcoded file list):
 *   1. read the historical adapted copies from git: `git grep -l '^来源:' <rev>
 *      -- skills/expert-orchestration/experts` — exactly the 67 non-core files;
 *   2. shallow-fetch each upstream repo at its pinned commit (registry
 *      ref; network faithful to the download channels, TLS-reset retried once);
 *   3. for each adapted copy: strip frontmatter, normalize trailing
 *      whitespace/blank lines (T1 diff showed bodies are byte-identical under
 *      that normalization), then match the upstream file by basename + exact
 *      normalized body — a mismatch aborts the build;
 *   4. stage the matching upstream files under <source-id>/<upstream-path>,
 *      write MANIFEST.json (per-file sha256), tar.gz the staging dir;
 *   5. emit dist/source-packs/source-packs-v1.tgz + .sha256 and print the
 *      registry `pack.sha256` value to paste into source-registry.json.
 *
 * Usage: node scripts/build-classic-pack.mjs [--out dist/source-packs] [--work /tmp/...]
 * Requires: git, tar, network. honours GH_TOKEN for higher API rate limits.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')
const GIT_REV = 'HEAD'
const EXPERTS_PREFIX = 'skills/expert-orchestration/experts'
const REGISTRY_REL = 'skills/expert-orchestration/source-registry.json'
const PACK_TAG = 'source-packs-v1'
const FROZEN_REF_NOTE = 'pinned in source-registry.json'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const OUT_DIR = resolve(process.cwd(), argOf('--out', 'dist/source-packs'))
const WORK_DIR = argOf('--work', `/tmp/${PACK_TAG}-build-${process.pid}`)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function sh(cmd, cmdArgs, opts = {}) {
  const res = execFileSync(cmd, cmdArgs, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, ...opts })
  return res
}

/** Shallow-fetch one pinned commit (retry once on TLS resets; falls back to
 *  the codeload archive channel — same bytes the runtime download uses). */
function shallowFetch(repo, ref, destDir) {
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  sh('git', ['init', '-q', destDir])
  sh('git', ['-C', destDir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`])
  let lastErr = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = spawnSync('git', ['-C', destDir, 'fetch', '--depth', '1', 'origin', ref], { encoding: 'utf-8' })
    if (res.status === 0) {
      sh('git', ['-C', destDir, 'checkout', '-q', 'FETCH_HEAD'])
      return
    }
    lastErr = (res.stderr || '').trim()
    if (attempt === 1) console.error(`  transient fetch failure for ${repo}, retrying once…`)
  }
  console.error(`  shallow fetch failed (${lastErr.split('\n')[0]}) — falling back to codeload archive`)
  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = spawnSync('curl', ['-sfL', '--retry', '2', '--max-time', '180', url, '-o', join(destDir, 'archive.tgz')], { encoding: 'utf-8' })
    if (res.status === 0) break
    if (attempt === 2) throw new Error(`archive fallback failed for ${repo}@${ref}`)
  }
  const untar = spawnSync('tar', ['-xzf', join(destDir, 'archive.tgz'), '-C', destDir, '--strip-components', '1'], { encoding: 'utf-8' })
  if (untar.status !== 0) throw new Error(`untar failed for ${repo}: ${untar.stderr}`)
  rmSync(join(destDir, 'archive.tgz'), { force: true })
}

/** strip frontmatter + normalize the way T1's diff did (trailing whitespace,
 *  blank-line runs collapsed, leading/trailing blank lines dropped — T1
 *  proved body differences are exactly blank-line-level for 5 of 67 files). */
function normalizedBody(text) {
  let body = text
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1)
  }
  const lines = body.split('\n').map(l => l.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  while (lines.length && lines[0] === '') lines.shift()
  const collapsed = []
  for (const l of lines) {
    if (l === '' && collapsed[collapsed.length - 1] === '') continue
    collapsed.push(l)
  }
  return collapsed.join('\n')
}

function listFiles(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel))
    else out.push({ rel, path: full })
  }
  return out
}

function globToRegExp(glob) {
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

// ── main ─────────────────────────────────────────────────────────────────────

const registry = JSON.parse(readFileSync(join(PKG_ROOT, REGISTRY_REL), 'utf-8'))

console.log(`[1/5] listing historically adapted experts from git rev ${GIT_REV}…`)
const gitFiles = sh('git', ['-C', PKG_ROOT, 'grep', '-l', '^来源:', GIT_REV, '--', `${EXPERTS_PREFIX}/*.md`])
  .split('\n').map(l => l.trim()).filter(Boolean)
const adapted = gitFiles.map(line => {
  const rel = line.slice(line.indexOf(':') + 1) // "<rev>:<path>"
  const name = rel.slice(EXPERTS_PREFIX.length + 1)
  return {
    name,
    content: sh('git', ['-C', PKG_ROOT, 'show', `${GIT_REV}:${rel}`]),
  }
})
console.log(`      ${adapted.length} adapted file(s)`)

mkdirSync(WORK_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })
const staging = join(WORK_DIR, 'pack')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

const manifest = { pack: PACK_TAG, generatedAt: new Date().toISOString(), sources: [] }
const assigned = new Map()

for (const source of registry.sources) {
  const packFiles = adapted.filter(a => !assigned.has(a.name))
  if (!packFiles.length) break
  // Only the sources the classic pack covers are cloned; pack coverage is
  // decided per-file by body match below.
  const repo = source.upstream.repo
  const ref = source.upstream.ref
  const cloneDir = join(WORK_DIR, source.id)
  console.log(`[2/5] shallow-fetch ${repo}@${ref.slice(0, 7)}…`)
  shallowFetch(repo, ref, cloneDir)

  const include = source.include.map(globToRegExp)
  const exclude = source.exclude.map(globToRegExp)
  const candidates = listFiles(cloneDir).filter(f =>
    f.rel.endsWith('.md') &&
    include.some(re => re.test(f.rel)) &&
    !exclude.some(re => re.test(f.rel)))
  console.log(`      ${candidates.length} upstream candidate file(s)`)

  const byBasename = new Map()
  for (const c of candidates) {
    const base = c.rel.split('/').pop()
    if (!byBasename.has(base)) byBasename.set(base, [])
    byBasename.get(base).push(c)
  }

  const files = []
  for (const a of packFiles) {
    const base = a.name
    const matches = (byBasename.get(base) || [])
      .filter(c => normalizedBody(readFileSync(c.path, 'utf-8')) === normalizedBody(a.content))
    if (matches.length === 0) continue // belongs to another upstream source — try there
    if (matches.length !== 1) {
      throw new Error(`ambiguous anchor for ${a.name} in ${source.id}: ${matches.length} normalized-body match(es) — refusing to build a non-faithful pack`)
    }
    const up = matches[0]
    const dest = join(staging, source.id, up.rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(up.path, dest)
    files.push({ path: `${source.id}/${up.rel}`, sha256: sha256(readFileSync(up.path)), adaptedFrom: `${EXPERTS_PREFIX}/${a.name}` })
    assigned.set(a.name, source.id)
    console.log(`      anchored ${a.name} -> ${source.id}/${up.rel}`)
  }
  if (files.length) manifest.sources.push({ id: source.id, repo, ref, license: source.license, fileCount: files.length, files })
}

if (assigned.size !== adapted.length) {
  const missing = adapted.filter(a => !assigned.has(a.name)).map(a => a.name)
  throw new Error(`unanchored adapted files: ${missing.join(', ')}`)
}

console.log(`[3/5] writing MANIFEST.json (${assigned.size} files)…`)
writeFileSync(join(staging, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')

console.log(`[4/5] packing ${PACK_TAG}.tgz…`)
const tgzPath = join(OUT_DIR, `${PACK_TAG}.tgz`)
rmSync(tgzPath, { force: true })
const tar = spawnSync('tar', ['-czf', tgzPath, '-C', staging, '.'], { encoding: 'utf-8' })
if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)

const digest = sha256(readFileSync(tgzPath))
writeFileSync(`${tgzPath}.sha256`, `${digest}  ${PACK_TAG}.tgz\n`)
console.log(`[5/5] done`)
console.log(`pack:     ${tgzPath}`)
console.log(`sha256:   ${digest}`)
console.log(`registry: set sources[].pack.sha256 (or top-level pack.sha256) to the value above`)
