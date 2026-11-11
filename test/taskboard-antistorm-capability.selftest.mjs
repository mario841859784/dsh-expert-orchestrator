// test/taskboard-antistorm-capability.selftest.mjs — T13 反风暴写面执法自测（node:test，零依赖）。
// 覆盖验收 a–d：a) env 关闭（缺省）四写路径（claim/claim_idle/approve 代理草案/reassign peer）
//    与固定基线 594e699（T11 已交付版）双版本同输入逐字节一致（stdout+exit code+事件 args 键集）；
//    b) 执法开启超限具名拒 open_cap_exceeded：零写零事件（revision/事件流零变化）、hint 指
//    taskboard.py open-counts <owner> 探针；c) 执法判定先于任何变更与 save（拒绝前后任务
//    JSON 字段零变化）；d) 三执法点×（未超限放行/超限拒/env 关闭放行）矩阵 + escalation
//    上限：needs_revision 达限拒绝 repair 绕行直升 escalated（escalation_count 落档、retry
//    不清零）、reassign 双通道 escalation_limit_exceeded、vote 僵局落档、claim_idle 逐候选
//    跳过与全超限具名拒、阈值 env 非法值宁拒勿猜。
// R1 口径如实声明：owner/created_by 以板面自报为准（CLI 无鉴权），防误用非防伪造。
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
const ENFORCE = 'DSH_EXPERT_ANTISTORM_ENFORCE'
const CAP = 'DSH_EXPERT_PEER_OPEN_CAP'
const ESC = 'DSH_EXPERT_ESCALATION_LIMIT'

