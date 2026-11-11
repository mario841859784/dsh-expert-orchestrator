// test/taskboard-open-counts.selftest.mjs — T9 open-counts 反风暴只读查询自测（node:test，零依赖）。
// 覆盖验收 a–c：a) 只读性——执行前后板 revision 与事件流零变化（人读/--json 多次实测），
//    且无锁快照：并发独占 board.lock 期间仍可执行（沿 budget T38-1 降锁先例）；
//    b) --json data 结构稳定 {owner:{count,tasks:[id...]}}；空板/空 owner 输出合法；
//    c) 计数口径：draft 计入、ready/running 计入、终态（done/failed/rejected/escalated）不计入；
//    无主任务归 '' 键（人读面显示（无主））；--json 过滤 owner 存在/不存在均稳定。
// 全部用例跑在 tmp 隔离目录（mkdtemp），不触碰本仓任务板。署名：backend-engineer
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'

const runTb = (cwd, args) => {
  const r = spawnSync('python3', [TASKBOARD, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t9-open-counts-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l))

// ── 混合口径板：draft（代理 scoped 自建）+ ready（有主/无主）+ running + 全终态 ──
const seedMixed = (dir) => {
  const r = []
  r.push(runTb(dir, ['create', '父任务', '--owner', '代理甲', '--scope', 'src']))
  r.push(runTb(dir, ['create', '草案A', '--created-by', '代理甲', '--of', 'T1', '--scope', 'src', '--draft']))  // draft
  r.push(runTb(dir, ['create', '就绪B', '--owner', '甲']))                                            // ready
  r.push(runTb(dir, ['create', '无主C']))                                                             // ready 无主
  r.push(runTb(dir, ['claim', 'T4', '乙']))                                                           // running
  r.push(runTb(dir, ['done', 'T4', '完成']))                                                                        // done（终态）
  r.push(runTb(dir, ['create', '废案D', '--created-by', '代理甲', '--of', 'T1', '--scope', 'src', '--draft']))
  r.push(runTb(dir, ['reject', 'T5']))                                                                // rejected（终态）
  return r
}

test('T9-a 只读性：open-counts 执行前后 revision/事件流零变化；独占 board.lock 期间仍可执行（无锁快照）', (t) => {
  const dir = makeBoardDir(t, 'a')
  seedMixed(dir)
  const rev0 = boardOf(dir).revision
  const ev0 = eventsOf(dir).length
  // 人读 + --json 各执行两次
  const h1 = runTb(dir, ['open-counts'])
  const j1 = runTb(dir, ['--json', 'open-counts'])
  const h2 = runTb(dir, ['open-counts'])
  const j2 = runTb(dir, ['--json', 'open-counts'])
  for (const r of [h1, j1, h2, j2]) assert.equal(r.code, 0, `exit 0: ${r.stdout.slice(0, 80)}`)
  assert.deepEqual(j1.json, j2.json, '--json 输出稳定（除 revision 外逐字节一致）')
  assert.equal(boardOf(dir).revision, rev0, 'revision 零变化')
  assert.equal(eventsOf(dir).length, ev0, '事件流行数零变化')
  assert.equal(j1.json.cmd, 'open-counts')
  assert.equal(j1.json.revision, rev0, '信封 revision=快照 revision')
  // 无锁证明：python 持 board.lock 独占 flock 2 秒期间，open-counts 仍能在 2 秒内完成
  const holder = spawnSync('python3', ['-c', `
import fcntl, subprocess, sys, time
f = open(sys.argv[1], 'a+')
fcntl.flock(f, fcntl.LOCK_EX)
t0 = time.monotonic()
r = subprocess.run(['python3', sys.argv[2], 'open-counts'], capture_output=True, text=True, timeout=5)
print(f"held_elapsed={time.monotonic()-t0:.2f} rc={r.returncode}")
fcntl.flock(f, fcntl.LOCK_UN)
`, join(dir, BOARD_REL + '.lock'), TASKBOARD], { encoding: 'utf-8', timeout: 15000 })
  assert.equal(holder.status, 0, `锁面探针正常退出：${holder.stderr}`)
  const m = /held_elapsed=([\d.]+) rc=(\d+)/.exec(holder.stdout)
  assert.ok(m, `探针输出可解析：${holder.stdout}`)
  assert.equal(Number(m[2]), 0, '持锁期间 open-counts 退出码 0')
  assert.ok(Number(m[1]) < 2, `持锁期间未阻塞（elapsed=${m[1]}s < 2s 持锁时长）`)
  assert.equal(boardOf(dir).revision, rev0, '锁面探针后 revision 仍零变化')
  assert.equal(eventsOf(dir).length, ev0, '锁面探针后事件流仍零变化')
})

test('T9-b/c 计数口径与 --json data 结构：draft 计入、终态不计入、无主归 \'\' 键、owner 过滤、空板合法', (t) => {
  const dir = makeBoardDir(t, 'bc')
  seedMixed(dir)
  const j = runTb(dir, ['--json', 'open-counts'])
  assert.equal(j.code, 0)
  // 口径：draft T2 计入（代理 --draft 草案落盘 owner 为空，批准时才指派 → '' 组）；ready T3（甲）；
  // done T4、rejected T5 终态不计入；无主 ready 已被乙认领故无其他 '' 条目
  assert.deepEqual(j.json.data, {
    '代理甲': { count: 1, tasks: ['T1'] },   // ready 父任务（draft T2 owner 空，不计入本组）
    '甲': { count: 1, tasks: ['T3'] },       // ready
    '': { count: 1, tasks: ['T2'] },         // draft（owner 空）归 '' 键——draft 计入口径实证
  })
  // 人读面：逐 owner 行含计数与任务清单；'' 键显示（无主）；排序稳定（'' 最前）
  const h = runTb(dir, ['open-counts'])
  assert.equal(h.code, 0)
  assert.deepEqual(h.stdout.trim().split('\n'), [
    '（无主）: 1 个开放任务: T2',
    '代理甲: 1 个开放任务: T1',
    '甲: 1 个开放任务: T3',
    'revision=8',  // 末行 revision 尾行（全命令约定）
  ])
  // owner 过滤：存在 → 单 owner 组；不存在 → {count:0,tasks:[]}（空 owner 输出合法）
  const jf = runTb(dir, ['--json', 'open-counts', '甲'])
  assert.deepEqual(jf.json.data, { '甲': { count: 1, tasks: ['T3'] } })
  const jn = runTb(dir, ['--json', 'open-counts', '不存在者'])
  assert.deepEqual(jn.json.data, { '不存在者': { count: 0, tasks: [] } })
  assert.equal(runTb(dir, ['open-counts', '不存在者']).stdout.split('\n')[0], '不存在者: 0 个开放任务')
})

test('T9-b 空板：人读（无开放任务）、--json data={}；全终态板等价空开放集', (t) => {
  const dir = makeBoardDir(t, 'empty')
  const j = runTb(dir, ['--json', 'open-counts'])
  assert.equal(j.code, 0)
  assert.deepEqual(j.json.data, {})
  assert.equal(runTb(dir, ['open-counts']).stdout, '（无开放任务）\nrevision=0\n')
  assert.deepEqual(runTb(dir, ['--json', 'open-counts', '某人']).json.data, { '某人': { count: 0, tasks: [] } })
  // 全终态板：done 后无开放任务，输出与空板同形
  runTb(dir, ['create', '任务A', '--owner', '甲'])
  runTb(dir, ['claim', 'T1', '甲'])
  runTb(dir, ['done', 'T1', '完成'])
  const j2 = runTb(dir, ['--json', 'open-counts'])
  assert.deepEqual(j2.json.data, {})
  assert.equal(runTb(dir, ['open-counts']).stdout.split('\n')[0], '（无开放任务）')
})
