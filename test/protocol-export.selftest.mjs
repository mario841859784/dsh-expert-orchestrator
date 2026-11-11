// 方向 5 协议对接自测：MCP stdio 导出面（tools/mcp_taskboard.py）+ A2A AgentCard 生成器
// （scripts/gen-agent-card.mjs）（node:test，零依赖）。
// 覆盖面：
// - MCP initialize/协议版本回显/serverInfo；notifications/initialized 零回包；ping；
//   tools/list 缺省只读（7 读工具、零写工具）；tools/call 读链路（status/show/open-counts/
//   budget/list_experts 兜底）；写面缺省具名拒 writes_disabled（isError=true）；
//   DSH_TASKBOARD_MCP_WRITES=1 时写工具入列 + create/claim/progress/done 全链真写；
//   未知 method -32601；DSH_TASKBOARD_MCP_BOARD --board 透传；
// - AgentCard：bundled 兜底 11 skills、必备字段、disabled/shadowed 过滤、--out 落盘、
//   deployed roster 源切换。
// R1 口径如实声明：stdio = 与 CLI 同信任级别（能启动进程者本就能直跑 taskboard.py）；
// 写面 opt-in 缺省只读（外部写入=代理转达变更，方向 4 审计口径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TOOLS_DIR = fileURLToPath(new URL('../skills/expert-orchestration/tools/', import.meta.url))
const MCP = join(TOOLS_DIR, 'mcp_taskboard.py')
const CARD = fileURLToPath(new URL('../scripts/gen-agent-card.mjs', import.meta.url))
const SKILL_DIR = fileURLToPath(new URL('../skills/expert-orchestration/', import.meta.url))

/** 一次性驱动 MCP server：stdin 喂全部请求行，收全部响应行（顺序确定）。 */
const drive = (cwd, lines, extraEnv = {}) => {
  const r = spawnSync('python3', [MCP], {
    cwd, encoding: 'utf-8', timeout: 30000,
    input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    env: { ...process.env, ...extraEnv },
  })
  assert.equal(r.status, 0, `server 退出码 0（stderr: ${r.stderr}）`)
  const out = (r.stdout ?? '').trim().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  return { out, stderr: r.stderr ?? '' }
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
const note = (method, params) => ({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
const respOf = (out, id) => out.find((m) => m.id === id)

test('方向5-mcp initialize/协议版本回显/serverInfo/notifications 零回包/ping', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'd5-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { out } = drive(dir, [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' } }),
    note('notifications/initialized'),
    rpc(2, 'ping'),
  ])
  const init = respOf(out, 1)
  assert.equal(init.result.protocolVersion, '2025-06-18', '协议版本回显')
  assert.equal(init.result.serverInfo.name, 'dsh-taskboard-mcp')
  assert.ok(init.result.capabilities.tools, 'tools capability 声明')
  assert.equal(respOf(out, 2).result, undefined ? undefined : respOf(out, 2).result, 'ping 空结果')
  assert.deepEqual(respOf(out, 2).result, {})
  assert.equal(out.filter((m) => m.id === undefined && m.method).length, 0, 'notification 不产生回包')
})

test('方向5-mcp tools/list 缺省只读：7 读工具、零写工具；写面缺省具名拒 writes_disabled', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'd5-mcp-ro-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { out } = drive(dir, [
    rpc(1, 'tools/list'),
    rpc(2, 'tools/call', { name: 'taskboard_create', arguments: { title: '外部任务' } }),
    rpc(3, 'tools/call', { name: 'taskboard_status', arguments: {} }),
  ])
  const names = respOf(out, 1).result.tools.map((x) => x.name)
  assert.equal(names.length, 7, `缺省只读 7 工具：${names}`)
  assert.ok(names.includes('list_experts') && names.includes('taskboard_show'))
  assert.ok(!names.includes('taskboard_claim'), '写工具缺省不入列')
  const writeCall = respOf(out, 2)
  assert.equal(writeCall.result.isError, true, '写面关闭：isError')
  assert.ok(writeCall.result.content[0].text.includes('writes_disabled') && writeCall.result.content[0].text.includes('DSH_TASKBOARD_MCP_WRITES'), writeCall.result.content[0].text)
  // 空板 status 正常（人读输出回退）
  const st = respOf(out, 3)
  assert.equal(st.result.isError, false, 'status 只读可用')
  assert.ok(st.result.content[0].text.length > 0)
})

