// test/sync-deploy-hostdetect.selftest.mjs — sync-deploy.mjs 宿主检测分支回归（T26）
// 背景：T25 发版夜 mac 步在 NAS 宿主上因 ~/.dsh/profiles/desktop 同形路径假阳性命中
// 而 exit=0；nas 步在本机=NAS 时无条件 ssh 回环且 key 缺失 exit=2。T26 给
// scripts/sync-deploy.mjs 加宿主检测（hostDetect/hostGate 导出，import 零副作用）
// 与 auto 模式。覆盖三门径：
// ① NAS 本机流：真机 NAS 宿主 hostDetect()='nas'，auto 放行（hostGate('auto','nas')=null）；
// ② mac 本地流：mock platform=darwin → 'mac'，mac 门放行；非 mac 宿主 mac 门 exit=2；
// ③ 宿主不符 skip：CLI 子进程实证 mac/nas 模式在 NAS 宿主 exit=2 具名提示
//    （nas 门先于 SSH key 检查触发，回环不发生），auto 在 other 宿主 exit=2。
// CLI 子进程用例仅在 NAS 宿主上跑（本仓库发版宿主），其余宿主跳过并如实标注。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostDetect, hostGate } from '../scripts/sync-deploy.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sync-deploy.mjs')
const NAS_HOME = '/vol2/@appshare/Harness'

/** 临时改 process.platform（可恢复），跑完断言还原。 */
const withPlatform = (value, fn) => {
  const orig = process.platform
  Object.defineProperty(process, 'platform', { value })
  try { return fn() } finally { Object.defineProperty(process, 'platform', { value: orig }) }
}

test('hostDetect 真机分支：本宿主（发版宿主）判定与 platform/homedir 依据一致', () => {
  const h = hostDetect()
  if (process.platform === 'darwin') assert.equal(h, 'mac')
  else if (process.platform === 'linux' && homedir().startsWith(NAS_HOME)) assert.equal(h, 'nas')
  else assert.equal(h, 'other')
})

test('hostDetect mock darwin → mac；mock win32（homedir 同形也不可穿越）→ other', () => {
  // ① mac 本地流门径：darwin 即 mac，与 homedir 无关（NAS homedir 同形也不误判）
  withPlatform('darwin', () => assert.equal(hostDetect(), 'mac'))
  // ② other 门径：非 linux 非 darwin 一律 other
  withPlatform('win32', () => assert.equal(hostDetect(), 'other'))
})

test('hostGate 三门径矩阵：既有宿主组合放行（逐字节兼容面），不符组合具名 exit=2', () => {
  // 既有语义保持：真 mac 跑 mac、非 NAS 宿主跑 nas 原样放行
  assert.equal(hostGate('mac', 'mac'), null)
  assert.equal(hostGate('nas', 'other'), null)
  assert.equal(hostGate('nas', 'mac'), null)
  // auto 在已识别宿主放行
  assert.equal(hostGate('auto', 'nas'), null)
  assert.equal(hostGate('auto', 'mac'), null)
  // 门：宿主不符 → { code: 2, msg 具名 }
  for (const [cmd, host] of [['mac', 'nas'], ['mac', 'other'], ['nas', 'nas'], ['auto', 'other']]) {
    const g = hostGate(cmd, host)
    assert.ok(g, `${cmd}@${host} 必须被门拦下`)
    assert.equal(g.code, 2)
    assert.match(g.msg, /宿主/)
    assert.ok(g.msg.length > 20, '必须具名提示（不静默）')
  }
  // status 只读对账不设门（既有语义）
  assert.equal(hostGate('status', 'nas'), null)
})

test('CLI 门（NAS 真机）：mac/nas 显式模式 exit=2 具名提示，nas 门先于 SSH key 检查', (t) => {
  if (hostDetect() !== 'nas') return t.skip('仅 NAS 发版宿主跑 CLI 门用例')
  const run = (arg) => spawnSync('node', [SCRIPT, arg], { encoding: 'utf-8' })
  // ③ 宿主不符 skip：mac 步不再假阳性 exit=0（T25 复发防门）
  const mac = run('mac')
  assert.equal(mac.status, 2)
  assert.match(mac.stderr, /宿主不符/)
  // nas 步不再 ssh 回环：门先触发，输出不含 SSH key 文案
  const nas = run('nas')
  assert.equal(nas.status, 2)
  assert.match(nas.stderr, /宿主不符/)
  assert.doesNotMatch(nas.stderr + nas.stdout, /SSH key/)
  // 未知命令退出码保持既有（1）
  assert.equal(run('bogus').status, 1)
  // 无参用法退出码保持既有（2）
  assert.equal(spawnSync('node', [SCRIPT], { encoding: 'utf-8' }).status, 2)
})
