// test/taskboard-claim-steal.selftest.mjs — work-stealing claim_idle --steal 自测（T16，node:test，零依赖）。
// 覆盖验收 a–e：a) 不带 --steal 与基线 T16_BASELINE 双版本逐字节一致（成功/board_not_idle 全板闸/
//    noop 拒绝/--json data 形状/事件 type=claim args 键集）；b) --steal 命中单事件迁移（ready+owner=X
//    →running+owner=认领方，无中间态）+args 让渡字段（steal:true/previous_owner）+checkpoint 让渡注记
//    +stolen_from 落档+无主候选跳过；c) 双侧空闲闸具名拒零写零事件（steal_owner_active claimant 侧/
//    owner 侧）+反回摆 steal_ping_pong 拒；d) --tags 交集门逐候选跳过与 T13 open-cap 对认领方生效共存；
//    e) 既有语义零回归（本文件与全量 npm test 收口）。
// 全部用例跑在 tmp 隔离目录（mkdtemp），不触碰本仓任务板。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'
const BASELINE = 'efb60c8' // T15 交付版（T16 动工前固定基线，HEAD 推进后仍钉此 commit）

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。
 * opts.extraEnv 逐键注入环境（cap 阈值/执法开关覆盖）；opts.tb 覆盖脚本路径（双版本基线回归）。 */
