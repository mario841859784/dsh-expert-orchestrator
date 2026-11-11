// 方向 4 代理身份与信任链自测：approve/reject --by 批准人审计面（node:test，零依赖）。
// 覆盖面：
// - a) 执法（审计）面：--by 落检查点注记 + 事件 args.by + 人读输出声明行；
// - b) 缺省兼容：不带 --by 与基线 43b9d20（方向 4 改动未入）同输入行为一致
//     （无 checkpoints 键、事件 args 形状逐键一致 {}、stdout+exit 一致——时间戳外
//     稳定面比对）；
// - c) --by 空白归一：纯空白视同未声明（与 M1 created_by 入口归一同口径）。
// R1 口径如实声明：--by 为板面自报审计面（CLI 无鉴权，防误用不防伪造）——机制价值在
// 溯源（provenance）而非防伪；「代理转达的批准不可信」是协议纪律（SKILL.md §2），工具面
// 无法区分人与代理调用（能写板文件者同可伪造声明，与 T7/T14 同信任级别）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const TASKBOARD = fileURLToPath(new URL('../skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BOARD_REL = join('.expert-taskboards', 'default.json')
const EVENTS_REL = BOARD_REL + '.events.jsonl'

const runTb = (cwd, args, { tb = TASKBOARD, extraEnv = {}, omitEnv = [] } = {}) => {
  const env = { ...process.env }
  for (const k of omitEnv) delete env[k]
  Object.assign(env, extraEnv)
  const r = spawnSync('python3', [tb, ...args], { cwd, encoding: 'utf-8', env })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `d4-identity-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const taskById = (dir, id) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8')).tasks[id]
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l))

test('方向4-a approve/reject --by：检查点注记 + 事件 args.by + 人读声明行', (t) => {
  const dir = makeBoardDir(t, 'audit')
  runTb(dir, ['create', '草案A', '--draft'])
  const ar = runTb(dir, ['approve', 'T1', '--by', '用户（在场）'])
  assert.equal(ar.code, 0)
  assert.ok(ar.stdout.includes('批准人: 用户（在场）'), ar.stdout)
  const t1 = taskById(dir, 'T1')
  assert.equal(t1.status, 'ready', '批准照常生效（审计面不改变状态机）')
  const note = (t1.checkpoints ?? []).find((c) => c.note.includes('批准人声明'))
  assert.ok(note, '检查点注记落档')
  assert.ok(note.note.includes('批准者≠草案创建代理本人') && note.note.includes('代理转达的批准不可信'), note.note)
  const approveEvents = eventsOf(dir).filter((e) => e.type === 'approve')
  assert.equal(approveEvents.length, 1)
  assert.equal(approveEvents[0].args.by, '用户（在场）', '事件 args.by 落档')
  // reject --by 同口径
  runTb(dir, ['create', '草案B', '--draft'])
  const rr = runTb(dir, ['reject', 'T2', '--by', '编排者'])
  assert.equal(rr.code, 0)
  assert.ok(rr.stdout.includes('否决人: 编排者'), rr.stdout)
  assert.equal(taskById(dir, 'T2').status, 'rejected')
  const rejectEvents = eventsOf(dir).filter((e) => e.type === 'reject')
  assert.equal(rejectEvents[0].args.by, '编排者')
  assert.ok((taskById(dir, 'T2').checkpoints ?? []).some((c) => c.note.includes('否决人声明')), '否决检查点注记')
})

test('方向4-b 缺省兼容：不带 --by 与基线 43b9d20 行为一致（无 checkpoints 键、事件 args 形状 {}）', (t) => {
  const head = spawnSync('git', ['show', '43b9d20:skills/expert-orchestration/tools/taskboard.py'], { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, 'git show 43b9d20 基线可读（方向 4 改动前的 taskboard.py）')
  const headPy = join(mkdtempSync(join(tmpdir(), 'd4-base-')), 'taskboard_base.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const steps = (dir, tb) => {
    runTb(dir, ['create', '草案A', '--draft'], { tb })
    const ar = runTb(dir, ['approve', 'T1'], { tb })
    runTb(dir, ['create', '草案B', '--draft'], { tb })
    const rr = runTb(dir, ['reject', 'T2'], { tb })
    return { ar, rr }
  }
  const dirA = makeBoardDir(t, 'base')
  const dirB = makeBoardDir(t, 'work')
  const ra = steps(dirA, headPy)
  const rb = steps(dirB, TASKBOARD)
  // stdout 稳定面（去 revision 尾行）+ exit code 一致
  const strip = (s) => s.split('\n').filter((l) => !l.startsWith('revision=')).join('\n')
  assert.equal(strip(rb.ar.stdout), strip(ra.ar.stdout))
  assert.equal(strip(rb.rr.stdout), strip(ra.rr.stdout))
  assert.equal(rb.ar.code, ra.ar.code)
  assert.equal(rb.rr.code, ra.rr.code)
  // 任务对象：无 checkpoints 键（与旧版形状一致）
  assert.equal('checkpoints' in taskById(dirB, 'T1'), false)
  assert.equal('checkpoints' in taskById(dirB, 'T2'), false)
  assert.deepEqual(Object.keys(taskById(dirB, 'T1')).sort(), Object.keys(taskById(dirA, 'T1')).sort())
  // 事件 args 形状：approve/reject 均为 {}（逐键一致）
  const evB = eventsOf(dirB).filter((e) => e.type === 'approve' || e.type === 'reject').map((e) => [e.type, e.args])
  const evA = eventsOf(dirA).filter((e) => e.type === 'approve' || e.type === 'reject').map((e) => [e.type, e.args])
  assert.deepEqual(evB, evA)
  assert.deepEqual(evB[0][1], {})
})

test('方向4-c --by 空白归一：纯空白视同未声明（零注记零 args）', (t) => {
  const dir = makeBoardDir(t, 'blank')
  runTb(dir, ['create', '草案A', '--draft'])
  const ar = runTb(dir, ['approve', 'T1', '--by', '   '])
  assert.equal(ar.code, 0)
  assert.ok(!ar.stdout.includes('批准人:'), '空白声明不产生人读行')
  assert.equal('checkpoints' in taskById(dir, 'T1'), false, '空白声明不落注记')
  const approveEvents = eventsOf(dir).filter((e) => e.type === 'approve')
  assert.deepEqual(approveEvents[0].args, {}, '空白声明 args 形状与旧版一致')
})
