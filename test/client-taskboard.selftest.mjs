// test/client-taskboard.selftest.mjs — 任务板纯函数自测（node:test，零依赖）。
// lib/client.js 是 ModuleLoader 文本 bundle（window.__ModuleLoader__ 包裹，node 不可直接
// import），纯函数区以 `// TB-PURE-BEGIN` / `// TB-PURE-END` 标记隔离；本测试从源码文本
// 提取该区段后 new Function 求值——单一真相：被测代码即交付代码。覆盖任务书 M4：
// resolveBoard 三态 / parseBoard 宽容与拒绝 / groupByStatus 八状态 / computeDepBadges 环与未知 id。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')

const BEGIN = '// TB-PURE-BEGIN'
const END = '// TB-PURE-END'
const beginCount = source.split(BEGIN).length - 1
const endCount = source.split(END).length - 1
const beginIndex = source.indexOf(BEGIN)
const endIndex = source.indexOf(END)

test('TB-PURE 标记恰各一次且次序正确（提取契约）', () => {
  assert.equal(beginCount, 1)
  assert.equal(endCount, 1)
  assert.ok(beginIndex >= 0 && endIndex > beginIndex)
})

const tb = new Function(
  source.slice(beginIndex + BEGIN.length, endIndex)
    + '\n;return { TB_STATUS_LANES, TB_LANE_ORDER, resolveBoard: tbResolveBoard, parseBoard: tbParseBoard,'
    + ' groupByStatus: tbGroupByStatus, computeDepBadges: tbComputeDepBadges, countRunning: tbCountRunning, diffCount: tbDiffCount };',
)()

function makeTask(overrides) {
  return {
    id: 'T1', title: '任务一', status: 'ready', owner: null, dep: [], desc: '',
    created: null, updated: null, summary: '', fail: '', scope: [], ...overrides,
  }
}

// ---------- resolveBoard 三态 ----------

test('resolveBoard: 非数组/空清单 → none', () => {
  assert.deepEqual(tb.resolveBoard(null), { kind: 'none' })
  assert.deepEqual(tb.resolveBoard(undefined), { kind: 'none' })
  assert.deepEqual(tb.resolveBoard('x'), { kind: 'none' })
  assert.deepEqual(tb.resolveBoard([]), { kind: 'none' })
})

test('resolveBoard: 顶层恰一个 *.json → ok', () => {
  const resolved = tb.resolveBoard([
    { name: 'board.json', type: 'file', size: 12 },
    { name: 'board.json.lock', type: 'file' },
    { name: 'board.events.jsonl', type: 'file' },
    { name: 'notes.md', type: 'file' },
  ])
  assert.deepEqual(resolved, { kind: 'ok', file: 'board.json' })
})

test('resolveBoard: 目录项与缺 type 的条目宽容处理', () => {
  assert.deepEqual(tb.resolveBoard([{ name: 'b.json', type: 'file' }]), { kind: 'ok', file: 'b.json' })
  assert.equal(tb.resolveBoard([{ name: 'sub', type: 'directory' }, { name: 'b.json', type: 'file' }]).file, 'b.json')
  assert.equal(tb.resolveBoard([{ name: 'b.json', type: 'directory' }]).kind, 'none')
})

test('resolveBoard: 多个 *.json → ambiguous（宁漏勿错，不猜测）', () => {
  const resolved = tb.resolveBoard([
    { name: 'a.json', type: 'file', mtime: 111 },
    { name: 'b.json', type: 'file', mtime: 222, fromChat: true },
  ])
  assert.equal(resolved.kind, 'ambiguous')
  assert.deepEqual(resolved.candidates, [
    { name: 'a.json', mtime: 111, fromChat: false },
    { name: 'b.json', mtime: 222, fromChat: true },
  ])
})

// ---------- parseBoard 宽容与拒绝 ----------

test('parseBoard: 最小合法板（可选字段缺省给安全默认）', () => {
  const parsed = tb.parseBoard(JSON.stringify({ tasks: { T1: { id: 'T1', title: 'x', status: 'running' } } }))
  assert.equal(parsed.ok, true)
  const task = parsed.board.tasks.T1
  assert.equal(task.owner, null)
  assert.deepEqual(task.dep, [])
  assert.deepEqual(task.scope, [])
  assert.equal(task.desc, '')
  assert.equal(task.summary, '')
  assert.equal(task.fail, '')
  assert.equal(parsed.board.revision, null)
  assert.equal(parsed.board.seq, null)
  assert.equal(task.statusKnown, true)
})