const runTb = (cwd, args, { extraEnv = {}, omitEnv = [], tb = TASKBOARD } = {}) => {
  const env = { ...process.env }
  for (const k of omitEnv) delete env[k]
  Object.assign(env, extraEnv)
  const r = spawnSync('python3', [tb, ...args], { cwd, encoding: 'utf-8', env })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

// 时间戳归一（双版本逐字节比对用）：created/updated 毫秒值、checkpoint time、人类面 [日期时间]
const norm = (s) => s.replace(/"(created|updated)": \d+/g, '"$1": T')
  .replace(/"(time|ts)": "?\d{13}"?/g, '"$1": "T"')
  .replace(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g, '[T]')

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t16-claim-steal-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .map((l) => JSON.parse(l))
const snapshot = (dir) => readFileSync(join(dir, BOARD_REL)).toString() + '|' +
  readFileSync(join(dir, EVENTS_REL)).toString()

// 基线脚本落 tmp（双版本比对用）；cap/执法 env 一律卸载保证缺省路径
const baselineTb = (t) => {
  const p = join(mkdtempSync(join(tmpdir(), 't16-baseline-')), 'taskboard.py')
  const head = spawnSync('git', ['show', `${BASELINE}:skills/expert-orchestration/tools/taskboard.py`],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(head.status, 0, `git show ${BASELINE} 基线可读`)
  writeFileSync(p, head.stdout)
  t.after(() => rmSync(dirname(p), { recursive: true, force: true }))
  return p
}

const OMIT = ['DSH_EXPERT_ANTISTORM_ENFORCE', 'DSH_EXPERT_PEER_OPEN_CAP', 'DSH_EXPERT_ATTEMPT_BIND']

// 公共布板：T1 ready owner=甲 tags=py；T2 ready 无主；T3 ready owner=甲 tags=py；T4 ready 无主（--json 步用）
const setup = (dir, tb) => {
  assert.equal(runTb(dir, ['create', '任务A', '--owner', '甲', '--tags', 'py'], { tb, omitEnv: OMIT }).code, 0)
  assert.equal(runTb(dir, ['create', '任务B'], { tb, omitEnv: OMIT }).code, 0)
  assert.equal(runTb(dir, ['create', '任务C', '--owner', '甲', '--tags', 'py'], { tb, omitEnv: OMIT }).code, 0)
  assert.equal(runTb(dir, ['create', '任务D'], { tb, omitEnv: OMIT }).code, 0)
}

// ── a) 不带 --steal 与基线双版本逐字节 ──────────────────────────
test('T16-a 缺省路径双版本逐字节：claim_idle 成功/board_not_idle 全板闸/noop 拒/--json 形状/事件 args 与基线一致', (t) => {
  const tbBase = baselineTb(t)
  const dirH = makeBoardDir(t, 'head')
  const dirB = makeBoardDir(t, 'base')
  const dirH2 = makeBoardDir(t, 'head-json')
  const dirB2 = makeBoardDir(t, 'base-json')
  // 两版各自独立布板（同脚本同序）；机器面与人类面分板——任一成功认领即产生 running 封锁全板
  setup(dirH, TASKBOARD)
  setup(dirB, tbBase)
  setup(dirH2, TASKBOARD)
  setup(dirB2, tbBase)
  const script = [
    // 成功：认领无主 T2（人类面）
    (tb) => ['claim_idle', '乙', 'T2'],
    // 已有 owner 候选 → noop 拒（T1 owner=甲、T3 owner=甲）
    (tb) => ['claim_idle', '乙', 'T1', 'T3'],
    // 制造 running：丙认领 T3 → 全板闸 board_not_idle
    (tb) => ['claim', 'T3', '丙'],
    (tb) => ['claim_idle', '乙', 'T2'],
  ]
  for (const step of script) {
    const h = runTb(dirH, step(TASKBOARD), { omitEnv: OMIT })
    const b = runTb(dirB, step(tbBase), { omitEnv: OMIT })
    assert.equal(norm(h.stdout), norm(b.stdout), `逐字节（norm）：${step(TASKBOARD).join(' ')}`)
    assert.equal(h.code, b.code, `退出码：${step(TASKBOARD).join(' ')}`)
  }
  // 机器面（独立分板）：--json data 形状与基线逐字节一致
  const j = runTb(dirH2, ['--json', 'claim_idle', '乙', 'T4'], { omitEnv: OMIT })
  const jb = runTb(dirB2, ['--json', 'claim_idle', '乙', 'T4'], { omitEnv: OMIT, tb: tbBase })
  assert.equal(norm(j.stdout), norm(jb.stdout), '逐字节（norm）：--json claim_idle T4')
  assert.equal(j.code, jb.code)
  // HEAD 精断：--json data 形状与事件 args 键集（缺省不带 --steal 时形状与基线一致）
  assert.deepEqual(Object.keys(j.json.data ?? {}).sort(), ['claimed', 'skipped'])
  const claimEvents = eventsOf(dirH).filter((e) => e.type === 'claim')
  assert.equal(claimEvents.length, 1) // T2 单事件原子认领
  for (const e of claimEvents.concat(eventsOf(dirH2).filter((e) => e.type === 'claim'))) {
    assert.deepEqual(Object.keys(e.args).sort(), ['ids', 'owner'])
    assert.equal(e.args.owner, '乙')
  }
})

// ── b) --steal 命中：单事件迁移+让渡留痕+无主候选跳过 ──────────────
test('T16-b --steal 命中：ready+owner=甲→running owner=乙 无中间态；args steal/previous_owner；checkpoint 让渡注记；stolen_from 落档；无主候选跳过', (t) => {
  const dir = makeBoardDir(t, 'steal-hit')
  setup(dir, TASKBOARD)
  const evBefore = eventsOf(dir).length
  const r = runTb(dir, ['claim_idle', '乙', '--tags', 'py', '--steal', 'T2', 'T3'], { omitEnv: OMIT })
  assert.equal(r.code, 0, `--steal 成功退出 0：${r.stdout}`)
  // T3 迁移终态（无中间态）；stolen_from 落档=上一手 owner；checkpoint 让渡注记
  const t3 = boardOf(dir).tasks.T3
  assert.equal(t3.status, 'running')
  assert.equal(t3.owner, '乙')
  assert.equal(t3.stolen_from, '甲')
  const note = (t3.checkpoints ?? []).map((c) => c.note).join('\n')
  assert.ok(/让渡/.test(note) && note.includes('甲') && note.includes('乙'), `checkpoint 让渡注记：${note}`)
  // 无主 T2 不在 --steal 语义内：原样未动
  const t2 = boardOf(dir).tasks.T2
  assert.equal(t2.status, 'ready')
  assert.equal(t2.owner ?? '', '')
  // 单事件 type=claim，args 增 steal:true/previous_owner（既有键不丢）
  const newEvents = eventsOf(dir).slice(evBefore)
  assert.deepEqual(newEvents.map((e) => e.type), ['claim'])
  assert.equal(newEvents[0].args.steal, true)
  assert.deepEqual(newEvents[0].args.previous_owner, { T3: '甲' })
  assert.deepEqual(Object.keys(newEvents[0].args).filter((k) => ['owner', 'ids', 'tags', 'steal', 'previous_owner'].includes(k)).sort(),
    ['ids', 'owner', 'previous_owner', 'steal', 'tags'])
  assert.deepEqual(newEvents[0].args.ids, ['T2', 'T3'])
  // revision 恰 +1（单事件原子认领）
  assert.ok(/revision=\d+\n$/.test(r.stdout))
})

// ── c) 双侧空闲闸：steal_owner_active 具名拒零写零事件 ─────────────
test('T16-c 双侧空闲闸：认领方有 running 具名拒；被窃 owner 有 running 具名拒；均零写零事件', (t) => {
  // claimant 侧：乙名下有 running → 整轮拒
  const dirC = makeBoardDir(t, 'gate-claimant')
  setup(dirC, TASKBOARD)
  assert.equal(runTb(dirC, ['create', '任务D', '--owner', '乙'], { omitEnv: OMIT }).code, 0)
  assert.equal(runTb(dirC, ['claim', 'T4', '乙'], { omitEnv: OMIT }).code, 0)
  const snapC = snapshot(dirC)
  const rc = runTb(dirC, ['claim_idle', '乙', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT })
  assert.equal(rc.code, 1)
  assert.ok(/steal_owner_active/.test(rc.stdout), `具名拒：${rc.stdout}`)
  assert.equal(snapshot(dirC), snapC, '零写零事件（claimant 侧）')
  // owner 侧：被窃任务 owner 甲名下有 running → 整轮拒
  const dirO = makeBoardDir(t, 'gate-owner')
  setup(dirO, TASKBOARD)
  assert.equal(runTb(dirO, ['claim', 'T1', '甲', '--tags', 'py'], { omitEnv: OMIT }).code, 0) // 甲 T1 → running
  const snapO = snapshot(dirO)
  const ro = runTb(dirO, ['claim_idle', '乙', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT })
  assert.equal(ro.code, 1)
  assert.ok(/steal_owner_active/.test(ro.stdout), `具名拒：${ro.stdout}`)
  assert.equal(snapshot(dirO), snapO, '零写零事件（owner 侧）')
})

// ── c2) 反回摆：不得认领上一手 owner 为自己的任务 ─────────────────
test('T16-c2 反回摆：甲→乙 让渡后甲认回 steal_ping_pong 具名拒零写零事件；第三方丙可接手（stolen_from 翻新为乙）', (t) => {
  const dir = makeBoardDir(t, 'pingpong')
  setup(dir, TASKBOARD)
  assert.equal(runTb(dir, ['claim_idle', '乙', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT }).code, 0) // 甲→乙
  assert.equal(runTb(dir, ['fail', 'T3'], { omitEnv: OMIT }).code, 0)
  assert.equal(runTb(dir, ['retry', 'T3'], { omitEnv: OMIT }).code, 0) // 回 ready（owner 乙、stolen_from 甲）
  assert.equal(boardOf(dir).tasks.T3.status, 'ready')
  const snap = snapshot(dir)
  const r = runTb(dir, ['claim_idle', '甲', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT })
  assert.equal(r.code, 1)
  assert.ok(/steal_ping_pong/.test(r.stdout), `具名拒：${r.stdout}`)
  assert.equal(snapshot(dir), snap, '零写零事件（回摆拒）')
  assert.equal(runTb(dir, ['claim_idle', '丙', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT }).code, 0) // 第三方可接手
  const t3 = boardOf(dir).tasks.T3
  assert.equal(t3.owner, '丙')
  assert.equal(t3.stolen_from, '乙') // 上一手翻新
})

// ── d) tags 交集门与 T13 open-cap 对认领方生效共存 ────────────────
test('T16-d 共存：--steal 候选 tags 与声明无交集逐候选跳过（全跳过 noop）；--tags 交集命中可窃；open-cap 对认领方生效具名拒', (t) => {
  const dir = makeBoardDir(t, 'coexist')
  setup(dir, TASKBOARD)
  // 无声明：带 tags 候选一律跳过 → 全跳过 claim_idle_noop（零写）
  const snap = snapshot(dir)
  const r1 = runTb(dir, ['claim_idle', '乙', '--steal', 'T3'], { omitEnv: OMIT })
  assert.equal(r1.code, 1)
  assert.ok(/claim_idle_noop/.test(r1.stdout) && /tag_mismatch/.test(r1.stdout), `跳过：${r1.stdout}`)
  assert.equal(snapshot(dir), snap)
  // 声明交集命中：可窃
  assert.equal(runTb(dir, ['claim_idle', '乙', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT }).code, 0)
  assert.equal(boardOf(dir).tasks.T3.owner, '乙')
  // open-cap 对认领方生效（分板独立场景）：cap=1 且乙名下已有 open（T5 ready 未 running，
  // claimant 侧闸不先触发）→ 逐候选跳过 → 整轮具名拒
  const dir2 = makeBoardDir(t, 'coexist-cap')
  setup(dir2, TASKBOARD)
  assert.equal(runTb(dir2, ['create', '任务E', '--owner', '乙'], { omitEnv: OMIT }).code, 0)
  const snap2 = snapshot(dir2)
  const r2 = runTb(dir2, ['--json', 'claim_idle', '乙', '--tags', 'py', '--steal', 'T1'],
    { extraEnv: { DSH_EXPERT_ANTISTORM_ENFORCE: '1', DSH_EXPERT_PEER_OPEN_CAP: '1' }, omitEnv: OMIT })
  assert.equal(r2.code, 1)
  assert.ok(/open_cap_exceeded/.test(r2.stdout), `cap 具名拒：${r2.stdout}`)
  assert.equal(snapshot(dir2), snap2, 'cap 拒零写零事件')
})

// ── e) 语义面直断：--steal 不带 running 时全板闸收窄（他人在途不封锁）─────────
test('T16-e 空闲闸收窄：他人 running 在途不封锁 --steal（认领方本人无 running 即可），缺省路径仍全板闸 board_not_idle', (t) => {
  const dir = makeBoardDir(t, 'narrow')
  setup(dir, TASKBOARD)
  assert.equal(runTb(dir, ['claim', 'T1', '丙', '--tags', 'py'], { omitEnv: OMIT }).code, 0) // 丙 T1 running（他人）
  // 缺省路径：全板闸逐字节不变 → board_not_idle
  const r1 = runTb(dir, ['claim_idle', '乙', 'T2'], { omitEnv: OMIT })
  assert.equal(r1.code, 1)
  assert.ok(/board_not_idle/.test(r1.stdout), `缺省全板闸：${r1.stdout}`)
  // --steal：闸收窄为双侧（丙在途与本轮无涉）→ 命中
  assert.equal(runTb(dir, ['claim_idle', '乙', '--tags', 'py', '--steal', 'T3'], { omitEnv: OMIT }).code, 0)
  assert.equal(boardOf(dir).tasks.T3.owner, '乙')
})
