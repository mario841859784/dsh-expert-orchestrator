// test/taskboard-attempt-owner-bind.selftest.mjs — T14 代际 owner 绑定自测（node:test，零依赖）。
// 覆盖验收 a–d：a) env 关闭（缺省）全路径（claim --attempt/reassign 双通道/done --by/vote/
//    progress/own）与固定基线 eb756a7（T13 交付版）双版本同输入逐字节一致（stdout+exit code+
//    事件 args 键集+attempt_owner 字段不落档）；b) 开启时绑定落档（attempt_owner=落定 owner）+
//    事件 args 留痕（claim/reassign）、不符身份全部具名拒 attempt_owner_mismatch（零写零事件，
//    done --by/vote --by）；c) 旧板无字段（env 关闭期建板）开启 env 不误拒（done/peer proof）；
//    d) selftest ≥4 用例。
// T20 增补：e) claim --attempt 接管面显式重绑留痕（开启时 stdout 提示行+事件 args
//    attempt_owner_prev 留痕、--json 信封不被提示行污染、revision 恰+1；env 关闭同接管脚本
//    与基线 eb756a7 双版本逐字节）；d) 静态断言含 check_attempt 签名与绑定单点 regex。
// R1 口径如实声明：attempt_owner 绑定与 --by/--owner 申报均为板面自报（CLI 无鉴权），板内
// 一致性校验防误用非防伪造。
// 全部用例跑在 tmp 隔离目录（mkdtemp），不触碰本仓任务板。署名：backend-engineer
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
const BIND = 'DSH_EXPERT_ATTEMPT_BIND_OWNER'
const BASELINE = 'eb756a7' // T13 交付版（T14 动工前固定基线，HEAD 推进后仍钉此 commit）

const runTb = (cwd, args, { tb = TASKBOARD, extraEnv = {}, omitEnv = [] } = {}) => {
  const env = { ...process.env }
  for (const k of omitEnv) delete env[k]
  Object.assign(env, extraEnv)
  const r = spawnSync('python3', [tb, ...args], { cwd, encoding: 'utf-8', env })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

// exposure-crypto 收口轮（N2）显式 additive 契约增量：写命令 --json 信封顶层 event_seq（旧基线
// eb756a7 无此键）——比对前双版本同函数剥除，其余输出仍逐字节一致。
const stripAuditAdditions = (s) => s
  .replace(/, "event_seq": \d+\}/g, '}')
  .replace(/("cmd": "create", "data": )\{"task": \{.*?\}\}, ("revision")/g, '$1{}, $2')

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t14-bind-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l))
const norm = (s) => s.replace(/"(created|updated)": \d+/g, '"$1": T')
  .replace(/"(time|ts)": "[^"]*"/g, '"$1": "T"')
  .replace(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g, '[T]')