test('parseBoard: 宽容——可选字段类型不对时过滤/降级而非拒绝', () => {
  const parsed = tb.parseBoard(JSON.stringify({
    revision: 'n/a', seq: 3,
    tasks: { T1: { id: 'T1', title: 'x', status: 'done', dep: ['T2', 5, null, ''], scope: ['lib', 42], owner: 7 } },
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.board.revision, null) // 非数字 revision → null
  assert.equal(parsed.board.seq, 3)
  assert.deepEqual(parsed.board.tasks.T1.dep, ['T2'])
  assert.deepEqual(parsed.board.tasks.T1.scope, ['lib'])
  assert.equal(parsed.board.tasks.T1.owner, null) // 非字符串 owner → null
})

test('parseBoard: 拒绝——结构性字段缺失/类型不对', () => {
  assert.equal(tb.parseBoard('').ok, false)
  assert.equal(tb.parseBoard('   ').ok, false)
  assert.equal(tb.parseBoard('not json').ok, false)
  assert.equal(tb.parseBoard('[]').ok, false)
  assert.equal(tb.parseBoard('"str"').ok, false)
  assert.equal(tb.parseBoard('{"revision":1}').ok, false) // 缺 tasks
  assert.equal(tb.parseBoard('{"tasks":[]}').ok, false) // tasks 是数组
  assert.equal(tb.parseBoard('{"tasks":{"T1":null}}').ok, false)
  assert.equal(tb.parseBoard('{"tasks":{"T1":{"title":"x","status":"done"}}}').ok, false) // 缺 id
  assert.equal(tb.parseBoard('{"tasks":{"T1":{"id":"T1","status":"done"}}}').ok, false) // 缺 title
  assert.equal(tb.parseBoard('{"tasks":{"T1":{"id":"T1","title":"x"}}}').ok, false) // 缺 status
  const bad = tb.parseBoard('{"tasks":{"T1":{"id":"T1","title":"x","status":"done"},"T2":42}}')
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'task:T2')
})

test('parseBoard: 未知 status 保留原值并标注 statusKnown=false', () => {
  const parsed = tb.parseBoard(JSON.stringify({ tasks: { T9: { id: 'T9', title: 'x', status: 'chaos' } } }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.board.tasks.T9.status, 'chaos')
  assert.equal(parsed.board.tasks.T9.statusKnown, false)
})

// ---------- groupByStatus 八状态映射 ----------

test('groupByStatus: 八个已知状态落四泳道', () => {
  const tasks = {
    T1: makeTask({ id: 'T1', status: 'draft' }),
    T2: makeTask({ id: 'T2', status: 'pending' }),
    T3: makeTask({ id: 'T3', status: 'ready' }),
    T4: makeTask({ id: 'T4', status: 'running' }),
    T5: makeTask({ id: 'T5', status: 'done' }),
    T6: makeTask({ id: 'T6', status: 'failed' }),
    T7: makeTask({ id: 'T7', status: 'rejected' }),
    T8: makeTask({ id: 'T8', status: 'escalated' }),
  }
  const lanes = tb.groupByStatus(tasks)
  assert.deepEqual(tb.TB_LANE_ORDER, ['attention', 'running', 'todo', 'done'])
  assert.deepEqual(lanes.attention.map(t0 => t0.id), ['T6', 'T7', 'T8'])
  assert.deepEqual(lanes.running.map(t0 => t0.id), ['T4'])
  assert.deepEqual(lanes.todo.map(t0 => t0.id), ['T1', 'T2', 'T3'])
  assert.deepEqual(lanes.done.map(t0 => t0.id), ['T5'])
})

test('groupByStatus: 未知状态落「需要注意」且 statusKnown=false', () => {
  const lanes = tb.groupByStatus({ T9: makeTask({ id: 'T9', status: 'chaos' }) })
  assert.equal(lanes.attention.length, 1)
  assert.equal(lanes.attention[0].statusKnown, false)
})

test('groupByStatus: 组内 updated 降序，缺失排后并按 id 稳定', () => {
  const tasks = {
    TA: makeTask({ id: 'TA', status: 'running', updated: '2026-01-01T00:00:00Z' }),
    TB: makeTask({ id: 'TB', status: 'running', updated: '2026-01-02T00:00:00Z' }),
    TC: makeTask({ id: 'TC', status: 'running', updated: null }),
    TD: makeTask({ id: 'TD', status: 'running', updated: '2026-01-01T00:00:00Z' }),
  }
  const lanes = tb.groupByStatus(tasks)
  assert.deepEqual(lanes.running.map(t0 => t0.id), ['TB', 'TA', 'TD', 'TC'])
})

// ---------- computeDepBadges：阻塞 / 未知 id / 环防御 ----------

test('computeDepBadges: dep 指向 status≠done 为阻塞，指向 done 不阻塞', () => {
  const tasks = {
    T1: makeTask({ id: 'T1', status: 'running', dep: ['T2', 'T3'] }),
    T2: makeTask({ id: 'T2', status: 'running' }),
    T3: makeTask({ id: 'T3', status: 'done' }),
  }
  const badges = tb.computeDepBadges(tasks)
  assert.deepEqual(badges.blocked, { T1: ['T2'] })
  assert.deepEqual(badges.missing, {})
  assert.deepEqual(badges.cycles, [])
})

test('computeDepBadges: dep 指向未知 id 记入 missing，不误报阻塞', () => {
  const badges = tb.computeDepBadges({ T1: makeTask({ id: 'T1', status: 'ready', dep: ['T404'] }) })
  assert.deepEqual(badges.blocked, {})
  assert.deepEqual(badges.missing, { T1: ['T404'] })
})

test('computeDepBadges: 重复 dep 去重', () => {
  const badges = tb.computeDepBadges({
    T1: makeTask({ id: 'T1', status: 'ready', dep: ['T2', 'T2'] }),
    T2: makeTask({ id: 'T2', status: 'pending' }),
  })
  assert.deepEqual(badges.blocked, { T1: ['T2'] })
})

test('computeDepBadges: 环防御——双向环检出且不递归不挂起', () => {
  const tasks = {
    T1: makeTask({ id: 'T1', status: 'running', dep: ['T2'] }),
    T2: makeTask({ id: 'T2', status: 'running', dep: ['T1'] }),
  }
  const badges = tb.computeDepBadges(tasks)
  assert.equal(badges.cycles.length, 2)
  assert.ok(badges.cycles.includes('T1') && badges.cycles.includes('T2'))
  assert.deepEqual(badges.blocked, { T1: ['T2'], T2: ['T1'] }) // 环照常记阻塞，不展开传播
})

test('computeDepBadges: 自指 dep 检出为环', () => {
  const badges = tb.computeDepBadges({ T1: makeTask({ id: 'T1', status: 'ready', dep: ['T1'] }) })
  assert.deepEqual(badges.cycles, ['T1'])
})

test('computeDepBadges: 空板/缺 dep 字段安全', () => {
  assert.deepEqual(tb.computeDepBadges({}), { blocked: {}, missing: {}, cycles: [] })
  assert.deepEqual(tb.computeDepBadges(null), { blocked: {}, missing: {}, cycles: [] })
  const badges = tb.computeDepBadges({ T1: { id: 'T1', status: 'ready' } }) // 无 dep 字段
  assert.deepEqual(badges.blocked, {})
})

// ---------- countRunning / diffCount（徽标与 keyed diff 刷新） ----------

test('countRunning: 只数 running', () => {
  assert.equal(tb.countRunning({
    A: makeTask({ id: 'A', status: 'running' }),
    B: makeTask({ id: 'B', status: 'running' }),
    C: makeTask({ id: 'C', status: 'done' }),
  }), 2)
  assert.equal(tb.countRunning(null), 0)
})

test('diffCount: 新增/移除/字段变化各计 1，未变不计', () => {
  const prev = {
    T1: makeTask({ id: 'T1', status: 'running', updated: 'u1' }),
    T2: makeTask({ id: 'T2', status: 'done', updated: 'u2' }),
  }
  assert.equal(tb.diffCount(prev, {
    T1: makeTask({ id: 'T1', status: 'done', updated: 'u1b' }), // 字段变化
    T3: makeTask({ id: 'T3', status: 'ready' }), // 新增
  }), 3) // T1 变化 + T2 移除 + T3 新增
  assert.equal(tb.diffCount(prev, prev), 0)
  assert.equal(tb.diffCount(null, prev), 2)
})
