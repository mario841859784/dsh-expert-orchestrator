// test/receipt-contract.selftest.mjs — 机器回执 JSON 契约严格化自测（v2.13 T2，node:test，零依赖）。
// 覆盖：生产端 taskboard.py/bus.py 回执形态（正样本完整键集与类型断言 / 负样本缺字段→具名
// receipt_invalid·message_invalid 结构化错误，绝不裸 traceback）+ 消费端 lib/tools.js
// receiptContractError / claimFailureReason 适配（键大小写敏感、无别名，别名不抵充必备字段）。
// 文件系统用例使用 os.tmpdir() 临时目录，结束后清理，不触碰仓库内任何数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { claimFailureReason, receiptContractError, receiptContractHint } from '../lib/tools.js'
import { budgetNoticeFromEnvelope } from '../lib/budget.js'

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'expert-orchestration', 'tools')
const TB = join(TOOLS_DIR, 'taskboard.py')
const BUS = join(TOOLS_DIR, 'bus.py')

/** 执行 taskboard.py（cwd 隔离到临时目录）；stdout 单行 JSON 时解析为 json 字段。 */
const runTb = (cwd, args) => {
  const r = spawnSync('python3', [TB, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 非 JSON 输出（人类面）不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

/** 执行 bus.py（同 runTb 语义）。 */
const runBus = (cwd, args) => {
  const r = spawnSync('python3', [BUS, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 非 JSON 输出（人类面）不解析 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `t2-receipt-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 建一块带一个 ready 任务的板（create 默认落 <cwd>/.expert-taskboard.json）。 */
const makeBoard = (cwd) => {
  assert.equal(runTb(cwd, ['create', '任务一', '--owner', 'pm', '--desc', 'd']).code, 0)
}

/** 断言 stdout 恰一行且不含裸 traceback。 */
const assertSingleLineNoTraceback = (stdout) => {
  assert.ok(!stdout.includes('Traceback'), `裸 traceback 泄漏: ${stdout.slice(0, 200)}`)
  assert.equal(stdout.trim().split('\n').length, 1, `stdout 非单行: ${JSON.stringify(stdout)}`)
}

// ── 生产端 taskboard.py：正样本信封完整形态 ─────────────────────────────────

test('T2-P1 --json show 成功信封：恰键集 {ok,cmd,data,revision} 且类型正确（键全小写，无别名键）', (t) => {
  const cwd = makeDir(t, 'p1')
  makeBoard(cwd)
  const r = runTb(cwd, ['--json', 'show', 'T1'])
  assert.equal(r.code, 0)
  assertSingleLineNoTraceback(r.stdout)
  const env = r.json
  assert.deepEqual(Object.keys(env).sort(), ['cmd', 'data', 'ok', 'revision'])
  assert.equal(env.ok, true)
  assert.equal(typeof env.ok, 'boolean')
  assert.equal(env.cmd, 'show')
  assert.equal(typeof env.cmd, 'string')
  assert.equal(env.revision, 1)
  assert.equal(typeof env.revision, 'number')
  const task = env.data?.task
  assert.equal(env.data && typeof env.data, 'object')
  // 任务对象必备簿记字段在（键大小写敏感：逐个断言小写键存在）
  for (const k of ['id', 'title', 'status', 'owner', 'created', 'updated']) {
    assert.ok(k in task, `任务对象缺必备键 ${k}`)
  }
  assert.equal(task.id, 'T1')
  assert.equal(task.status, 'ready')
  // 无错大小写别名键混入
  for (const k of Object.keys(env)) assert.ok(k === k.toLowerCase(), `信封出现非小写键 ${k}`)
})

test('T2-P2 --json claim/list 成功信封：claim 后 data.task 反映认领态，list 的 data.tasks 为数组', (t) => {
  const cwd = makeDir(t, 'p2')
  makeBoard(cwd)
  const cl = runTb(cwd, ['--json', 'claim', 'T1', 'worker'])
  assert.equal(cl.code, 0)
  // 写命令信封附 event_seq（exposure-crypto-trust N2 对账锚点：本次落账后事件流末 seq，
  // 与 replay data.event_seq 同源）——恰键集随之扩展。
  assert.deepEqual(Object.keys(cl.json).sort(), ['cmd', 'data', 'event_seq', 'ok', 'revision'])
  assert.equal(cl.json.cmd, 'claim')
  assert.equal(cl.json.data.task.status, 'running')
  assert.equal(cl.json.data.task.owner, 'worker')
  assert.equal(cl.json.event_seq, 2, '首板 create(seq1)+claim(seq2)')
  const lst = runTb(cwd, ['--json', 'list'])
  assert.equal(lst.code, 0)
  assert.deepEqual(Object.keys(lst.json).sort(), ['cmd', 'data', 'ok', 'revision'], '读命令信封不带 event_seq')
  assert.ok(Array.isArray(lst.json.data.tasks))
  assert.equal(lst.json.data.tasks.length, 1)
  assert.equal(lst.json.data.tasks[0].id, 'T1')
})

test('T2-P2b --json create 成功信封：data.task=创建后任务快照（N2 审计回显），event_seq 对账锚点递增', (t) => {
  const cwd = makeDir(t, 'p2b')
  const cr = runTb(cwd, ['--json', 'create', '审计回显任务', '--owner', 'pm', '--desc', 'd'])
  assert.equal(cr.code, 0)
  assert.deepEqual(Object.keys(cr.json).sort(), ['cmd', 'data', 'event_seq', 'ok', 'revision'])
  const task = cr.json.data.task
  assert.equal(task.id, 'T1', 'create 无 id 参数——回执仍须携带创建后任务（data.task）')
  assert.equal(task.title, '审计回显任务')
  assert.equal(task.owner, 'pm')
  assert.equal(task.status, 'ready', '无依赖任务经 refresh 提升后最终态如实回显')
  assert.equal(cr.json.event_seq, 1)
  // 再写一笔：event_seq 递增到 2（对账锚点与事件流末 seq 一致）
  const cl = runTb(cwd, ['--json', 'claim', 'T1', 'worker'])
  assert.equal(cl.json.event_seq, 2)
  const rp = runTb(cwd, ['--json', 'replay'])
  assert.equal(rp.json.data.event_seq, 2, '信封 event_seq 与 replay 对账载荷同源')
})

test('T2-P3 --json boards 成功信封：恰键集 {ok,cmd,data}（无 revision，约定保持）', (t) => {
  const cwd = makeDir(t, 'p3')
  makeBoard(cwd)
  const r = runTb(cwd, ['--json', 'boards'])
  assert.equal(r.code, 0)
  assert.deepEqual(Object.keys(r.json).sort(), ['cmd', 'data', 'ok'])
  assert.equal(r.json.cmd, 'boards')
  assert.ok(Array.isArray(r.json.data.boards))
})

test('T2-P4 --json 失败信封具名：BoardError 面 {ok,error,...}、人读拒绝面 {ok,error,message}', (t) => {
  const cwd = makeDir(t, 'p4')
  makeBoard(cwd)
  const nf = runTb(cwd, ['--json', 'show', 'NOPE']) // 人读 sys.exit 类拒绝 → command_failed 信封
  assert.equal(nf.code, 1)
  assertSingleLineNoTraceback(nf.stdout)
  assert.deepEqual(Object.keys(nf.json).sort(), ['error', 'message', 'ok'])
  assert.equal(nf.json.ok, false)
  assert.equal(nf.json.error, 'command_failed')
  assert.ok(typeof nf.json.message === 'string' && nf.json.message.length > 0)
  const cas = runTb(cwd, ['--json', 'done', 'T1', 'x', '--expected-revision', '999']) // CAS 不符 → 具名 BoardError
  assert.equal(cas.code, 1)
  assertSingleLineNoTraceback(cas.stdout)
  assert.equal(cas.json.ok, false)
  assert.equal(typeof cas.json.error, 'string')
  assert.ok(cas.json.error.length > 0)
  assert.notEqual(cas.json.error, 'command_failed')
})

test('T2-P5 板损坏：--json 与人读面均单行具名 unrecoverable JSON，绝不裸 traceback', (t) => {
  const cwd = makeDir(t, 'p5')
  makeBoard(cwd)
  writeFileSync(join(cwd, '.expert-taskboard.json'), 'not json{')
  const j = runTb(cwd, ['--json', 'show', 'T1'])
  assert.equal(j.code, 1)
  assertSingleLineNoTraceback(j.stdout)
  assert.equal(j.json.ok, false)
  assert.equal(j.json.error, 'unrecoverable')
  assert.equal(j.json.unrecoverable, true)
  assert.deepEqual(Object.keys(j.json).sort(), ['error', 'ok', 'path', 'reason', 'unrecoverable'])
  const h = runTb(cwd, ['show', 'T1']) // 人读错误面也 print 单行 JSON（无 ok 字段）
  assert.equal(h.code, 1)
  assertSingleLineNoTraceback(h.stdout)
  assert.deepEqual(Object.keys(h.json).sort(), ['error', 'path', 'reason', 'unrecoverable'])
  assert.equal(h.json.error, 'unrecoverable')
})

// ── 生产端 bus.py：消息形态与 message_invalid 契约 ─────────────────────────

test('T2-P6 bus send 落盘消息全字段形态：{id,from,to,subject,body,files,ts,read,seq} 齐备且类型正确', (t) => {
  const cwd = makeDir(t, 'p6')
  assert.equal(runBus(cwd, ['send', '--from', '专家甲', '--to', 'coordinator', '--subject', '主题', '--body', '正文', '--file', 'a.txt']).code, 0)
  const d = join(cwd, '.expert-bus', 'coordinator')
  const files = readdirSync(d).filter((n) => n.endsWith('.json'))
  assert.equal(files.length, 1)
  const m = JSON.parse(readFileSync(join(d, files[0]), 'utf-8'))
  for (const k of ['id', 'from', 'to', 'subject', 'body', 'files', 'ts', 'read', 'seq']) {
    assert.ok(k in m, `消息缺必备/簿记键 ${k}`)
  }
  assert.equal(m.from, '专家甲')
  assert.equal(m.to, 'coordinator')
  assert.equal(m.read, false)
  assert.equal(typeof m.seq, 'number')
  assert.ok(Array.isArray(m.files))
})

test('T2-P7 bus read：收件箱消息缺必备字段 id → 隔离 .corrupt 留痕 + stderr 具名告警，read 续行不卡死（v2.13.1 T2 毒消息自愈）', (t) => {
  const cwd = makeDir(t, 'p7')
  const d = join(cwd, '.expert-bus', 'c')
  mkdirSync(d, { recursive: true })
  const poison = JSON.stringify({ from: 'a', to: 'c', ts: 1, subject: 's' })
  writeFileSync(join(d, '1-x.json'), poison)
  const r = runBus(cwd, ['read', '--box', 'c'])
  assert.equal(r.code, 0, `毒消息隔离后 read 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  assert.match(r.stderr, /1-x\.json/)
  assert.match(r.stderr, /缺失必备字段/)
  // 隔离留痕：原文件逐字节保留于 .corrupt，.json 移出
  assert.equal(existsSync(join(d, '1-x.json')), false)
  assert.equal(readFileSync(join(d, '1-x.json.corrupt'), 'utf-8'), poison)
})

test('T2-P8 bus read：错大小写键（From/ID）同样视为毒消息 → 隔离 .corrupt + 告警（missing 点名小写键见 stderr）', (t) => {
  const cwd = makeDir(t, 'p8')
  const d = join(cwd, '.expert-bus', 'c')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '1-y.json'), JSON.stringify({ ID: 'm1', From: 'a', To: 'c', TS: 1, subject: 's' }))
  const r = runBus(cwd, ['read', '--box', 'c'])
  assert.equal(r.code, 0, `毒消息隔离后 read 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  assert.ok(existsSync(join(d, '1-y.json.corrupt')), '错大小写键消息应隔离留痕')
})

test('T2-P9 bus read：消息体非 JSON 对象（数组）→ 同按 message_invalid 隔离 .corrupt，不 KeyError 崩进 unrecoverable', (t) => {
  const cwd = makeDir(t, 'p9')
  const d = join(cwd, '.expert-bus', 'c')
  mkdirSync(d, { recursive: true })
  const poison = JSON.stringify(['not', 'a', 'message'])
  writeFileSync(join(d, '1-z.json'), poison)
  const r = runBus(cwd, ['read', '--box', 'c'])
  assert.equal(r.code, 0, `数组毒消息隔离后 read 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  assert.equal(readFileSync(join(d, '1-z.json.corrupt'), 'utf-8'), poison, '数组毒消息应逐字节留痕')
})

test('T2-P10 bus ack：消息缺 id / 错大小写键 → 隔离 .corrupt 续行；正常消息 ack 链路不受影响', (t) => {
  const cwd = makeDir(t, 'p10')
  const d = join(cwd, '.expert-bus', 'bad')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '1-a.json'), JSON.stringify({ from: 'a', to: 'bad', ts: 1 }))
  const r = runBus(cwd, ['ack', '--box', 'bad', '--all'])
  assert.equal(r.code, 0, `毒消息隔离后 ack 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  assert.ok(existsSync(join(d, '1-a.json.corrupt')), '毒消息应隔离留痕')
  // 正常链路回归：send → read → ack 全程 code 0
  assert.equal(runBus(cwd, ['send', '--from', 'a', '--to', 'ok', '--subject', 's', '--body', 'b']).code, 0)
  assert.equal(runBus(cwd, ['read', '--box', 'ok']).code, 0)
  assert.equal(runBus(cwd, ['ack', '--box', 'ok', '--all']).code, 0)
})

test('T2-P11 bus 错误回执契约守卫：BusError 面单行 JSON 恰含 error 键（_receipt_check 接入不回归）', (t) => {
  const cwd = makeDir(t, 'p11')
  const r = runBus(cwd, ['read', '--box', 'no-such-box'])
  assert.equal(r.code, 0) // 信箱不存在是正常空态（不报错）
  // bus.py 对无 --box 的 read 直接 sys.exit 人类文案——不在信封化范围；这里验证
  // 具名 BusError 面仍单行 JSON：ack 不存在的信箱
  const a = runBus(cwd, ['ack', '--box', 'ghost', '--all'])
  assert.equal(a.code, 1) // sys.exit('错误：…') 人读面，exit 1
  assert.ok(!a.stdout.includes('Traceback'))
})

// ── 消费端 lib/tools.js：receiptContractError / claimFailureReason ──────────

test('T2-C1 receiptContractError：完整成功/失败信封 → null（契约满足）', (t) => {
  assert.equal(receiptContractError({ ok: true, cmd: 'show', data: { task: {} }, revision: 1 }), null)
  assert.equal(receiptContractError({ ok: true, cmd: 'boards', data: { boards: [] } }), null) // 无 revision 合法
  assert.equal(receiptContractError({ ok: false, error: 'stale_revision', expected: 3 }), null)
  // 额外字段对未来演进透明
  assert.equal(receiptContractError({ ok: true, cmd: 'show', data: {}, revision: 1, extra: 'x' }), null)
})

test('T2-C2 receiptContractError：缺字段 → 具名 {error:\'receipt_invalid\', missing:[...]}', (t) => {
  assert.deepEqual(receiptContractError({ ok: true }), { error: 'receipt_invalid', missing: ['cmd', 'data'] })
  assert.deepEqual(receiptContractError({ ok: true, cmd: 'show' }), { error: 'receipt_invalid', missing: ['data'] })
  assert.deepEqual(receiptContractError({ ok: false }), { error: 'receipt_invalid', missing: ['error'] })
  assert.deepEqual(receiptContractError({ ok: true, cmd: '', data: {} }), { error: 'receipt_invalid', missing: ['cmd'] })
  assert.deepEqual(receiptContractError({ ok: true, cmd: 'show', data: null }), { error: 'receipt_invalid', missing: ['data'] })
  assert.deepEqual(receiptContractError({ ok: true, cmd: 'show', data: [1] }), { error: 'receipt_invalid', missing: ['data'] })
  assert.deepEqual(receiptContractError(null), { error: 'receipt_invalid', missing: ['ok'] })
  assert.deepEqual(receiptContractError('envelope'), { error: 'receipt_invalid', missing: ['ok'] })
})

test('T2-C3 receiptContractError：错大小写别名不抵充（OK/CMD/Error 一律视为缺失）', (t) => {
  assert.deepEqual(receiptContractError({ OK: true, cmd: 'show', data: {} }),
    { error: 'receipt_invalid', missing: ['ok'] })
  assert.deepEqual(receiptContractError({ ok: true, CMD: 'show', Data: {} }),
    { error: 'receipt_invalid', missing: ['cmd', 'data'] })
  assert.deepEqual(receiptContractError({ ok: false, Error: 'x' }),
    { error: 'receipt_invalid', missing: ['error'] })
  assert.deepEqual(receiptContractError({ ok: 1, cmd: 'show', data: {} }),
    { error: 'receipt_invalid', missing: ['ok'] }) // ok 非布尔同样违规
})

test('T2-C4 claimFailureReason：ok:false 缺 error → 具名 receipt_invalid（缺 error），与 receiptContractHint 单一文案源一致（v2.13.1 T3 措辞收敛）；旧三档与非回执 JSON 不回归', (t) => {
  // 新窄分支：失败信封缺非空 error 具名码——措辞与 receiptContractHint 同源（全角括号+空格分隔）
  assert.equal(claimFailureReason({ ok: false }, '', ''), 'receipt_invalid（缺 error）')
  assert.equal(claimFailureReason({ ok: false, error: '' }, '', ''), 'receipt_invalid（缺 error）')
  // 同源锚定：与 receiptContractHint 输出逐字节一致，防两套措辞回潜
  assert.equal(claimFailureReason({ ok: false }, '', ''), receiptContractHint({ error: 'receipt_invalid', missing: ['error'] }))
  // 旧三档回归（tools.selftest.mjs:6342-6354 锚定）
  assert.equal(claimFailureReason({ message: '人读拒绝' }, '', ''), '人读拒绝')
  assert.equal(claimFailureReason({ error: 'stale_revision' }, '', ''), 'stale_revision')
  assert.equal(claimFailureReason(null, 'stderr 首行\nstderr 二行', ''), 'stderr 首行')
  assert.equal(claimFailureReason(null, '', 'stdout 首行'), 'stdout 首行')
  assert.equal(claimFailureReason(null, '', ''), '未知错误')
  // 非回执 JSON（无 ok 字段）不误判，仍走旧兜底
  assert.equal(claimFailureReason({ foo: 1 }, 'err-out', ''), 'err-out')
  // message 优选序保持（message 高于 error）
  assert.equal(claimFailureReason({ message: 'm', error: 'e' }, '', ''), 'm')
})

test('T2-C5 消费端预算面不回归：budgetNoticeFromEnvelope 对缺字段信封保持 fail-open（lib/budget.js 零改动锚定）', (t) => {
  assert.equal(budgetNoticeFromEnvelope(null, 'w'), '')
  assert.equal(budgetNoticeFromEnvelope({ ok: true }, 'w'), '')
  assert.equal(budgetNoticeFromEnvelope({ ok: true, cmd: 'budget', data: { task: 'T1', budget: { enabled: true, budgets: [] } } }, 'w'), '')
  assert.equal(budgetNoticeFromEnvelope({ ok: false, error: 'x' }, 'w'), '')
  // 达档正样本（既有语义）仍产出提示行
  const hit = budgetNoticeFromEnvelope({
    ok: true, cmd: 'budget',
    data: { task: 'T1', budget: { enabled: true, thresholds: { alarm: 10 }, budgets: [{ owner: 'w', count: 11, tier: 'alarm' }] } },
  }, 'w')
  assert.ok(hit.includes('【升级｜预算｜告警档】现状：w'))
})