test('方向5-mcp 写面开启：写工具入列 + create/claim/progress/done 全链真写 + show 读回', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'd5-mcp-rw-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { DSH_TASKBOARD_MCP_WRITES: '1' }
  const { out } = drive(dir, [
    rpc(1, 'tools/list'),
    rpc(2, 'tools/call', { name: 'taskboard_create', arguments: { title: 'MCP 写链任务', scope: 'src' } }),
    rpc(3, 'tools/call', { name: 'taskboard_claim', arguments: { id: 'T1', owner: '外部代理A' } }),
    rpc(4, 'tools/call', { name: 'taskboard_progress', arguments: { id: 'T1', note: 'MCP 检查点一' } }),
    rpc(5, 'tools/call', { name: 'taskboard_done', arguments: { id: 'T1', summary: 'MCP 交付', by: '外部代理A' } }),
    rpc(6, 'tools/call', { name: 'taskboard_show', arguments: { id: 'T1' } }),
  ], env)
  const names = respOf(out, 1).result.tools.map((x) => x.name)
  assert.ok(names.includes('taskboard_claim') && names.includes('taskboard_done'), '写工具入列')
  for (const id of [2, 3, 4, 5]) {
    assert.equal(respOf(out, id).result.isError, false, `tools/call ${id} 成功`)
  }
  const showText = respOf(out, 6).result.content[0].text
  const receipt = JSON.parse(showText)
  assert.equal(receipt.ok, true, 'show --json 信封结构化回传')
  const task = receipt.data.task
  assert.equal(task.status, 'done', '全链写面生效：done')
  assert.ok(task.checkpoints.some((c) => c.note.includes('MCP 检查点一')), '检查点真写')
})

test('方向5-mcp 未知 method -32601；--board 透传（DSH_TASKBOARD_MCP_BOARD）', (t) => {
  const dirA = mkdtempSync(join(tmpdir(), 'd5-mcp-m-'))
  t.after(() => rmSync(dirA, { recursive: true, force: true }))
  const { out } = drive(dirA, [rpc(9, 'bogus/method')])
  assert.equal(respOf(out, 9).error.code, -32601)
  // board 透传：显式板文件可达
  const dirB = mkdtempSync(join(tmpdir(), 'd5-mcp-b-'))
  t.after(() => rmSync(dirB, { recursive: true, force: true }))
  mkdirSync(join(dirB, '.expert-taskboards'), { recursive: true })
  const board = join(dirB, '.expert-taskboards', 'proj.json')
  writeFileSync(board, JSON.stringify({ tasks: {}, seq: 0, revision: 0 }))
  const env = { DSH_TASKBOARD_MCP_BOARD: board, DSH_TASKBOARD_MCP_WRITES: '1' }
  const { out: out2 } = drive(dirB, [rpc(1, 'tools/call', { name: 'taskboard_create', arguments: { title: '定向板任务' } })], env)
  const receipt = JSON.parse(respOf(out2, 1).result.content[0].text)
  assert.equal(receipt.ok, true)
  assert.ok(Object.keys(JSON.parse(readFileSync(board, 'utf-8')).tasks).length === 1, '写入落在 --board 指定板')
})