/** 执行 taskboard.py（cwd 隔离到临时目录，env 显式可控）；stdout 单行 JSON 时解析为 json 字段。
 * extraEnv 逐键注入；omitEnv 键从环境删除（保证「关闭」是真空缺省而非继承本会话遗留）。 */
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
  const dir = mkdtempSync(join(tmpdir(), `t13-antistorm-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l))

// ── a) 缺省兼容：env 关闭四写路径与基线双版本逐字节回归 ──────────────────────
test('T13-a env 关闭：claim/claim_idle/approve 代理草案/reassign peer 四路径与基线 594e699 逐字节一致（stdout+exit+事件 args 键集）', (t) => {
  // 固定基线副本（T11 交付版 commit 594e699）落 tmp，双版本跑同一不含执法 env 的命令脚本。
  // 与 T8 先例同理：HEAD 随交付推进后 git show HEAD 会退化为恒真空转，故钉 T13 交付前固定 commit。
  const head = spawnSync('git', ['show', '594e699:skills/expert-orchestration/tools/taskboard.py'],
    { cwd: REPO_ROOT, encoding: 'utf-8' })
  assert.equal(head.status, 0, 'git show 594e699 基线可读')
  const headPy = join(mkdtempSync(join(tmpdir(), 't13-head-')), 'taskboard_head.py')
  writeFileSync(headPy, head.stdout)
  t.after(() => rmSync(headPy, { force: true }))
  const OPTS = { omitEnv: [ENFORCE, CAP, ESC] } // 双版本均强制真空关闭（不继承会话遗留）
  const scenario = (dir, tb) => {
    const py = (args) => runTb(dir, args, { ...OPTS, tb })
    py(['init'])
    py(['create', '任务A', '--scope', 'src'])
    py(['create', '任务B', '--scope', 'src'])
    py(['create', '任务C', '--scope', 'src'])
    py(['claim', 'T1', '甲']) // claim（超 cap=2 数量但 env 关：放行）
    py(['claim', 'T2', '甲'])
    py(['--json', 'claim_idle', '乙', 'T3']) // claim_idle（env 关：认领）
    py(['done', 'T1'])
    py(['create', '父任务', '--scope', 'src'])
    py(['claim', 'T4', '丙'])
    py(['--json', 'create', '草案', '--created-by', '丙', '--of', 'T4', '--scope', 'src', '--draft'])
    py(['--json', 'approve', 'T5']) // approve 代理草案（env 关：放行）
    py(['claim', 'T5', '丁'])
    const at = py(['--json', 'show', 'T5']).json.data.task.attempt_id
    py(['--json', 'reassign', 'T5', 'auto', '--attempt', at, '--owner', '戊']) // reassign peer（env 关：放行）
    py(['--json', 'reassign', 'T5', 'auto', '--attempt',
      py(['--json', 'show', 'T5']).json.data.task.attempt_id]) // peer 保持 owner（env 关：放行）
    py(['done', 'T2']); py(['done', 'T3']); py(['done', 'T4']); py(['done', 'T5'])
    return { outs: py.__outs }
  }
  const dirCur = makeBoardDir(t, 'a-cur')
  const dirOld = makeBoardDir(t, 'a-old')
  // 双版本逐命令比对：stdout 逐字节 + exit code + --json data 顶层键集 + 事件 type/args 键集
  const script = [
    ['init'],
    ['create', '任务A', '--scope', 'src'],
    ['create', '任务B', '--scope', 'src'],
    ['create', '任务C', '--scope', 'src'],
    ['claim', 'T1', '甲'],
    ['claim', 'T2', '甲'],
    ['--json', 'claim_idle', '乙', 'T3'],
    ['done', 'T1'],
    ['create', '父任务', '--scope', 'src'],
    ['claim', 'T4', '丙'],
    ['--json', 'create', '草案', '--created-by', '丙', '--of', 'T4', '--scope', 'src', '--draft'],
    ['--json', 'approve', 'T5'],
    ['claim', 'T5', '丁'],
    ['--json', 'show', 'T5'],
  ]
  const run = (dir, tb) => script.map((args) => ({ args, r: runTb(dir, args, { ...OPTS, tb }) }))
  const rc = run(dirCur, TASKBOARD)
  const ro = run(dirOld, headPy)
  // 时间戳归一（created/updated 毫秒双版本必然不同；键与结构逐字节一致才是断言对象）
  const norm = (s) => s.replace(/"(created|updated)": \d+/g, '"$1": T')
  for (let i = 0; i < script.length; i++) {
    assert.equal(norm(rc[i].r.stdout), norm(ro[i].r.stdout), `逐字节一致：${script[i].join(' ')}`)
    assert.equal(rc[i].r.code, ro[i].r.code, `exit code 一致：${script[i].join(' ')}`)
  }
  // T5 attempt_id 双版本各自生成，show（只读）取各自值续跑 reassign peer 两条
  const atCur = runTb(dirCur, ['--json', 'show', 'T5'], { ...OPTS }).json.data.task.attempt_id
  const atOld = runTb(dirOld, ['--json', 'show', 'T5'], { ...OPTS, tb: headPy }).json.data.task.attempt_id
  const tail = (at) => [
    ['--json', 'reassign', 'T5', 'auto', '--attempt', at, '--owner', '戊'],
    ['--json', 'reassign', 'T5', 'auto', '--attempt', at], // 旧代际已被撤销：stale_attempt 双版本同拒
  ]
  const tc = tail(atCur).map((args) => ({ args, r: runTb(dirCur, args, { ...OPTS, tb: TASKBOARD }) }))
  const to = tail(atOld).map((args) => ({ args, r: runTb(dirOld, args, { ...OPTS, tb: headPy }) }))
  for (let i = 0; i < tc.length; i++) {
    assert.equal(norm(tc[i].r.stdout), norm(to[i].r.stdout), `逐字节一致：${tc[i].args.join(' ')}`)
    assert.equal(tc[i].r.code, to[i].r.code)
    if (tc[i].r.json && to[i].r.json) {
      // reassign 成功路径 task 键集一致；stale_attempt 错误信封键集一致
      assert.deepEqual(Object.keys(tc[i].r.json), Object.keys(to[i].r.json))
    }
  }
  // 事件流：type 序列与 args 键集逐条一致（事件形状零变化）
  const evC = eventsOf(dirCur); const evO = eventsOf(dirOld)
  assert.equal(evC.length, evO.length)
  for (let i = 0; i < evC.length; i++) {
    assert.equal(evC[i].type, evO[i].type, `事件 ${i} type 一致`)
    assert.deepEqual(Object.keys(evC[i].args || {}).sort(), Object.keys(evO[i].args || {}).sort(), `事件 ${i} args 键集一致`)
  }
  // 显式空串关闭（任意非空值才开启）：与真空缺省同形
  const dir2 = makeBoardDir(t, 'a-empty')
  const rEmpty = runTb(dir2, ['create', 'x'], { omitEnv: [ENFORCE], extraEnv: { [ENFORCE]: '' } })
  const rDef = runTb(makeBoardDir(t, 'a-def'), ['create', 'x'], { omitEnv: [ENFORCE] })
  assert.equal(rEmpty.stdout, rDef.stdout)
})

// ── b) 执法开启：claim 超限具名拒 open_cap_exceeded 零写零事件 + hint 探针 ────
test('T13-b claim 超限：open_cap_exceeded 具名拒、零写零事件、hint 指 open-counts 探针、字段含 owner/open_count/cap/after', (t) => {
  const dir = makeBoardDir(t, 'claim-cap')
  const py = (args, opts = {}) => runTb(dir, args, { extraEnv: { [ENFORCE]: '1' }, ...opts })
  py(['init'])
  py(['create', '任务A']); py(['create', '任务B']); py(['create', '任务C']); py(['create', '任务D'])
  py(['claim', 'T1', '甲']); py(['claim', 'T2', '甲']) // 甲 2 open = cap（缺省 2）恰好不超
  const rev = boardOf(dir).revision
  const evN = eventsOf(dir).length
  const taskBefore = JSON.stringify(boardOf(dir).tasks)
  // 第 3 个 claim → post=3 > cap=2 → 具名拒
  const r = py(['--json', 'claim', 'T3', '甲'])
  assert.equal(r.json.error, 'open_cap_exceeded')
  assert.equal(r.json.owner, '甲')
  assert.equal(r.json.open_count, 2)
  assert.equal(r.json.cap, 2)
  assert.equal(r.json.after, 3)
  assert.match(r.json.hint, /taskboard\.py open-counts <owner>/)
  // c) 判定先于任何变更与 save：revision/事件流/任务 JSON 零变化
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  assert.equal(JSON.stringify(boardOf(dir).tasks), taskBefore)
  // 未超限放行（认领方换乙：0 open）
  assert.equal(py(['--json', 'claim', 'T3', '乙']).json.ok, true)
  // 自认领计数不变：甲认领自己名下任务不误拒
  py(['claim', 'T4', '甲', '--attempt', 'gen-x']) // 甲 post=3 → 拒
  assert.equal(py(['--json', 'claim', 'T4', '甲', '--attempt', 'gen-y']).json.error, 'open_cap_exceeded')
})

// ── b2) reassign peer 通道超限 + approve 代理草案 created_by 超限 ─────────────
test('T13-b2 reassign peer 超限拒（--owner 新 owner 计数）/approve created_by 超限拒（草案 owner==created_by 自计入）；均零写零事件', (t) => {
  // 场景 1：reassign peer → bob 2 open，alice 持证明转派给 bob 应拒
  const dir = makeBoardDir(t, 'reassign-cap')
  const py = (args) => runTb(dir, args, { extraEnv: { [ENFORCE]: '1' } })
  py(['init'])
  py(['create', 'A', '--scope', 'src']); py(['create', 'B', '--scope', 'src']); py(['create', 'C', '--scope', 'src'])
  py(['claim', 'T1', 'alice', '--attempt', 'gen1'])
  py(['claim', 'T2', 'bob']); py(['claim', 'T3', 'bob'])
  const at = py(['--json', 'show', 'T1']).json.data.task.attempt_id
  const rev = boardOf(dir).revision; const evN = eventsOf(dir).length
  const r = py(['--json', 'reassign', 'T1', 'auto', '--attempt', at, '--owner', 'bob'])
  assert.equal(r.json.error, 'open_cap_exceeded')
  assert.equal(r.json.owner, 'bob'); assert.equal(r.json.after, 3)
  assert.match(r.json.hint, /taskboard\.py open-counts/)
  assert.equal(boardOf(dir).revision, rev); assert.equal(eventsOf(dir).length, evN)
  assert.equal(boardOf(dir).tasks.T1.owner, 'alice') // c) 任务字段零变化
  // 未超限放行：转给 carol（0 open）
  assert.equal(py(['--json', 'reassign', 'T1', 'auto', '--attempt', at, '--owner', 'carol']).json.ok, true)
  // peer 不带 --owner：owner 保持 alice（alice 自身计数 0 open 转派后仍 0）→ 放行（既有语义）
  const at2 = py(['--json', 'show', 'T1']).json.data.task.attempt_id
  assert.equal(py(['--json', 'reassign', 'T1', 'auto', '--attempt', at2]).json.ok, true)

  // 场景 2：approve 代理草案（--owner carol 落 owner==created_by，草案自身计入 open-counts 口径）
  const dir2 = makeBoardDir(t, 'approve-cap')
  const py2 = (args) => runTb(dir2, args, { extraEnv: { [ENFORCE]: '1' } })
  py2(['init'])
  py2(['create', '父A', '--scope', 'src']); py2(['claim', 'T1', 'carol'])
  py2(['create', '父B', '--scope', 'src']); py2(['claim', 'T2', 'carol']) // carol 2 open
  py2(['--json', 'create', '草案1', '--created-by', 'carol', '--of', 'T1', '--scope', 'src', '--draft', '--owner', 'carol'])
  const rev2 = boardOf(dir2).revision; const evN2 = eventsOf(dir2).length
  const taskBefore2 = JSON.stringify(boardOf(dir2).tasks)
  const r2 = py2(['--json', 'approve', 'T3']) // pre=3（父A父B+草案自身）> cap=2 → 拒
  assert.equal(r2.json.error, 'open_cap_exceeded')
  assert.equal(r2.json.owner, 'carol'); assert.equal(r2.json.open_count, 3)
  assert.match(r2.json.hint, /taskboard\.py open-counts/)
  assert.equal(boardOf(dir2).revision, rev2); assert.equal(eventsOf(dir2).length, evN2)
  assert.equal(JSON.stringify(boardOf(dir2).tasks), taskBefore2)
  // 未超限放行：dave 0 open 的代理草案
  py2(['create', '父C', '--scope', 'src']); py2(['claim', 'T4', 'dave'])
  py2(['create', '草案2', '--created-by', 'dave', '--of', 'T4', '--scope', 'src', '--draft', '--owner', 'dave'])
  assert.equal(py2(['--json', 'approve', 'T5']).json.ok, true)
})

// ── c/d) claim_idle 逐候选判：部分接受+超限 skip、全超限具名拒、混合 skip、env 关闭放行 ──
test('T13-c/d claim_idle 逐候选 open 判：部分接受 skipped.reason=open_cap_exceeded、全超限 open_cap_exceeded 具名拒零写零事件、混合 skip 双原因、env 关闭放行', (t) => {
  // 干净板构造「有 open 但无 running」：代理草案批准后留 ready+owner（claim 会置 running 故不可用）
  const mk = (label, env) => {
    const dir = makeBoardDir(t, label)
    const py = (args) => runTb(dir, args, { extraEnv: env })
    py(['init'])
    py(['create', '父', '--scope', 'src'])
    py(['claim', 'T1', 'ow1'])
    py(['create', '草案', '--created-by', 'ow1', '--of', 'T1', '--scope', 'src', '--draft', '--owner', 'ow1'])
    py(['approve', 'T2']) // ready owner=ow1（open 计入）
    py(['done', 'T1']) // 全板无 running，claim_idle 可用
    return { dir, py }
  }
  // 场景 1（执法开，cap=1）：候选 c1 超限 skip、整轮无候选可领 → 具名拒 open_cap_exceeded
  const on = { [ENFORCE]: '1', [CAP]: '1' }
  const s1 = mk('idle-full', on)
  s1.py(['create', 'c1'])
  const rev = boardOf(s1.dir).revision; const evN = eventsOf(s1.dir).length
  const r = s1.py(['--json', 'claim_idle', 'ow1', 'T3'])
  assert.equal(r.json.error, 'open_cap_exceeded')
  assert.equal(r.json.owner, 'ow1'); assert.equal(r.json.open_count, 1); assert.equal(r.json.cap, 1)
  assert.deepEqual(r.json.skipped, [{ id: 'T3', reason: 'open_cap_exceeded' }])
  assert.match(r.json.hint, /taskboard\.py open-counts/)
  assert.equal(boardOf(s1.dir).revision, rev); assert.equal(eventsOf(s1.dir).length, evN)

  // 场景 2（执法开，cap=2）：ow1 已 1 open → 收 1 个、skip 1 个（部分接受，skipped 留痕）
  const s2 = mk('idle-partial', { [ENFORCE]: '1' }) // cap 缺省 2
  s2.py(['create', 'c1']); s2.py(['create', 'c2'])
  const r2 = s2.py(['--json', 'claim_idle', 'ow1', 'T3', 'T4'])
  assert.equal(r2.json.ok, true)
  assert.deepEqual(r2.json.data.claimed, ['T3'])
  assert.deepEqual(r2.json.data.skipped, [{ id: 'T4', reason: 'open_cap_exceeded' }])

  // 场景 3（执法开）：混合 skip（open_cap_exceeded + tag_mismatch 并存）；全受阻时双原因齐现
  const s3 = mk('idle-mixed', { [ENFORCE]: '1', [CAP]: '1' })
  s3.py(['create', 'c1'])                    // T3 无 tags：过 tag 门、卡 cap 门
  s3.py(['create', 'c2', '--tags', 'rust'])  // T4 tags rust：卡 tag 门
  const r3 = s3.py(['--json', 'claim_idle', 'ow1', 'T3', 'T4', '--tags', 'go'])
  assert.equal(r3.json.error, 'open_cap_exceeded')
  assert.deepEqual(r3.json.skipped, [
    { id: 'T3', reason: 'open_cap_exceeded' },
    { id: 'T4', reason: 'tag_mismatch' },
  ])

  // 场景 4（env 关闭）：同输入现状放行（claim_idle_noop/正常认领，无 cap skip 语义）
  const s4 = mk('idle-off', {})
  s4.py(['create', 'c1'])
  const r4 = s4.py(['--json', 'claim_idle', 'ow1', 'T3'])
  assert.equal(r4.json.ok, true)
  assert.deepEqual(r4.json.data.skipped, [])
})

// ── d) escalation 上限：needs_revision 达限拒绝 repair 绕行直升 escalated；retry 不清零；reassign 双通道拒 ──
test('T13-d escalation 上限：达限 needs_revision 直升 escalated（escalation_count 落档、不再生成 repair）、retry 不清零、reassign 双通道 escalation_limit_exceeded、env 关闭现状', (t) => {
  // 场景 1（执法开，limit=1）：单评审 review 任务
  const dir = makeBoardDir(t, 'esc-on')
  const py = (args) => runTb(dir, args, { extraEnv: { [ENFORCE]: '1', [ESC]: '1' } })
  py(['init'])
  py(['create', 'rv', '--kind', 'review'])
  py(['claim', 'T1', 'rev1'])
  // 第 1 次 needs_revision：esc 历史 0 < 1 → 现状自动 repair（escalation 路径不触发）
  py(['done', 'T1', '--verdict', 'needs_revision', '--findings', 'f1'])
  assert.equal(boardOf(dir).tasks.T1.status, 'ready')
  assert.equal(boardOf(dir).tasks.T1.repair_count, 1)
  assert.equal(boardOf(dir).tasks.T1.escalation_count, undefined)
  // 第 2-4 次：repair 预算耗尽（REPAIR_RETRY_LIMIT=3）→ 第 4 次直升 escalated + escalation_count=1 落档
  for (let round = 2; round <= 4; round++) {
    py(['claim', 'T1', 'rev1'])
    py(['done', 'T1', '--verdict', 'needs_revision', '--findings', `f${round}`])
  }
  assert.equal(boardOf(dir).tasks.T1.status, 'escalated')
  assert.equal(boardOf(dir).tasks.T1.repair_count, 4)
  assert.equal(boardOf(dir).tasks.T1.escalation_count, 1)
  // escalated 状态门先挡（既有行为零变化）；retry 解除后（escalation_count 保留）reassign 双通道拒
  const rEsc = py(['--json', 'reassign', 'T1', 'auto', '--owner', 'x'])
  assert.equal(rEsc.json.error, 'command_failed') // 既有 escalated sys.exit 门（T13 不改变它）
  py(['retry', 'T1'])
  assert.equal(boardOf(dir).tasks.T1.status, 'ready')
  assert.equal(boardOf(dir).tasks.T1.escalation_count, 1) // retry 不清零（唯一事实源=字段）
  let rev = boardOf(dir).revision; let evN = eventsOf(dir).length
  const rOrch = py(['--json', 'reassign', 'T1', 'auto', '--owner', 'x'])
  assert.equal(rOrch.json.error, 'escalation_limit_exceeded')
  assert.equal(rOrch.json.escalation_count, 1); assert.equal(rOrch.json.limit, 1)
  assert.equal(boardOf(dir).revision, rev); assert.equal(eventsOf(dir).length, evN)
  // peer 通道同拒
  py(['claim', 'T1', 'rev1', '--attempt', 'gen1'])
  const at = py(['--json', 'show', 'T1']).json.data.task.attempt_id
  rev = boardOf(dir).revision
  const rPeer = py(['--json', 'reassign', 'T1', 'auto', '--attempt', at])
  assert.equal(rPeer.json.error, 'escalation_limit_exceeded')
  assert.equal(boardOf(dir).revision, rev)
  // 达限后 needs_revision：拒绝自动 repair 绕行 → 直升 escalated、escalation_count=2、注记换形
  py(['done', 'T1', '--verdict', 'needs_revision', '--findings', 'f5'])
  const t1 = boardOf(dir).tasks.T1
  assert.equal(t1.status, 'escalated')
  assert.equal(t1.escalation_count, 2)
  assert.match(t1.checkpoints.at(-1).note, /escalated 历史 1 次已达上限（DSH_EXPERT_ESCALATION_LIMIT）/)
  assert.equal(eventsOf(dir).at(-1).type, 'done') // done 事件类型不变（复用既有 type）

  // vote 僵局：m=2 一 pass 一 fail → escalated + escalation_count=1 落档（注记既有文本不动）
  const dir2 = makeBoardDir(t, 'esc-deadlock')
  const py2 = (args) => runTb(dir2, args, { extraEnv: { [ENFORCE]: '1', [ESC]: '1' } })
  py2(['init'])
  py2(['create', 'rv', '--kind', 'review', '--quorum-m', '2'])
  py2(['claim', 'T1', 'rev1'])
  py2(['vote', 'T1', '--by', 'revA', '--score', '1'])
  py2(['vote', 'T1', '--by', 'revB', '--score', '0'])
  assert.equal(boardOf(dir2).tasks.T1.status, 'escalated')
  assert.equal(boardOf(dir2).tasks.T1.escalation_count, 1)
  assert.match(boardOf(dir2).tasks.T1.checkpoints.at(-1).note, /反向票/) // 既有注记逐字节保留

  // 场景 2（env 关闭）：同形 needs_revision 现状自动 repair、不落 escalation_count
  const dir3 = makeBoardDir(t, 'esc-off')
  const py3 = (args) => runTb(dir3, args, { omitEnv: [ENFORCE, ESC] })
  py3(['init'])
  py3(['create', 'rv', '--kind', 'review'])
  py3(['claim', 'T1', 'rev1'])
  py3(['done', 'T1', '--verdict', 'needs_revision', '--findings', 'f1'])
  assert.equal(boardOf(dir3).tasks.T1.status, 'ready')
  assert.equal(boardOf(dir3).tasks.T1.repair_count, 1)
  assert.equal(boardOf(dir3).tasks.T1.escalation_count, undefined)
})

// ── d2) 阈值 env 宁拒勿猜：非法值（非整数/<1）具名拒绝；合法值生效 ─────────────
test('T13-d2 阈值 env：非法值宁拒勿猜（非整数/0）零写零事件；DSH_EXPERT_PEER_OPEN_CAP/DSH_EXPERT_ESCALATION_LIMIT 合法值生效', (t) => {
  const dir = makeBoardDir(t, 'env-invalid')
  const py = (args, extra = {}) => runTb(dir, args, { extraEnv: { [ENFORCE]: '1', ...extra } })
  py(['init'])
  py(['create', 'A']); py(['create', 'B']); py(['create', 'C'])
  py(['claim', 'T1', '甲']); py(['claim', 'T2', '甲'])
  const rev = boardOf(dir).revision; const evN = eventsOf(dir).length
  let r = py(['--json', 'claim', 'T3', '甲'], { [CAP]: 'abc' })
  assert.equal(r.json.error, 'command_failed')
  assert.match(r.json.message, /DSH_EXPERT_PEER_OPEN_CAP 须为正整数/)
  r = py(['--json', 'claim', 'T3', '甲'], { [CAP]: '0' })
  assert.equal(r.json.error, 'command_failed')
  assert.equal(boardOf(dir).revision, rev); assert.equal(eventsOf(dir).length, evN)
  // 合法值生效：cap=3 → 甲第 3 个可领
  r = py(['--json', 'claim', 'T3', '甲'], { [CAP]: '3' })
  assert.equal(r.json.ok, true)
})

// ── b3) hint 与 R1 口径：具名拒 hint 均指 open-counts 探针；R1 声明在源码段注释（静态断言）──
test('T13-b3 源码静态断言：R1 声明、零写零事件声明、Q7 env 名、缺省值常量在场', (t) => {
  const src = readFileSync(TASKBOARD, 'utf-8')
  assert.match(src, /防误用非防伪造/)
  assert.match(src, /DSH_EXPERT_ANTISTORM_ENFORCE/)
  assert.match(src, /DSH_EXPERT_PEER_OPEN_CAP/)
  assert.match(src, /DSH_EXPERT_ESCALATION_LIMIT/)
  assert.match(src, /_OPEN_CAP_DEFAULT = 2/)
  assert.match(src, /_ESCALATION_LIMIT_DEFAULT = 1/)
  assert.match(src, /retry 不清零/)
})
