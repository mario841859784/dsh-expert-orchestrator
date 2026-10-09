// T1 (v2.9 M1) 发布面漂移收口 — PROTOCOL 刷新沙箱演练（沿 T41 v2.8 演练法）
// 方法：真实 apply() 路径（lib/index.js 默认导出，非刷新逻辑复刻），
//       config.targetDir 指向 /tmp 沙箱；预置 stale 哨兵 + 旧 marker 触发刷新。
//       VERSION 字面量零改动（版本字面量属 T5）；真实部署目录全程只读对照。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const REPO = '/vol2/@appshare/Harness/workspace/project1/dsh-expert-orchestrator'
const TARGET = '/tmp/t1-drill/target'
const REAL_DEPLOY = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.agent-presets', 'expert-orchestrator')

// 17 条 PROTOCOL 条目（镜像 lib/index.js 现状：14 旧 + 3 新），用于预置哨兵与逐文件核对
const ENTRIES = [
  'agent.cordis.yml',
  'preset.yml',
  'skills/expert-orchestration/source-registry.json',
  'skills/expert-orchestration/SKILL.md',
  'skills/expert-orchestration/routing.md',
  'skills/expert-orchestration/roster-aliases.json',
  'skills/expert-orchestration/experts',
  'skills/expert-gestures',
  'skills/expert-orchestration/tools/taskboard.py',
  'skills/expert-orchestration/tools/bus.py',
  'skills/trim-cli/SKILL.md',
  'skills/trim-cli/manifest.json',
  'skills/trim-cli/entries',
  'skills/trim-cli/reference',
  'README.md',       // 新增（T1）
  'README.zh.md',    // 新增（T1）
  'CHANGELOG.md',    // 新增（T1）
]
const NEW_ENTRIES = ['README.md', 'README.zh.md', 'CHANGELOG.md']
const USER_DATA = [
  'skills/expert-orchestration/lessons.md',
  'expert-lessons/backend-engineer.md',
  'expert-methods/backend-engineer.md',
]
const SENTINEL = 'STALE-2.7.1-deploy-copy'

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
let failures = 0
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`); if (!ok) failures++ }

// ── 沙箱预置 ────────────────────────────────────────────────────────────────
rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
let seeded = 0
for (const rel of ENTRIES) {
  const src = join(REPO, rel)
  const walk = (s, d) => {
    if (statSync(s).isDirectory()) {
      for (const name of readdirSync(s)) walk(join(s, name), join(d, name))
    } else {
      mkdirSync(dirname(d), { recursive: true })
      writeFileSync(d, SENTINEL)
      seeded++
    }
  }
  walk(src, join(TARGET, rel))
}
// 三新条目哨兵面：README.md/CHANGELOG.md 写 stale 旧内容；README.zh.md 缺失（首次落部署面）
writeFileSync(join(TARGET, 'README.md'), SENTINEL)
writeFileSync(join(TARGET, 'CHANGELOG.md'), SENTINEL)
rmSync(join(TARGET, 'README.zh.md'), { force: true })
console.log(`seeded sentinel files: ${seeded} (17 entries, dirs recursive)`)
check(readFileSync(join(TARGET, 'README.md'), 'utf-8') === SENTINEL, 'pre: README.md holds stale sentinel')
check(readFileSync(join(TARGET, 'CHANGELOG.md'), 'utf-8') === SENTINEL, 'pre: CHANGELOG.md holds stale sentinel')
check(!existsSync(join(TARGET, 'README.zh.md')), 'pre: README.zh.md absent (first landing expected)')
// USER_DATA 哨兵（copy-if-missing 面，演练不得触碰）
for (const rel of USER_DATA) { mkdirSync(dirname(join(TARGET, rel)), { recursive: true }); writeFileSync(join(TARGET, rel), SENTINEL) }
// 刷新目录内用户附加文件（覆盖≠删除语义）
writeFileSync(join(TARGET, 'skills/expert-gestures/user-extra.md'), SENTINEL)
// stale marker 触发刷新（DEPLOY_REV 派生逻辑不动，VERSION 字面量零改动）
writeFileSync(join(TARGET, '.deployed-version'), '2.7.1+sources1')

const realBefore = readFileSync(join(REAL_DEPLOY, '.deployed-version'), 'utf-8').trim()
console.log(`REAL MARKER BEFORE : "${realBefore}"`)

// ── 真实 apply() ────────────────────────────────────────────────────────────
const captured = []
const origLog = console.log
console.log = (...a) => { captured.push(a.join(' ')) }
const { default: plugin } = await import(join(REPO, 'lib/index.js'))
plugin.apply({}, { targetDir: TARGET })
console.log = origLog
const deployLog = captured
  .flatMap((l) => l.split('\n'))
  .map((l) => l.replace(/^\[dsh-expert-orchestrator\] /, ''))
  .filter((l) => l.startsWith('~') || l.startsWith('+'))

// ── 断言 ────────────────────────────────────────────────────────────────────
const verLine = readFileSync(join(REPO, 'lib/index.js'), 'utf-8').match(/const VERSION = '([^']+)'/)
const expectedRev = `${verLine[1]}+sources1`
check(readFileSync(join(TARGET, '.deployed-version'), 'utf-8').trim() === expectedRev, `marker 2.7.1+sources1 → ${expectedRev}`)

let compared = 0
for (const rel of ENTRIES) {
  const walk = (s, d) => {
    if (statSync(s).isDirectory()) {
      for (const name of readdirSync(s)) walk(join(s, name), join(d, name))
    } else {
      compared++
      if (sha256(d) !== sha256(s)) { failures++; console.log(`FAIL: sha256 mismatch ${rel}`) }
    }
  }
  walk(join(REPO, rel), join(TARGET, rel))
}
check(failures === 0, `${ENTRIES.length} PROTOCOL entries refreshed byte-identical from the package (${compared} files compared)`)
check(deployLog.filter((l) => l.startsWith('~')).length === compared, `first apply() refreshed exactly ${compared} files (~ lines)`)

for (const rel of NEW_ENTRIES) {
  check(sha256(join(TARGET, rel)) === sha256(join(REPO, rel)), `new entry ${rel}: sentinel overwritten, sha256 == package copy`)
}
check(deployLog.some((l) => l === `~ ${join(TARGET, 'README.md')}`), 'refresh log covers ~ README.md (refreshEntry path)')
check(deployLog.some((l) => l === `~ ${join(TARGET, 'README.zh.md')}`), 'refresh log covers ~ README.zh.md (first landing)')
check(deployLog.some((l) => l === `~ ${join(TARGET, 'CHANGELOG.md')}`), 'refresh log covers ~ CHANGELOG.md')
check(readFileSync(join(TARGET, 'README.md'), 'utf-8') !== SENTINEL && readFileSync(join(TARGET, 'CHANGELOG.md'), 'utf-8') !== SENTINEL, 'CUSTOM_EXCLUDE did not exclude README/CHANGELOG (sentinels gone, package bytes landed)')

for (const rel of USER_DATA) {
  check(readFileSync(join(TARGET, rel), 'utf-8') === SENTINEL, `USER_DATA untouched: ${rel}`)
}
check(readFileSync(join(TARGET, 'skills/expert-gestures/user-extra.md'), 'utf-8') === SENTINEL, 'extra user file inside refreshed protocol dir NOT deleted')

// ── 幂等：第二次 apply() 零刷新 ─────────────────────────────────────────────
captured.length = 0
console.log = (...a) => { captured.push(a.join(' ')) }
plugin.apply({}, { targetDir: TARGET })
console.log = origLog
const secondLog = captured
  .flatMap((l) => l.split('\n'))
  .map((l) => l.replace(/^\[dsh-expert-orchestrator\] /, ''))
  .filter((l) => l.startsWith('~') || l.startsWith('+'))
check(secondLog.length === 0, 'second apply() refreshed nothing (idempotent)')
check(readFileSync(join(TARGET, '.deployed-version'), 'utf-8').trim() === expectedRev, 'marker untouched by second apply()')

const realAfter = readFileSync(join(REAL_DEPLOY, '.deployed-version'), 'utf-8').trim()
console.log(`REAL MARKER AFTER  : "${realAfter}"`)
check(realBefore === realAfter, 'real deploy marker untouched (read-only对照)')

console.log(`DRILL: ${failures === 0 ? 'ALL PASS' : `FAILED (${failures})`} (${compared} files, ${ENTRIES.length} entries)`)
process.exit(failures === 0 ? 0 : 1)