test('方向5-mcp list_experts：deployed roster（真 schema）真断言 + bundled-core 兜底', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'd5-mcp-roster-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // ① 兜底：DSH_TASKBOARD_MCP_SKILL_DIR 指向无 roster 的 fixture 技能目录
  const bareDir = join(dir, 'skill-bare')
  mkdirSync(join(bareDir, 'experts'), { recursive: true })
  writeFileSync(join(bareDir, 'experts', 'fallback.md'), '---\nname: 兜底专家\n---\n正文')
  const { out } = drive(dir, [rpc(1, 'tools/call', { name: 'list_experts', arguments: {} })], { DSH_TASKBOARD_MCP_SKILL_DIR: bareDir })
  const text = respOf(out, 1).result.content[0].text
  assert.ok(text.includes('未部署') && text.includes('bundled-core 兜底'), text)
  assert.ok(text.includes('兜底专家'), `bundled 兜底扫描 fixture experts/：${text}`)
  // ② deployed merged roster（真实 schema：core[] + sources[].files[]，与 lib/tools.js
  //    rosterCandidates 逐字段同口径）——经 DSH_TASKBOARD_MCP_SKILL_DIR 注入做 CI 真断言：
  //    disabled/shadowed 标注与来源补全必须在列。
  const deployedDir = join(dir, 'skill-deployed')
  mkdirSync(join(deployedDir, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(deployedDir, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({
    core: [{ source: 'bundled-core', file: 'a.md', name: '甲' }],
    sources: [{ id: 'custom', files: [
      { file: 'b.md', name: '乙', disabled: true },
      { file: 'c.md', name: '丙', shadowed: true },
      { file: 'd.md', title: '丁（无名只有title）' },
    ] }],
  }))
  const { out: out2 } = drive(dir, [rpc(2, 'tools/call', { name: 'list_experts', arguments: {} })], { DSH_TASKBOARD_MCP_SKILL_DIR: deployedDir })
  const text2 = respOf(out2, 2).result.content[0].text
  assert.ok(text2.includes('deployed merged roster'), text2)
  assert.ok(text2.includes('[bundled-core] 甲'), text2)
  assert.ok(text2.includes('[custom] 乙（已停用）'), text2)
  assert.ok(text2.includes('[custom] 丙（shadowed）'), text2)
  assert.ok(text2.includes('[custom] 丁（无名只有title）'), 'files 缺 source 补所属来源 id', text2)
  // ③ 损坏 roster：如实报损坏 + 兜底（绝不静默当空板）
  const corruptDir = join(dir, 'skill-corrupt')
  mkdirSync(join(corruptDir, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(corruptDir, 'expert-sources', 'merged', 'roster.json'), '{broken json')
  const { out: out3 } = drive(dir, [rpc(3, 'tools/call', { name: 'list_experts', arguments: {} })], { DSH_TASKBOARD_MCP_SKILL_DIR: corruptDir })
  const text3 = respOf(out3, 3).result.content[0].text
  assert.ok(text3.includes('读取失败') && text3.includes('bundled-core 兜底'), text3)
})

test('方向5-card AgentCard：bundled 兜底 11 skills、必备字段、--out 落盘、version=package.json、deployed 源真断言', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'd5-card-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outPath = join(dir, 'agent-card.json')
  const r = spawnSync('node', [CARD, '--out', outPath, '--url', ''], { encoding: 'utf-8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(outPath))
  const card = JSON.parse(readFileSync(outPath, 'utf-8'))
  assert.equal(card.name, 'dsh-expert-orchestrator')
  assert.ok(card.description && card.protocolVersion && card.capabilities)
  // version=package.json 单一事实源（② 评审项断言：不硬编码）
  const pkgVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')).version
  assert.equal(card.version, pkgVersion, `card.version 须跟随 package.json（=${pkgVersion}）`)
  assert.ok(Array.isArray(card.skills) && card.skills.length >= 11, `bundled 兜底 ≥11 skills：${card.skills.length}`)
  for (const s of card.skills) {
    assert.ok(s.id && s.name && s.description && Array.isArray(s.tags), 'AgentSkill 必备字段')
    assert.ok(s.tags.includes('expert'))
  }
  assert.equal(card['dsh:rosterSource'], 'bundled-core-fallback')
  // deployed merged roster（真 schema）经 --skill-dir 注入 → CI 真断言：disabled/shadowed
  // 过滤、来源补全、rosterSource 如实切换（④ 评审项：此前该分支无真断言）。
  const deployedDir = join(dir, 'skill-deployed')
  mkdirSync(join(deployedDir, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(deployedDir, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({
    core: [{ source: 'bundled-core', file: 'a.md', name: '甲' }],
    sources: [{ id: 'custom', files: [
      { file: 'b.md', name: '乙', disabled: true },
      { file: 'c.md', name: '丙', shadowed: true },
    ] }],
  }))
  const deployedOut = join(dir, 'agent-card-deployed.json')
  const r2 = spawnSync('node', [CARD, '--skill-dir', deployedDir, '--out', deployedOut], { encoding: 'utf-8' })
  assert.equal(r2.status, 0, r2.stderr)
  const card2 = JSON.parse(readFileSync(deployedOut, 'utf-8'))
  assert.equal(card2['dsh:rosterSource'], 'deployed-merged', 'deployed roster 源如实切换')
  assert.deepEqual(card2.skills.map((s) => s.name), ['甲'], 'disabled/shadowed 过滤，仅甲入卡')
  assert.ok(card2.skills[0].tags.includes('custom') === false && card2.skills[0].tags.includes('bundled-core'), card2.skills[0].tags)
  // 损坏 roster → 如实回落 bundled 兜底（不静默当空卡）；fixture 技能目录自带 experts/
  // 一位兜底专家，验证兜底扫描链路本身工作。
  const corruptDir = join(dir, 'skill-corrupt')
  mkdirSync(join(corruptDir, 'expert-sources', 'merged'), { recursive: true })
  mkdirSync(join(corruptDir, 'experts'), { recursive: true })
  writeFileSync(join(corruptDir, 'experts', 'fallback.md'), '---\nname: 兜底专家\n---\n正文')
  writeFileSync(join(corruptDir, 'expert-sources', 'merged', 'roster.json'), '{broken json')
  const r3 = spawnSync('node', [CARD, '--skill-dir', corruptDir], { encoding: 'utf-8' })
  assert.equal(r3.status, 0, r3.stderr)
  const card3 = JSON.parse(r3.stdout)
  assert.equal(card3['dsh:rosterSource'], 'bundled-core-fallback', '损坏 roster 如实回落兜底')
  assert.deepEqual(card3.skills.map((s) => s.name), ['兜底专家'], '兜底扫描 fixture experts/ 生效')
})