// ── a) env 关闭：全路径与基线 eb756a7 双版本逐字节回归（stdout+exit+事件 args 键集+字段不落档）──
test('T14-a env 关闭：claim --attempt/reassign 双通道/done --by/vote/progress/own 全路径与基线 eb756a7 逐字节一致（含事件 args 形状、attempt_owner 不落档）', (t) => {
  const head = spawnSync('git', ['show', `${BASELINE}:skills/expert-orchestration/tools/taskboard.py`],
    { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, `git show ${BASELINE} 基线可读`)
  const headPy = join(mkdtempSync(join(tmpdir(), 't14-head-')), 'taskboard_head.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const OPTS = { omitEnv: [BIND] } // 双版本均强制真空关闭（不继承会话遗留）
  const script = [
    ['create', '任务A', '--scope', 'src'],
    ['create', '任务B', '--scope', 'src'],
    ['create', 'rv', '--kind', 'review'],
    ['claim', 'T1', '甲', '--attempt', 'gen1'],
    ['progress', 'T1', '推进中', '--attempt', 'gen1'],
    ['own', 'T1', 'src/a.txt', '--attempt', 'gen1'],
    ['--json', 'show', 'T1'],
    ['--json', 'reassign', 'T1', 'gen2', '--owner', '乙'],
    ['--json', 'show', 'T1'],
    ['done', 'T1', '--by', '乙', '--attempt', 'gen2'],
    ['claim', 'T2', '丙', '--attempt', 'gen3'],
    ['--json', 'vote', 'T2', '--by', '丙', '--score', '1', '--attempt', 'gen3'],
  ]
  const dirCur = makeBoardDir(t, 'a-cur')
  const dirOld = makeBoardDir(t, 'a-old')
  const rc = script.map((args) => runTb(dirCur, args, { ...OPTS }))
  const ro = script.map((args) => runTb(dirOld, args, { ...OPTS, tb: headPy }))
  for (let i = 0; i < script.length; i++) {
    // --json reassign/vote 信封顶层 event_seq 为 N2 additive 键（旧基线无）——剥除后比，其余逐字节
    assert.equal(norm(stripAuditAdditions(rc[i].stdout)), norm(stripAuditAdditions(ro[i].stdout)), `逐字节一致：${script[i].join(' ')}`)
    assert.equal(rc[i].code, ro[i].code, `exit code 一致：${script[i].join(' ')}`)
  }
  // attempt_owner 字段不落档（env 关）
  const t1 = rc[6].json.data.task
  assert.equal(t1.attempt_owner, undefined, 'env 关闭 claim --attempt 不落 attempt_owner')
  const t1r = rc[8].json.data.task
  assert.equal(t1r.attempt_owner, undefined, 'env 关闭 reassign 不落 attempt_owner')
  // 事件流：type 序列与 args 键集逐条一致（事件形状零变化）
  const evC = eventsOf(dirCur)
  const evO = eventsOf(dirOld)
  assert.equal(evC.length, evO.length)
  for (let i = 0; i < evC.length; i++) {
    assert.equal(evC[i].type, evO[i].type, `事件 ${i} type 一致`)
    assert.deepEqual(Object.keys(evC[i].args || {}).sort(), Object.keys(evO[i].args || {}).sort(), `事件 ${i} args 键集一致`)
  }
})

// ── b) 开启：绑定落档 + 事件 args 留痕 + reassign 重绑 ─────────────────────────
test('T14-b 开启：claim --attempt/reassign 双通道落 attempt_owner=落定 owner，事件 args 留痕，reassign 重绑', (t) => {
  const dir = makeBoardDir(t, 'b-bind')
  const py = (args, opts = {}) => runTb(dir, args, { extraEnv: { [BIND]: '1' }, ...opts })
  py(['create', '任务A', '--scope', 'src'])
  py(['create', '任务B', '--scope', 'src'])
  // claim --attempt：attempt_owner=落定 owner（--owner 甲）
  assert.equal(py(['--json', 'claim', 'T1', '甲', '--attempt', 'gen1']).json.ok, true)
  const t1 = py(['--json', 'show', 'T1']).json.data.task
  assert.equal(t1.attempt_owner, '甲')
  assert.equal(t1.attempt_id, 'gen1')
  // claim 事件 args 留痕 attempt_owner
  const claimEvt = eventsOf(dir).find((e) => e.type === 'claim' && e.args.attempt === 'gen1')
  assert.ok(claimEvt, 'claim 事件在场')
  assert.equal(claimEvt.args.attempt_owner, '甲')
  // 编排者通道 reassign --owner 乙：重绑 attempt_owner=乙
  assert.equal(py(['--json', 'reassign', 'T1', 'gen2', '--owner', '乙']).json.ok, true)
  const t1r = py(['--json', 'show', 'T1']).json.data.task
  assert.equal(t1r.attempt_owner, '乙')
  assert.equal(t1r.attempt_id, 'gen2')
  const reEvt = eventsOf(dir).find((e) => e.type === 'reassign' && e.args.attempt_id === 'gen2')
  assert.ok(reEvt, 'reassign 事件在场')
  assert.equal(reEvt.args.attempt_owner, '乙')
  // peer 通道不带 --owner：owner 保持乙 → 绑定保持乙
  assert.equal(py(['--json', 'reassign', 'T1', 'auto', '--attempt', 'gen2']).json.ok, true)
  const t1p = py(['--json', 'show', 'T1']).json.data.task
  assert.equal(t1p.attempt_owner, '乙')
  const reEvt2 = eventsOf(dir).find((e) => e.type === 'reassign' && e.args.generated === true)
  assert.equal(reEvt2.args.attempt_owner, '乙')
  // claim 无 --attempt（不建代际）：不落 attempt_owner（任务 B 无 owner、无代际）
  py(['claim', 'T2', '丁'])
  assert.equal(py(['--json', 'show', 'T2']).json.data.task.attempt_owner, undefined)
})

// ── b2) 开启：不符身份全部具名拒 attempt_owner_mismatch（零写零事件）；相符放行；未声明不拒 ──
test('T14-b2 开启：done --by/vote --by 不符具名拒零写零事件、相符放行、未声明身份不拒（R1 口径）', (t) => {
  const dir = makeBoardDir(t, 'b2-mismatch')
  const py = (args, opts = {}) => runTb(dir, args, { extraEnv: { [BIND]: '1' }, ...opts })
  py(['create', '任务A', '--scope', 'src'])
  py(['create', 'rv', '--kind', 'review', '--quorum-m', '2'])
  py(['claim', 'T1', '甲', '--attempt', 'gen1'])
  py(['claim', 'T2', '乙', '--attempt', 'gen2'])
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  const tasksBefore = JSON.stringify(boardOf(dir).tasks)
  // done --by 不符 → 具名拒
  const r = py(['--json', 'done', 'T1', '收尾', '--by', 'mallory', '--attempt', 'gen1'])
  assert.equal(r.json.error, 'attempt_owner_mismatch')
  assert.equal(r.json.attempt, 'gen1')
  assert.equal(r.json.attempt_owner, '甲')
  assert.equal(r.json.declared, 'mallory')
  assert.match(r.json.hint, /attempt_owner/)
  // 零写零事件：revision/事件流/任务 JSON 零变化
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  assert.equal(JSON.stringify(boardOf(dir).tasks), tasksBefore)
  // vote --by 不符 → 同拒
  const r2 = py(['--json', 'vote', 'T2', '--by', 'mallory', '--score', '1', '--attempt', 'gen2'])
  assert.equal(r2.json.error, 'attempt_owner_mismatch')
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  // done --by 相符 → 放行
  assert.equal(py(['--json', 'done', 'T1', '完成', '--by', '甲', '--attempt', 'gen1']).json.ok, true)
  // vote --by 相符 → 放行（m=1 单票 pass 完单）
  assert.equal(py(['--json', 'vote', 'T2', '--by', '乙', '--score', '1', '--attempt', 'gen2']).json.ok, true)
  // done 不带 --by（未声明身份不可核）→ 不拒（R1：一致性校验防误用非防伪造）
  py(['create', '任务C'])
  py(['claim', 'T3', '丙', '--attempt', 'gen3'])
  assert.equal(py(['done', 'T3', '无 by 完单', '--attempt', 'gen3']).code, 0)
  // progress/own 无身份声明参数 → 开启 env 亦不受影响
  py(['create', '任务D'])
  py(['claim', 'T4', '丁', '--attempt', 'gen4'])
  assert.equal(py(['progress', 'T4', '推进', '--attempt', 'gen4']).code, 0)
  assert.equal(py(['own', 'T4', 'd.txt', '--attempt', 'gen4']).code, 0)
})

// ── c) 旧板无字段：env 关闭期建板（无 attempt_owner），开启 env 不误拒 ───────────
test('T14-c 旧板无字段开启 env 不误拒：done --by 任意身份放行、peer proof 放行（字段缺席=不校验双保险）', (t) => {
  const dir = makeBoardDir(t, 'c-oldboard')
  // 先 env 关闭建板（不落 attempt_owner 字段），再开启 env 操作
  const py0 = (args) => runTb(dir, args, { omitEnv: [BIND] })
  py0(['create', '任务A', '--scope', 'src'])
  py0(['create', 'rv', '--kind', 'review', '--quorum-m', '2'])
  py0(['claim', 'T1', '甲', '--attempt', 'gen1'])
  py0(['claim', 'T2', '乙', '--attempt', 'gen2'])
  assert.equal(boardOf(dir).tasks.T1.attempt_owner, undefined, '旧板确认无 attempt_owner 字段')
  // 开启 env：done --by 与绑定漂移身份（旧板无绑定可核）→ 不误拒
  const py = (args) => runTb(dir, args, { extraEnv: { [BIND]: '1' } })
  assert.equal(py(['--json', 'done', 'T1', '完成', '--by', '任何人', '--attempt', 'gen1']).json.ok, true)
  assert.equal(py(['--json', 'vote', 'T2', '--by', '任何人', '--score', '1', '--attempt', 'gen2']).json.ok, true)
  // peer proof 通道：旧板无字段 → 不误拒（字段缺席=不校验双保险）
  assert.equal(py(['--json', 'reassign', 'T2', 'auto', '--attempt', 'gen2']).json.ok, true)
  // 重绑后（本代际落了 attempt_owner=乙）再不符申报即恢复执法
  const at = py(['--json', 'show', 'T2']).json.data.task.attempt_id
  const r = py(['--json', 'done', 'T2', 'x', '--by', 'mallory', '--attempt', at])
  assert.equal(r.json.error, 'attempt_owner_mismatch')
  assert.equal(r.json.attempt_owner, '乙')
})

// ── d) 源码静态断言：R1 声明、env 名、缺省关闭语义、单点扩展在场 ─────────────────
test('T14-d 源码静态断言：R1 声明、Q2 env 名、缺省关闭（不落字段不校验）、旧板回退声明在场', (t) => {
  const src = readFileSync(TASKBOARD, 'utf-8')
  assert.match(src, /DSH_EXPERT_ATTEMPT_BIND_OWNER/)
  assert.match(src, /attempt_owner_mismatch/)
  assert.match(src, /防误用非防伪造/)
  assert.match(src, /不落字段不校验/)
  assert.match(src, /旧板无字段/)
  assert.match(src, /def check_attempt\(a, t, caller=_UNSET\)/)
  assert.match(src, /t\['attempt_owner'\] = t\['owner'\]/) // claim 绑定
  assert.match(src, /t\['attempt_owner'\] = a\.owner or t\['owner'\]/) // reassign 绑定
})

// ── e) T20🟡1 对称化：claim --attempt 接管面显式重绑留痕（绑定开启）；env 关闭重绑路径与基线逐字节 ──
test('T20-e 开启：claim --attempt 续代际换人=合法接管面（语义不动）但显式留痕（stdout 提示行+事件 args attempt_owner_prev）；env 关闭同场景与基线 eb756a7 逐字节一致', (t) => {
  const dir = makeBoardDir(t, 'e-takeover')
  const py = (args, opts = {}) => runTb(dir, args, { extraEnv: { [BIND]: '1' }, ...opts })
  py(['create', '任务A', '--scope', 'src'])
  py(['claim', 'T1', '甲', '--attempt', 'gen1'])
  py(['fail', 'T1'])
  py(['retry', 'T1'])
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  // 接管：乙携带同一开放代际认领（绑定开启）→ 仍放行（接管面语义不动），但绑定翻新显式留痕
  const r = py(['claim', 'T1', '乙', '--attempt', 'gen1'])
  const t1 = py(['--json', 'show', 'T1']).json.data.task
  assert.equal(t1.attempt_owner, '乙')
  assert.equal(t1.attempt_id, 'gen1')
  const evt = eventsOf(dir).at(-1)
  assert.equal(evt.type, 'claim')
  assert.equal(evt.args.attempt_owner, '乙')
  assert.equal(evt.args.attempt_owner_prev, '甲', '重绑须在事件 args 显式留痕旧绑定（T20🟡1：无静默行为）')
  assert.match(r.stdout, /attempt_owner 重绑留痕：甲 → 乙/, '人类面输出显式重绑提示行')
  assert.equal(boardOf(dir).revision, rev + 1, '接管=正常一次写（revision 恰 +1）')
  assert.equal(eventsOf(dir).length, evN + 1)
  // --json 信封仍是唯一 stdout 载荷（提示行被 _JsonSink 吞掉，不污染机器消费面）
  py(['fail', 'T1']); py(['retry', 'T1'])
  const rj = py(['--json', 'claim', 'T1', '丙', '--attempt', 'gen1'])
  assert.equal(rj.json.ok, true)
  assert.doesNotMatch(rj.stdout, /重绑留痕/)
  assert.equal(rj.json.data.task.attempt_owner, '丙')
  const evt2 = eventsOf(dir).at(-1)
  assert.equal(evt2.args.attempt_owner_prev, '乙')
  // env 关闭：同接管脚本与基线 eb756a7 双版本逐字节（重绑路径旧行为不破：无提示行、无字段、args 键集不变）
  const head = spawnSync('git', ['show', `${BASELINE}:skills/expert-orchestration/tools/taskboard.py`],
    { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, `git show ${BASELINE} 基线可读`)
  const headPy = join(mkdtempSync(join(tmpdir(), 't20-head-')), 'taskboard_head.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const OPTS = { omitEnv: [BIND] }
  const script = [
    ['create', '任务A', '--scope', 'src'],
    ['claim', 'T1', '甲', '--attempt', 'gen1'],
    ['fail', 'T1'],
    ['retry', 'T1'],
    ['claim', 'T1', '乙', '--attempt', 'gen1'],
    ['--json', 'show', 'T1'],
  ]
  const dirCur = makeBoardDir(t, 'e-cur')
  const dirOld = makeBoardDir(t, 'e-old')
  const rc = script.map((args) => runTb(dirCur, args, { ...OPTS }))
  const ro = script.map((args) => runTb(dirOld, args, { ...OPTS, tb: headPy }))
  for (let i = 0; i < script.length; i++) {
    assert.equal(norm(rc[i].stdout), norm(ro[i].stdout), `逐字节一致：${script[i].join(' ')}`)
    assert.equal(rc[i].code, ro[i].code, `exit code 一致：${script[i].join(' ')}`)
  }
  assert.equal(rc[5].json.data.task.attempt_owner, undefined, 'env 关闭重绑路径不落 attempt_owner')
})
