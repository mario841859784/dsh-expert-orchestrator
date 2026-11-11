// test/taskboard-attempt-capability.selftest.mjs — T7 reassign 代际能力化自测（node:test，零依赖）。
// 覆盖验收 a–e：a) 基线（npm test 539 tests/537 pass/0 fail/2 skipped）已记录于任务板 T7 progress；
// b) 8 命令（claim/done/fail/progress/vote/heartbeat/own/reassign）不带新参数输出与 2.13.9 逐字节一致
//    （检查点时间戳归一为 [TS]，其余字面精确断言；字面自 HEAD 基线实跑捕获）；
// c) peer 互派通道：不持代际 no_attempt / 已撤销 stale_attempt 具名拒绝且零写零事件；持当前代际成功且
//    新 token 由工具生成（at-<16hex>）、旧代际入 attempt_revoked、旧代际迟到汇报被拒；
// d) token 唯一性 / 复活禁令 / token 贯通 8 命令既有 --attempt 校验（Q2：token v1 不绑定 owner）；
// e) --json data 携带 token；事件 type=reassign args 携带 generated=true（生成模式）与 proof_attempt
//    （有持有证明时）留痕，旧通道 args 形状不变。
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

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。 */
const runTb = (cwd, args) => {
  const r = spawnSync('python3', [TASKBOARD, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人类可读输出不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeBoardDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t7-attempt-cap-${label}-`))
  mkdirSync(join(dir, '.expert-taskboards'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const boardOf = (dir) => JSON.parse(readFileSync(join(dir, BOARD_REL), 'utf-8'))
const eventsOf = (dir) => readFileSync(join(dir, EVENTS_REL), 'utf-8').trim().split('\n')
  .map((l) => JSON.parse(l))
// 检查点行内嵌本地时间戳，归一后做逐字节比对（其余字面一律精确）
const norm = (s) => s.replace(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g, '[TS]')
const TOKEN_RE = /^at-[0-9a-f]{16}$/

// ── b) 8 命令不带新参数：与 2.13.9 逐字节一致 ────────────────────────────
test('T7-b 缺省兼容：8 命令不带新参数输出与 2.13.9 逐字节一致（时间戳归一）；旧通道 reassign 事件 args 形状不变', (t) => {
  const dir = makeBoardDir(t, 'compat')
  const py = (...args) => runTb(dir, args)
  assert.equal(norm(py('create', '任务A', '--owner', '甲').stdout),
    'T1 [ready] 任务A owner=甲\n依赖已满足，自动转 ready: T1\nrevision=1\n')
  assert.equal(py('claim', 'T1', '甲').stdout, 'T1 [running] 任务A owner=甲\nrevision=2\n')
  assert.equal(norm(py('progress', 'T1', '推进中').stdout),
    'T1 [running] 任务A owner=甲\n  最新检查点(1): [TS] 推进中\nrevision=3\n')
  assert.equal(py('heartbeat', 'T1').stdout, 'T1 [running] 任务A owner=甲\nrevision=4\n')
  assert.equal(py('own', 'T1', 'src/a.txt').stdout, 'T1 [running] 任务A owner=甲\n  工件归属: src/a.txt\nrevision=5\n')
  // 编排者通道（自报 attempt_id，不带 --attempt）：人类面逐字节 + --json data 键集 + 事件 args 形状不变
  assert.equal(py('reassign', 'T1', 'a9', '--owner', '乙').stdout,
    'T1 [running] 任务A owner=乙\n  工件归属: src/a.txt\n旧 attempt （无） 已撤销，当前代际 a9\nrevision=6\n')
  const j = py('--json', 'reassign', 'T1', 'a10')
  assert.equal(j.code, 0)
  assert.equal(j.json.ok, true)
  assert.equal(j.json.cmd, 'reassign')
  assert.deepEqual(Object.keys(j.json.data.task).sort(),
    ['artifacts', 'attempt_id', 'attempt_revoked', 'checkpoints', 'created', 'dep', 'desc',
      'fail', 'id', 'nudges', 'owner', 'status', 'summary', 'title', 'updated'].sort())
  assert.equal(j.json.data.task.attempt_id, 'a10')
  assert.deepEqual(j.json.data.task.attempt_revoked, ['a9'])
  const last = eventsOf(dir).at(-1)
  assert.equal(last.type, 'reassign')
  assert.deepEqual(last.args, { attempt_id: 'a10', owner: null })  // 旧通道 args 形状：仅 attempt_id/owner 两键
  assert.equal(py('done', 'T1', '完工').stdout,
    'T1 [done] 任务A owner=乙\n  工件归属: src/a.txt\nrevision=8\n')
  // fail / vote 两条命令同验（review m 票任务走 vote，普通任务走 fail）
  py('create', '任务B', '--owner', '丙')
  py('approve', 'T2')
  assert.equal(py('claim', 'T2', '丙').stdout, 'T2 [running] 任务B owner=丙\nrevision=10\n')
  assert.equal(py('fail', 'T2', '原因').stdout, 'T2 [failed] 任务B owner=丙\nrevision=11\n')
  py('create', '评审', '--kind', 'review', '--quorum-m', '2', '--owner', '丁')
  py('approve', 'T3')
  assert.equal(py('claim', 'T3', '丁').stdout, 'T3 [running] 评审 owner=丁 kind=review\nrevision=13\n')
  assert.equal(py('vote', 'T3', '--by', 'R1', '--score', '1').stdout,
    'T3 [running] 评审 owner=丁 kind=review\n  已记票（pass 1/fail 0/弃权 0；R1:1）——未达生效线：同向需 ≥2 张且零反向票（还差 1 张 pass 票）\nrevision=14\n')
})

// ── c) peer 互派通道：持有成功 + 拒绝路径零写零事件 ──────────────────────
test('T7-c peer 通道：持有证明成功且 token 工具生成、旧代际入 attempt_revoked、迟到汇报被拒；事件 args 留痕 generated/proof_attempt', (t) => {
  const dir = makeBoardDir(t, 'peer-ok')
  const py = (...args) => runTb(dir, args)
  py('create', '任务A', '--owner', '甲')
  py('approve', 'T1')
  assert.equal(py('claim', 'T1', '甲', '--attempt', 'a1').code, 0)
  const r = py('--json', 'reassign', 'T1', 'auto', '--attempt', 'a1', '--owner', '乙')
  assert.equal(r.code, 0)
  const token = r.json.data.task.attempt_id
  assert.match(token, TOKEN_RE, '工具生成 token 须为 at-<16hex> 不可猜格式')
  const t1 = boardOf(dir).tasks.T1
  assert.equal(t1.attempt_id, token)
  assert.deepEqual(t1.attempt_revoked, ['a1'], '旧代际须入 attempt_revoked')
  assert.equal(t1.owner, '乙')
  const ev = eventsOf(dir).at(-1)
  assert.equal(ev.type, 'reassign')
  assert.deepEqual(ev.args, { attempt_id: token, owner: '乙', generated: true, proof_attempt: 'a1' })
  // 旧代际迟到汇报：具名拒绝且零写零事件
  const revBefore = boardOf(dir).revision
  const evCountBefore = eventsOf(dir).length
  const bad = py('--json', 'done', 'T1', '迟到汇报', '--attempt', 'a1')
  assert.equal(bad.code !== 0, true)
  assert.equal(bad.json.error, 'stale_attempt')
  assert.equal(boardOf(dir).revision, revBefore, '拒绝须零写（revision 不变）')
  assert.equal(eventsOf(dir).length, evCountBefore, '拒绝须零事件')
  // 新 token 汇报成功（token 也是合法 attempt_id，八命令既有校验零改动复用）
  assert.equal(py('done', 'T1', '完工', '--attempt', token).code, 0)
})

test('T7-c peer 拒绝路径：no_attempt / stale_attempt / attempt_source_conflict / not_task_owner 全部具名拒绝且零写零事件', (t) => {
  const dir = makeBoardDir(t, 'peer-reject')
  const py = (...args) => runTb(dir, args)
  // ① 任务无开放代际（未 claim）→ no_attempt
  py('create', '任务A', '--owner', '甲')
  py('approve', 'T1')
  let rev = boardOf(dir).revision
  let evN = eventsOf(dir).length
  let r = py('--json', 'reassign', 'T1', 'auto', '--attempt', 'a1')
  assert.equal(r.json.error, 'no_attempt')
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  // ② 建立代际并转派一次后，用已撤销代际作持有证明 → stale_attempt
  py('claim', 'T1', '甲', '--attempt', 'a1')
  const first = py('--json', 'reassign', 'T1', 'auto', '--attempt', 'a1', '--owner', '乙')
  assert.equal(first.code, 0)
  const token1 = first.json.data.task.attempt_id
  py('reassign', 'T1', 'a2', '--owner', '丙') // 编排者通道再转一代（token1 入 revoked）
  rev = boardOf(dir).revision
  evN = eventsOf(dir).length
  r = py('--json', 'reassign', 'T1', 'auto', '--attempt', token1)
  assert.equal(r.json.error, 'stale_attempt')
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  // ③ 持有证明与自报新 attempt_id 混用 → attempt_source_conflict（新 token 必须工具生成，宁拒勿错）
  py('create', '任务B', '--owner', '丙')
  py('approve', 'T2')
  py('claim', 'T2', '丙', '--attempt', 'b1')
  rev = boardOf(dir).revision
  evN = eventsOf(dir).length
  r = py('--json', 'reassign', 'T2', 'x1', '--attempt', 'b1')
  assert.equal(r.json.error, 'attempt_source_conflict')
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
  // ④ 无主任务（claim 不带 owner）持证明互派 → not_task_owner（owner==自己 双条件的 owner 侧）
  py('create', '任务C')
  py('approve', 'T3')
  py('claim', 'T3', '--attempt', 'c1')
  rev = boardOf(dir).revision
  evN = eventsOf(dir).length
  r = py('--json', 'reassign', 'T3', 'auto', '--attempt', 'c1')
  assert.equal(r.json.error, 'not_task_owner')
  assert.equal(boardOf(dir).revision, rev)
  assert.equal(eventsOf(dir).length, evN)
})

// ── d) token 唯一性 / 复活禁令 / 8 命令 token 链 ────────────────────────
test('T7-d 生成模式：编排者 auto 无证明合法、token 唯一、show 命令回显当前代际；token 贯通 8 命令既有 --attempt 校验（Q2 不绑 owner）', (t) => {
  const dir = makeBoardDir(t, 'token-chain')
  const py = (...args) => runTb(dir, args)
  py('create', '任务A', '--owner', '甲')
  py('approve', 'T1')
  py('claim', 'T1', '甲', '--attempt', 'a1')
  // 编排者通道 auto（无持有证明）：合法，args 仅 generated 标记、无 proof_attempt
  const g1 = py('--json', 'reassign', 'T1', 'auto', '--owner', '乙')
  const tok1 = g1.json.data.task.attempt_id
  assert.match(tok1, TOKEN_RE)
  const ev1 = eventsOf(dir).at(-1)
  assert.deepEqual(ev1.args, { attempt_id: tok1, owner: '乙', generated: true })
  // token 唯一性：再次生成不得复用当前/已撤销代际
  const g2 = py('--json', 'reassign', 'T1', 'auto')
  const tok2 = g2.json.data.task.attempt_id
  assert.match(tok2, TOKEN_RE)
  assert.notEqual(tok1, tok2)
  assert.deepEqual(boardOf(dir).tasks.T1.attempt_revoked, ['a1', tok1])
  // show 命令回显当前代际（供抄入下游任务书）
  const s = py('show', 'T1')
  assert.match(s.stdout, /当前代际: at-[0-9a-f]{16}/)
  // 复活禁令（任务内作用域）：已撤销代际不可经 reassign 复活（既有行为，token 化后保持）
  let r = py('--json', 'reassign', 'T1', tok1)
  assert.equal(r.json.error, 'stale_attempt')
  py('create', '任务B', '--owner', '丙')
  // token 链：token 作为合法 attempt_id 贯通 claim/progress/heartbeat/own/vote/fail/done（Q2：token v1 不绑定 owner）
  const c = py('--json', 'claim', 'T2', '丙', '--attempt', tok2)
  assert.equal(c.code, 0)
  assert.equal(boardOf(dir).tasks.T2.attempt_id, tok2)
  assert.equal(py('progress', 'T1', '推进', '--attempt', tok2).code, 0)
  assert.equal(py('heartbeat', 'T1', '--attempt', tok2).code, 0)
  assert.equal(py('own', 'T1', 'src/b.txt', '--attempt', tok2).code, 0)
  py('create', '评审', '--kind', 'review', '--quorum-m', '2', '--owner', '丁')
  py('approve', 'T3')
  py('claim', 'T3', '丁', '--attempt', tok2)
  assert.equal(py('vote', 'T3', '--by', 'R1', '--score', '1', '--attempt', tok2).code, 0)
  assert.equal(py('fail', 'T2', '原因', '--attempt', tok2).code, 0)
  // 旧代际迟到汇报被拒（链尾回归）
  r = py('--json', 'progress', 'T1', '迟到', '--attempt', tok1)
  assert.equal(r.json.error, 'stale_attempt')
})
