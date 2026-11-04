// test/deploy-fail-open.selftest.mjs — lib/index.js apply 部署链路 fail-open 回归
// （2026-11-04 生产实证：安装副本单条源文件 EACCES 曾让 refreshEntry 抛错中止整个
// apply，fire-and-forget 的 registerExpertTools 永不执行）。覆盖：
// ① PROTOCOL 单条失败（mock：目标文件预置只读 → copyFileSync EACCES）→ apply 不抛、
//    后续条目照常部署、marker 不写（旧 marker 保留 → 下次启动重试）、工具注册仍执行；
// ② USER_DATA 单条失败（mock：目录路径预置为普通文件 → copyFileSync ENOTDIR）→
//    apply 不抛、后续条目照常部署。
// 文件系统用例使用 os.tmpdir() 临时目录，结束后清理，不触碰仓库内任何数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../lib/index.js'

const MARKER = '.deployed-version'

/** 记录注册工具名的假 ctx（registerExpertTools 守卫面：tools.register +
 *  subagents.start/getProvider；systemPrompt 缺失走既有 typeof 守卫跳过）。 */
const fakeCtx = (registered) => ({
  tools: { register: (t) => registered.push(t.name) },
  subagents: { start() {}, getProvider() {} },
})

/** 等待 apply 的 fire-and-forget import('./tools.js').then(register) 链落地。 */
const flushRegistration = () => new Promise((r) => setTimeout(r, 100))

test('fail-open ① PROTOCOL 单条 EACCES：apply 不抛、后续条目继续、marker 不写、registerExpertTools 仍被调用', async (t) => {
  const dst = mkdtempSync(join(tmpdir(), 'deploy-failopen-'))
  t.after(() => {
    chmodSync(join(dst, 'skills', 'expert-orchestration', 'SKILL.md'), 0o644)
    rmSync(dst, { recursive: true, force: true })
  })
  // 注入点：PROTOCOL 第 4 条 skills/expert-orchestration/SKILL.md 的目标文件预置
  // 只读哨兵 → copyFileSync 抛 EACCES；其后的条目（…/README.md、CHANGELOG.md）
  // 用于断言「继续后续条目」。
  const sentinelDir = join(dst, 'skills', 'expert-orchestration')
  mkdirSync(sentinelDir, { recursive: true })
  const sentinel = join(sentinelDir, 'SKILL.md')
  writeFileSync(sentinel, 'SENTINEL-OLD-COPY')
  chmodSync(sentinel, 0o444)

  const registered = []
  assert.doesNotThrow(() => plugin.apply(fakeCtx(registered), { targetDir: dst }))
  await flushRegistration()

  // ③ marker 未写（下次宿主启动自动重试失败条目）
  assert.equal(existsSync(join(dst, MARKER)), false, '有失败条目时不得写 DEPLOY_REV marker')
  // 单条失败降级：哨兵未被覆盖
  assert.equal(readFileSync(sentinel, 'utf-8'), 'SENTINEL-OLD-COPY')
  // 后续条目照常部署
  assert.equal(existsSync(join(dst, 'README.md')), true, '失败条目之后的 PROTOCOL 条目必须继续部署')
  assert.equal(existsSync(join(dst, 'CHANGELOG.md')), true)
  // ② registerExpertTools 仍被调用（三个召唤工具注册）
  assert.deepEqual(registered.sort(), ['list_experts', 'summon_expert', 'summon_experts'])
})

test('fail-open ② USER_DATA 单条失败：apply 不抛、后续条目继续部署、migration/工具注册不受影响', async (t) => {
  const dst = mkdtempSync(join(tmpdir(), 'deploy-failopen-ud-'))
  t.after(() => rmSync(dst, { recursive: true, force: true }))
  // 注入点：USER_DATA 第 2 条 expert-lessons（源为目录）的目标位置预置为普通文件
  // → deployDir 内 copyFileSync 抛 ENOTDIR；第 3 条 expert-methods 用于断言继续。
  writeFileSync(join(dst, 'expert-lessons'), 'not-a-dir')

  const registered = []
  assert.doesNotThrow(() => plugin.apply(fakeCtx(registered), { targetDir: dst }))
  await flushRegistration()

  // 后续 USER_DATA 条目照常部署
  assert.equal(existsSync(join(dst, 'expert-methods')), true)
  // 全部刷新成功路径不受 USER_DATA 失败影响：PROTOCOL 成功 → marker 正常写入
  assert.equal(existsSync(join(dst, MARKER)), true)
  // 工具注册仍执行
  assert.deepEqual(registered.sort(), ['list_experts', 'summon_expert', 'summon_experts'])
})
