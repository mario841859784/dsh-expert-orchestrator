// test/client-taskboard.selftest.mjs — 任务板纯函数自测（node:test，零依赖）。
// lib/client.js 是 ModuleLoader 文本 bundle（window.__ModuleLoader__ 包裹，node 不可直接
// import），纯函数区以 `// TB-PURE-BEGIN` / `// TB-PURE-END` 标记隔离；本测试从源码文本
// 提取该区段后 new Function 求值——单一真相：被测代码即交付代码。覆盖任务书 M4：
// resolveBoard 三态 / parseBoard 宽容与拒绝 / groupByStatus 八状态 / computeDepBadges 环与未知 id。
// T2 多板切换器纯函数层：listBoards / pickBoard / boardSwitchPatch / uiCache* 两级键与旧条目降级。
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
    + ' groupByStatus: tbGroupByStatus, computeDepBadges: tbComputeDepBadges, countRunning: tbCountRunning, diffCount: tbDiffCount,'
    + ' isAgentCreated: tbIsAgentCreated, isAgentDraft: tbIsAgentDraft,'
    + ' tbInitialDoneFold: tbInitialDoneFold,'
    + ' isBoardEntry: tbIsBoardEntry, entryFromChat: tbEntryFromChat, listBoards: tbListBoards, pickBoard: tbPickBoard,'
    + ' boardSwitchPatch: tbBoardSwitchPatch,'
    + ' uiCacheKey: tbUiCacheKey, uiCacheSelectedKey: tbUiCacheSelectedKey, uiCacheRead: tbUiCacheRead,'
    + ' uiCacheWrite: tbUiCacheWrite, uiCacheReadSelected: tbUiCacheReadSelected, uiCacheWriteSelected: tbUiCacheWriteSelected,'
    + ' isTap: tbIsTap, TB_TAP_SLOP_PX: TB_TAP_SLOP_PX };',
)()

function makeTask(overrides) {
  return {
    id: 'T1', title: '任务一', status: 'ready', owner: null, dep: [], desc: '',
    created: null, updated: null, summary: '', fail: '', scope: [], created_by: null, ...overrides,
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

// ---------- T3 created_by 来源字段（M1 契约：单键字符串；lead 派发缺省） ----------

test('parseBoard: created_by 字符串保留、非字符串/空串归一 null、缺省=null（lead 派发语义）', () => {
  const parsed = tb.parseBoard(JSON.stringify({
    tasks: {
      A: { id: 'A', title: 'x', status: 'draft', created_by: 'frontend-engineer' },
      B: { id: 'B', title: 'x', status: 'draft', created_by: 42 },
      C: { id: 'C', title: 'x', status: 'draft', created_by: '' },
      D: { id: 'D', title: 'x', status: 'ready' },
    },
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.board.tasks.A.created_by, 'frontend-engineer')
  assert.equal(parsed.board.tasks.B.created_by, null) // 非字符串 → null
  assert.equal(parsed.board.tasks.C.created_by, null) // 空串 → null
  assert.equal(parsed.board.tasks.D.created_by, null) // 缺省 → null（lead 派发不落该字段）
})

test('isAgentCreated/isAgentDraft: created_by 非空判定（缺省/非字符串/null 均非代理创建）', () => {
  assert.equal(tb.isAgentCreated(makeTask({ created_by: 'backend-engineer' })), true)
  assert.equal(tb.isAgentCreated(makeTask({})), false) // 缺省 null
  assert.equal(tb.isAgentCreated(makeTask({ created_by: '' })), false)
  assert.equal(tb.isAgentCreated(makeTask({ created_by: 7 })), false)
  assert.equal(tb.isAgentCreated(null), false)
  assert.equal(tb.isAgentDraft(makeTask({ status: 'draft', created_by: 'backend-engineer' })), true)
  assert.equal(tb.isAgentDraft(makeTask({ status: 'ready', created_by: 'backend-engineer' })), false) // 非 draft
  assert.equal(tb.isAgentDraft(makeTask({ status: 'draft' })), false) // lead 草稿
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

test('groupByStatus: 代理待批草稿（draft+created_by）提升「需要注意」，lead 草稿留「待处理」', () => {
  const lanes = tb.groupByStatus({
    TA: makeTask({ id: 'TA', status: 'draft', statusKnown: true, created_by: 'frontend-engineer' }),
    TB: makeTask({ id: 'TB', status: 'draft', statusKnown: true }),
  })
  assert.deepEqual(lanes.attention.map(t0 => t0.id), ['TA']) // 代理草稿 → 注意泳道（验收 b 泳道呈现）
  assert.deepEqual(lanes.todo.map(t0 => t0.id), ['TB']) // lead 草稿 → 原位
  assert.equal(lanes.attention[0].statusKnown, true) // draft 是已知状态——仅路由提升，不算未知状态
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

// ---------- tbInitialDoneFold（spec v2 sidebar-ux R1：done 折叠初值） ----------

test('tbInitialDoneFold: done≥3 且存在非 done 任务 → 折叠', () => {
  assert.equal(tb.tbInitialDoneFold(3, 5), true)
  assert.equal(tb.tbInitialDoneFold(4, 5), true)
  assert.equal(tb.tbInitialDoneFold(10, 11), true)
})

test('tbInitialDoneFold: 全板完成/不足 3/空板 → 不折叠（永不自动折叠全完成板）', () => {
  assert.equal(tb.tbInitialDoneFold(5, 5), false) // 全板完成永不自动折叠
  assert.equal(tb.tbInitialDoneFold(2, 5), false) // 不足 3
  assert.equal(tb.tbInitialDoneFold(0, 0), false) // 空板
  assert.equal(tb.tbInitialDoneFold(3, 0), false) // total 0 防御
  assert.equal(tb.tbInitialDoneFold(null, null), false)
})

// ---------- T2 多板切换器：tbListBoards（spec §12.7 裁决⑤） ----------

test('listBoards: label 去 .json 后缀、mtime 新→旧、fromChat/hasEvents 标注；lock/events.jsonl/目录不算板', () => {
  const boards = tb.listBoards([
    { name: 'a.json', type: 'file', mtime: 100 },
    { name: 'b.json', type: 'file', mtime: 200, fromChat: true },
    { name: 'b.json.events.jsonl', type: 'file' },
    { name: 'a.json.lock', type: 'file' },
    { name: 'notes.md', type: 'file' },
    { name: 'sub', type: 'directory' },
    { name: 'dir.json', type: 'directory' }, // 目录条目不算板
  ])
  assert.deepEqual(boards, [
    { file: 'b.json', label: 'b', mtime: 200, fromChat: true, hasEvents: true },
    { file: 'a.json', label: 'a', mtime: 100, fromChat: false, hasEvents: false },
  ])
})

test('listBoards: mtime 缺失排后、同缺按文件名稳定；后缀去 .json 不分大小写', () => {
  const boards = tb.listBoards([
    { name: 'c.json', mtime: null },
    { name: 'Board.JSON', type: 'file', mtime: 5 },
    { name: 'b.json', type: 'file' },
  ])
  assert.deepEqual(boards.map((board) => board.file), ['Board.JSON', 'b.json', 'c.json'])
  assert.equal(boards[0].label, 'Board')
  assert.deepEqual(boards.map((board) => board.mtime), [5, null, null])
})

test('listBoards: 非 entries 输入 → 空数组（无板不炸）', () => {
  assert.deepEqual(tb.listBoards(null), [])
  assert.deepEqual(tb.listBoards(undefined), [])
  assert.deepEqual(tb.listBoards('x'), [])
  assert.deepEqual(tb.listBoards([]), [])
})

test('listBoards: 配对边界——无 events、同名残留 .lock、events 为目录均不配对', () => {
  const noEvents = tb.listBoards([{ name: 'a.json', type: 'file', mtime: 1 }])
  assert.equal(noEvents[0].hasEvents, false)
  const lockOnly = tb.listBoards([{ name: 'a.json', type: 'file', mtime: 1 }, { name: 'a.json.lock', type: 'file' }])
  assert.equal(lockOnly[0].hasEvents, false) // .lock 是锁残留，不是 events 配对
  const dirEvents = tb.listBoards([{ name: 'a.json', type: 'file', mtime: 1 }, { name: 'a.json.events.jsonl', type: 'directory' }])
  assert.equal(dirEvents[0].hasEvents, false) // events 条目不是文件不配对
})

// ---------- T2 多板切换器：tbPickBoard（spec §12.4 R1 修复） ----------

test('pickBoard: currentFile 仍在目录 → 原样保持（刷新永不改变选定板，即便别的板更新）', () => {
  const entries = [
    { name: 'new.json', type: 'file', mtime: 999 },
    { name: 'current.json', type: 'file', mtime: 1 },
  ]
  assert.deepEqual(tb.pickBoard(entries, 'current.json'), { kind: 'ok', file: 'current.json' })
})

test('pickBoard: currentFile 消失 → 回退 tbResolveBoard 三态透传（ambiguous 候选原样）', () => {
  const entries = [{ name: 'a.json', type: 'file', mtime: 111 }, { name: 'b.json', type: 'file', mtime: 222, fromChat: true }]
  const picked = tb.pickBoard(entries, 'gone.json')
  assert.equal(picked.kind, 'ambiguous')
  assert.deepEqual(picked, tb.resolveBoard(entries)) // 透传 = 与三态解析逐字段一致
})

test('pickBoard: currentFile 消失且目录单板/空/非数组 → ok/none 透传', () => {
  assert.deepEqual(tb.pickBoard([{ name: 'only.json', type: 'file' }], 'gone.json'), { kind: 'ok', file: 'only.json' })
  assert.deepEqual(tb.pickBoard([], 'gone.json'), { kind: 'none' })
  assert.deepEqual(tb.pickBoard(null, 'gone.json'), { kind: 'none' })
})

test('pickBoard: currentFile 空或非板条目（目录型/非 .json）→ 直接三态解析', () => {
  const entries = [{ name: 'only.json', type: 'file' }]
  assert.deepEqual(tb.pickBoard(entries, null), { kind: 'ok', file: 'only.json' })
  assert.deepEqual(tb.pickBoard(entries, ''), { kind: 'ok', file: 'only.json' })
  assert.deepEqual(tb.pickBoard(entries, undefined), { kind: 'ok', file: 'only.json' })
  assert.deepEqual(tb.pickBoard([{ name: 'dir.json', type: 'directory' }, { name: 'x.txt', type: 'file' }], 'x.txt'), { kind: 'none' })
  assert.deepEqual(tb.pickBoard([{ name: 'dir.json', type: 'directory' }], 'dir.json'), { kind: 'none' })
})

// ---------- T2 多板切换器：tbBoardSwitchPatch（spec §12.4 五步 + §12.5 默认初值） ----------

test('boardSwitchPatch: 受控重载五步重置面完整（abort/version/seq/防抖/锚点 + UI 六字段默认）', () => {
  const patch = tb.boardSwitchPatch()
  assert.deepEqual(Object.keys(patch).sort(), ['abortInFlight', 'clearAnchor', 'clearDebounce', 'resetUi', 'seqIncrement', 'versionReset'])
  assert.equal(patch.abortInFlight, true)
  assert.equal(patch.versionReset, true)
  assert.equal(patch.seqIncrement, 1)
  assert.equal(patch.clearDebounce, true)
  assert.equal(patch.clearAnchor, true)
  assert.deepEqual(patch.resetUi, {
    expandedId: null,
    doneFolded: null, // null = 交初载按 tbInitialDoneFold 推导 / L3 命中恢复
    ownerFilter: null,
    blockedOnly: false,
    statusFilter: [],
    scrollTop: 0,
  })
})

test('boardSwitchPatch: 每次调用返回新对象（重置面不共享可变引用）', () => {
  const first = tb.boardSwitchPatch()
  first.resetUi.statusFilter.push('running')
  const second = tb.boardSwitchPatch()
  assert.notEqual(first.resetUi.statusFilter, second.resetUi.statusFilter)
  assert.deepEqual(second.resetUi.statusFilter, [])
  assert.deepEqual(tb.boardSwitchPatch(), tb.boardSwitchPatch()) // 内容恒等
})

// ---------- T2 多板切换器：L3 缓存键扩展（spec §12.5，旧条目无 board 字段视为未命中） ----------

test('uiCacheKey: 两级组合键；sessionId/board 任一为空或非字符串 → null', () => {
  assert.equal(tb.uiCacheKey('sid', 'a.json'), 'sid\u0000a.json')
  assert.equal(tb.uiCacheKey('', 'a.json'), null)
  assert.equal(tb.uiCacheKey('sid', ''), null)
  assert.equal(tb.uiCacheKey(null, 'a.json'), null)
  assert.equal(tb.uiCacheKey('sid', 42), null)
  assert.equal(tb.uiCacheSelectedKey('sid'), 'sid\u0000\u0000selected')
  assert.equal(tb.uiCacheSelectedKey(''), null)
})

test('uiCacheWrite→uiCacheRead: 往返一致且规范化（垃圾字段收纳为安全默认）', () => {
  const cache = {}
  const written = tb.uiCacheWrite(cache, 'sid', 'a.json', {
    expandedId: 'T3', doneFolded: true, ownerFilter: 'alice', blockedOnly: true,
    statusFilter: ['done', 42, ''], scrollTop: 320, junk: 'ignored',
  })
  assert.equal(written.board, 'a.json')
  assert.deepEqual(tb.uiCacheRead(cache, 'sid', 'a.json'), {
    board: 'a.json',
    expandedId: 'T3',
    doneFolded: true,
    ownerFilter: 'alice',
    blockedOnly: true,
    statusFilter: ['done'],
    scrollTop: 320,
  })
  // 读返回副本：改读结果不影响缓存
  const view = tb.uiCacheRead(cache, 'sid', 'a.json')
  view.statusFilter.push('running')
  assert.deepEqual(tb.uiCacheRead(cache, 'sid', 'a.json').statusFilter, ['done'])
})

test('uiCacheRead: 旧条目（一级 sessionId 平铺，无 board 字段）视为未命中降级，不做迁移', () => {
  const legacy = {
    expandedId: 'T1', doneFolded: true, ownerFilter: 'x', blockedOnly: true,
    statusFilter: ['done'], scrollTop: 88,
  }
  assert.equal(tb.uiCacheRead({ sid: legacy }, 'sid', 'a.json'), null) // 旧键不命中
  assert.equal(tb.uiCacheRead({ 'sid\u0000a.json': legacy }, 'sid', 'a.json'), null) // 同键位但无 board 标记 → 未命中
  assert.equal(tb.uiCacheRead(null, 'sid', 'a.json'), null)
  assert.equal(tb.uiCacheRead({}, 'sid', 'a.json'), null)
  // 旧条目保留原位（不覆盖不迁移），新键写入互不干扰
  const cache = { sid: legacy }
  tb.uiCacheWrite(cache, 'sid', 'a.json', { expandedId: 'T9' })
  assert.deepEqual(cache.sid, legacy)
  assert.equal(tb.uiCacheRead(cache, 'sid', 'b.json'), null) // 未写入的板 → 未命中
})

test('uiCacheReadSelected/WriteSelected: 选定板读写；键/值非法安全', () => {
  const cache = {}
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), null) // 无记录
  assert.equal(tb.uiCacheWriteSelected(cache, 'sid', 'a.json'), true)
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), 'a.json')
  assert.equal(tb.uiCacheWriteSelected(cache, '', 'a.json'), false)
  assert.equal(tb.uiCacheWriteSelected(cache, 'sid', ''), false)
  assert.equal(tb.uiCacheReadSelected(null, 'sid'), null)
  // 板条目与选定条目互不串扰（读适配各认各的标记）
  tb.uiCacheWrite(cache, 'sid', 'a.json', { expandedId: 'T1' })
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), 'a.json')
  assert.notEqual(tb.uiCacheRead(cache, 'sid', 'a.json'), null)
})

// ---------- P0 样式注入 + TB_CSS token 卫生（静态断言） ----------

test('P0: TB_CSS 已随既有 style 注入块进入文档（tag.textContent 含 CSS + TB_CSS）', () => {
  assert.ok(
    source.includes('tag.textContent = CSS + "\\n" + TB_CSS;'),
    '注入点必须同时携带设置页 CSS 与任务板 TB_CSS（修复 TB_CSS 定义后零引用的 P0）',
  )
  // TB_CSS 必须定义在注入点之前（bundle 文本顺序保证注入时已初始化）
  const cssDef = source.indexOf('var TB_CSS = [')
  const injectAt = source.indexOf('tag.textContent = CSS + "\\n" + TB_CSS;')
  assert.ok(cssDef >= 0 && injectAt > cssDef, 'TB_CSS 定义应先于注入点')
})

test('TB_CSS 卫生：幽灵 token 与裸色值零容忍（只用 --dsw-alias-*/--dsw-radius-*）', () => {
  const start = source.indexOf('var TB_CSS = [')
  const end = source.indexOf('var TB_ICONS')
  assert.ok(start >= 0 && end > start, 'TB_CSS 区段定位失败')
  const css = source.slice(start, end)
  for (const ghost of ['label-quaternary', 'fill-l1', 'fill-l2', '--dsw-shadow', 'amber', 'warn-label']) {
    // P2-2 回炉（D2）：warn-label 仅允许出现在暗色 override 行内——逐行断言（注释行除外）。
    // 旧断言 uses<=darkBlocks 近恒真，P1-3 类级联失效（亮色独立规则排在覆盖行之后）永远测不出。
    if (ghost === 'warn-label') {
      const offenders = css
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && line.includes('warn-label') && !line.includes('body[data-ds-dark-theme]'))
      assert.equal(offenders.length, 0, `warn-label 只能出现在暗色 override 行内，亮色命中：\n${offenders.join('\n')}`)
      continue
    }
    assert.ok(!css.includes(ghost), `TB_CSS 不得使用幽灵 token：${ghost}`)
  }
  const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g)
  assert.equal(hexMatches, null, `TB_CSS 不得含十六进制字面量：${hexMatches && hexMatches.join(',')}`)
})

test('spec v2 方向 C：泳道容器化/空泳道占位/完成横幅/密度阶梯/L3 缓存静态锚点齐备', () => {
  // 方向 C：泳道=bg-module-platform 容器；空泳道居中文字占位
  assert.ok(source.includes('className: "eso-tb-lane-empty"'), '空泳道占位应渲染（宽档）')
  assert.ok(/\.eso-tb-lane\s*\{[^}]*bg-module-platform/.test(cssRegion()), '泳道容器应使用 bg-module-platform（方向 C）')
  // 完成横幅
  assert.ok(source.includes('className: "eso-tb-complete"'), '完成横幅应渲染')
  assert.ok(cssRegion().includes('state-success-tertiary'), '横幅底色应为 state-success-tertiary')
  // 密度阶梯 data 属性（w360/compact/xnarrow）
  for (const attr of ['data-eso-tb-w360', 'data-eso-tb-compact', 'data-eso-tb-xnarrow']) {
    assert.ok(source.includes(attr), `密度阶梯缺属性：${attr}`)
  }
  // L3 会话缓存（模块级、零依赖；spec §12.5 两级键 sessionId → board，消费经 tbUiCache* 适配）
  assert.ok(source.includes('var TB_UI_CACHE = Object.create(null);'), 'L3 模块级会话缓存应存在')
  assert.ok(source.includes('tbUiCacheRead(TB_UI_CACHE'), 'L3 缓存应经两级键适配读（spec §12.5，旧一级 sessionId 条目降级未命中）')
  assert.ok(source.includes('tbUiCacheWrite(TB_UI_CACHE'), 'L3 缓存应经两级键适配写（spec §12.5）')
  assert.ok(source.includes('tbUiCacheWriteSelected(TB_UI_CACHE'), '选定板应写入会话缓存（tab 重开直达上次板）')
  // aria 播报双语 key
  for (const key of ['tb.aria.allDone', 'tb.aria.laneFolded', 'tb.aria.laneExpanded', 'tb.aria.filtered', 'tb.scope.count', 'tb.lane.empty']) {
    assert.ok(source.includes(`"${key}"`), `locale 缺 key：${key}`)
  }
  assert.ok(source.includes('全部任务已完成') && source.includes('All tasks are completed'), 'aria key 应中英齐备')
  // 过滤计数 n/m 与筛选按钮标识（F1 焦点防护落点）
  assert.ok(source.includes('filtersActive ? count + "/" + laneTotal'), '泳道头过滤计数应 n/m')
  assert.ok(source.includes('"data-eso-tb-filter": ""'), '筛选按钮应有 data-eso-tb-filter 标识')
})

// ---------- T4 回炉回归：P1-1/P1-2/P1-3 修复锚点（静态断言） ----------

test('回炉 P1-1: xnarrow 档仅隐藏 scope chips，阻塞徽章容器 .eso-tb-card-badges 不再整行隐藏', () => {
  const xnarrowLine = cssRegion().split('\n').filter((line) => line.includes('data-eso-tb-xnarrow') && line.includes('display:none'))
  assert.equal(xnarrowLine.length, 1, 'xnarrow 隐藏规则应恰有一条')
  assert.ok(xnarrowLine[0].includes('.eso-tb-chip'), 'xnarrow 应隐藏 scope chips（chip/chip-more）')
  assert.ok(!xnarrowLine[0].includes('card-badges'), 'xnarrow 不得隐藏 badges 容器——阻塞徽章任何密度档都不得裁剪（spec §3-1）')
})

test('回炉 P1-2: done 折叠泳道不渲染空态占位，占位仅在真实 0 任务时出现', () => {
  assert.ok(
    source.includes('name === "done" ? lanes[name].length === 0 : tasks.length === 0'),
    '空态占位条件应采用真实空判断（done 泳道按未过滤计数）',
  )
  // 折叠分支（渲染 null）必须先于 lane-empty 占位分支（R2/E6：折叠态不出现「无任务」）
  const laneFn = source.slice(source.indexOf('function renderLane'), source.indexOf('function renderCandidates'))
  const foldedAt = laneFn.indexOf('} else if (folded) {')
  const emptyAt = laneFn.indexOf('eso-tb-lane-empty')
  assert.ok(foldedAt >= 0 && emptyAt > foldedAt, '折叠态应渲染 null 且先于空态占位分支')
})

test('回炉 P1-3: .eso-tb-dep-blocked 亮色由 D2 覆盖行治理，独立 warn-label 基础规则已删除', () => {
  const d2LightLine = cssRegion()
    .split('\n')
    .find((line) => line.includes('color:var(--dsw-alias-label-secondary);') && line.includes('.eso-tb-dep-blocked'))
  assert.ok(d2LightLine, 'D2 亮色覆盖行应包含 .eso-tb-dep-blocked（label-secondary，AA 达标）')
  assert.ok(
    !cssRegion().includes('.eso-tb-dep-blocked{color:var(--dsw-alias-state-warn-label);'),
    '独立 warn-label 基础规则不得残留（同特异性后行胜，导致亮色覆盖失效的根因）',
  )
})

function cssRegion() {
  const start = source.indexOf('var TB_CSS = [')
  const end = source.indexOf('var TB_ICONS')
  return start >= 0 && end > start ? source.slice(start, end) : ''
}

// ---------- T6 (2.11.3) 任务板注册门控（静态断言：lib/client.js apply 区非纯函数，按源码文本钉死） ----------

test('T6: 任务板注册块整体移入 ctx.inject 内层插件，依赖 remote.workspaceFiles + sidebarRightTabs', () => {
  assert.ok(
    source.includes('ctx.inject(["remote.workspaceFiles", "sidebarRightTabs"], function taskboardServices(tbCtx) {'),
    '任务板能力块应由 ctx.inject 内层插件承载（服务就绪才激活，修复 rc.3 apply 同步读取早于 api-remotes 异步挂载的时序竞态）',
  )
})

test('T6: workspaceFiles 主途径为 tbCtx.remote.workspaceFiles 属性访问（内层插件内保证就绪）', () => {
  assert.ok(
    source.includes('var workspaceFiles = tbCtx.remote.workspaceFiles;'),
    '内层插件内 ctx.remote.workspaceFiles 属性访问（扁平键经 gateway createNamespace + cordis traceable proxy 解析到同一服务）',
  )
  assert.ok(
    !source.includes('ctx.get("remote.workspaceFiles")'),
    '0.1.7 扁平键兜底已死代码应删除（内层插件激活即保证该服务就绪）',
  )
})

test('T6: 顶层 inject 不含任务板三键（无 sidebar-right 能力宿主 fail-open 不拒载）', () => {
  const m = source.match(/var inject = \[([^\]]*)\];/)
  assert.ok(m, '顶层 inject 声明应存在')
  const keys = m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
  for (const key of ['remote.workspaceFiles', 'sidebarRightTabs', 'sidebarRight']) {
    assert.ok(!keys.includes(key), `顶层 inject 不得硬依赖 ${key}`)
  }
})

test('T6: 三道 fail-open console.info 诊断输出逐字保留', () => {
  for (const msg of [
    'sidebarRight 能力不可用，无法打开任务板 tab（fail-open）',
    'workspaceFiles Remote 不可用，任务板可视化未启用（fail-open）',
    'sidebarRightTabs 能力不可用，任务板 tab 未注册（fail-open）',
  ]) {
    assert.ok(source.includes(`"[dsh-expert-orchestrator] ${msg}"`), `诊断输出应保留：${msg}`)
  }
})

test('T6: workspaceFiles 四方法存在性检查原样保留', () => {
  const m = source.match(
    /if \(workspaceFiles && typeof workspaceFiles\.list === "function" && typeof workspaceFiles\.read === "function"\s*&& typeof workspaceFiles\.stat === "function" && typeof workspaceFiles\.changes === "function"\)/,
  )
  assert.ok(m, 'list/read/stat/changes 四方法检查应完整保留')
})

// ---------- T3 多板切换器 UI 接线消费（spec §12：接线静态锚点，真机冒烟 A26-A34 归 T4） ----------

test('T3 接线: refresh/initialLoad 经 tbPickBoard 裁决——刷新永不改变选定板（R1 修复消费面）', () => {
  assert.ok(source.includes('tbPickBoard(entries, cached)'), '初载应经 tbPickBoard(entries, 缓存选定板) 裁决')
  assert.ok(source.includes('var resolved = tbPickBoard(entries, file);'), 'refresh 应经 tbPickBoard(entries, 选定板) 裁决')
  assert.ok(
    source.includes('if (file && (resolved.kind !== "ok" || resolved.file !== file))'),
    'refresh：选定板消失/目录退化单板 → S5 内联条，不自动换板（spec §12.1）',
  )
})

test('T3 接线: compareRefresh 固定对选定板 stat，不再 listing 重选板（spec §12.4）', () => {
  const fn = source.slice(source.indexOf('function compareRefresh()'), source.indexOf('function scheduleCompareRefresh()'))
  assert.ok(fn.includes('selectedFileRef.current'), 'compareRefresh 应锁定选定板路径')
  assert.ok(fn.includes('io.stat(sessionId, path, signal)'), 'compareRefresh 应直接 stat 选定板')
  assert.ok(!fn.includes('resolveEntries('), 'compareRefresh 不得经目录 listing 重选板（R1 风险源）')
})

test('T3 接线: switchBoard 按 tbBoardSwitchPatch 执行受控重载五步并恢复该板 L3 缓存（spec §12.4/§12.5）', () => {
  const fn = source.slice(source.indexOf('function switchBoard(file)'), source.indexOf('apiRef.current = {'))
  for (const anchor of [
    'var patch = tbBoardSwitchPatch();',
    'if (patch.abortInFlight) abortInFlight();',
    'if (patch.versionReset) versionRef.current = null;',
    'seqRef.current += patch.seqIncrement',
    'if (patch.clearDebounce && debounceRef.current)',
    'tbUiCacheRead(TB_UI_CACHE, sessionId, file)',
    'tbUiCacheWriteSelected(TB_UI_CACHE, sessionId, file)',
  ]) {
    assert.ok(fn.includes(anchor), `switchBoard 缺受控重载步骤：${anchor}`)
  }
})

test('T3 接线: 选择页/下拉/播报 aria 面齐备（spec §12.2/§12.3/§12.8/§12.9）', () => {
  for (const anchor of [
    '"aria-haspopup": "listbox"',
    '"aria-activedescendant"',
    'role: "listbox"',
    'role: "option"',
    '"aria-selected"',
    't("tb.aria.boardSwitched")',
    't("tb.aria.boardMissing")',
    't("tb.boards.missing.title")',
    't("tb.boards.picker.lastUsed")',
    't("tb.boards.switch.empty")',
  ]) {
    assert.ok(source.includes(anchor), `多板切换器缺 aria/文案锚点：${anchor}`)
  }
  // 8 个新词条 zh/en 双语齐备
  for (const key of ['picker.title', 'picker.hint', 'picker.lastUsed', 'switch.label', 'switch.empty', 'missing.title']) {
    assert.ok(source.includes(`"tb.boards.${key}"`), `locale 缺 tb.boards.${key}`)
  }
  assert.ok(source.includes('"tb.aria.boardSwitched"') && source.includes('"tb.aria.boardMissing"'), 'aria 新词条应齐备')
})

// ---------- T3 created-by 来源徽章与代理待批草稿（UI 接线静态锚点 + i18n 双语齐备） ----------

test('T3 接线: 来源徽章仅在 created_by 非空时渲染，lead 派发零渲染（验收 a）', () => {
  // 判定唯一经 tbIsAgentCreated（纯函数区，lead 缺省=null 恒 false）
  assert.ok(source.includes('var agentCreated = tbIsAgentCreated(task);'), 'renderCard 应经 tbIsAgentCreated 判定')
  assert.ok(source.includes('var agentDraft = tbIsAgentDraft(task);'), 'renderCard 应经 tbIsAgentDraft 判定')
  const fn = source.slice(source.indexOf('function renderCard'), source.indexOf('function renderLane'))
  assert.ok(fn.includes('var createdByBadge = agentCreated ? React.createElement'), 'created_by 非空才构造来源徽章')
  assert.ok(fn.includes('t("tb.badge.agentCreated")'), '来源徽章应走 i18n 词条')
  // lead 派发（agentCreated=false）→ 徽章元素为 null，badges.push 不执行
  assert.ok(fn.includes('if (createdByBadge) badges.push(createdByBadge);'), 'lead 派发不得渲染来源徽章')
})

test('T3 接线: 代理待批草稿——attention 泳道 + 待批徽章 + data-pending 卡级显著标记（验收 b）', () => {
  const fn = source.slice(source.indexOf('function renderCard'), source.indexOf('function renderLane'))
  assert.ok(fn.includes('var pendingBadge = agentDraft ? React.createElement'), '代理草稿才构造待批徽章')
  assert.ok(fn.includes('t("tb.badge.pendingApprove")'), '待批徽章应走 i18n 词条')
  assert.ok(fn.includes('"data-pending": agentDraft ? "" : undefined'), '卡根应有 data-pending 标记')
  // 泳道路由：draft+created_by → attention（纯函数已断言）；此处钉死接线消费 tbIsAgentDraft
  assert.ok(source.includes('if (tbIsAgentDraft(task)) {'), 'groupByStatus 应消费 tbIsAgentDraft 提升路由')
})

test('T3 样式: 待批徽章与卡级高亮走 business token，非 lead 草稿弱化规则可被覆盖（同特异性后行胜）', () => {
  const css = cssRegion()
  assert.ok(css.includes('.eso-tb-badge-agent{'), '来源徽章样式应存在')
  assert.ok(css.includes('.eso-tb-badge-pending{'), '待批徽章样式应存在')
  assert.ok(css.includes('.eso-tb-card[data-pending]{'), '待批卡级边框样式应存在')
  // 标题提升规则必须排在 draft 弱化规则之后（同特异性后行胜，否则「显著呈现」失效）；
  // 源码为 JS 字符串字面量（data-status=\"draft\" 带转义引号），故按行内容定位而非整串匹配
  const lines = css.split('\n')
  const draftAt = lines.findIndex((line) => line.includes('.eso-tb-card[data-status=') && line.includes('draft') && line.includes('card-title'))
  const pendingAt = lines.findIndex((line) => line.includes('.eso-tb-card[data-pending]') && line.includes('card-title'))
  assert.ok(draftAt >= 0, 'draft 标题弱化规则应存在')
  assert.ok(pendingAt > draftAt, '待批标题提升应后于 draft 弱化规则')
})

test('T3 i18n: 新词条 zh/en 双语各恰声明一次，无缺译', () => {
  const zhStart = source.indexOf('var zh = {')
  const enStart = source.indexOf('var en = {')
  const enEnd = source.indexOf('\n\t\t};', enStart)
  assert.ok(zhStart >= 0 && enStart > zhStart && enEnd > enStart, 'zh/en 词库定位失败')
  const zhDict = source.slice(zhStart, enStart)
  const enDict = source.slice(enStart, enEnd)
  for (const key of ['tb.badge.agentCreated', 'tb.badge.pendingApprove', 'tb.aria.agentCreated']) {
    // 每 key 双语各恰声明一次：带冒号的 key 声明全源码恰 2 处（zh 1 + en 1）
    assert.equal(source.split(`"${key}":`).length - 1, 2, `${key} 应 zh/en 各恰声明一次`)
    assert.ok(zhDict.includes(`"${key}"`) && enDict.includes(`"${key}"`), `${key} 双语词库均应包含`)
  }
  assert.ok(zhDict.includes('代理创建') && zhDict.includes('待批'), 'zh 文案应存在')
  assert.ok(enDict.includes('Agent-created') && enDict.includes('Awaiting approval'), 'en 文案应存在')
})

// ---------- T4 回归补强：tbPickBoard 裁决面边界（spec §12.4 R1：cached 指向已删板 / 双消失） ----------

test('pickBoard: cached 指向已删除板且目录多板 → ambiguous 透传（候选原样、永不自动猜板）', () => {
  const entries = [
    { name: 'a.json', type: 'file', mtime: 111 },
    { name: 'b.json', type: 'file', mtime: 222, fromChat: true },
    { name: 'c.json', type: 'file', mtime: 333 },
  ]
  const picked = tb.pickBoard(entries, 'deleted.json')
  assert.equal(picked.kind, 'ambiguous')
  assert.deepEqual(picked, tb.resolveBoard(entries))
  assert.deepEqual(picked.candidates.map((c) => c.name), ['a.json', 'b.json', 'c.json'])
})

test('pickBoard: currentFile 精确比较不宽松命中（大小写/非板文件透传三态）', () => {
  // 大小写不匹配：宁漏勿错——双板目录下绝不做 case-insensitive 匹配猜板
  const two = [{ name: 'board.json', type: 'file', mtime: 1 }, { name: 'other.json', type: 'file', mtime: 2 }]
  assert.equal(tb.pickBoard(two, 'Board.JSON').kind, 'ambiguous')
  // currentFile 是非板文件名 → 透传（目录恰一块板 → ok auto-pick；无板 → none）
  assert.deepEqual(tb.pickBoard([{ name: 'board.json', type: 'file', mtime: 1 }], 'notes.txt'), { kind: 'ok', file: 'board.json' })
  assert.deepEqual(tb.pickBoard([{ name: 'notes.txt', type: 'file' }], 'notes.txt'), { kind: 'none' })
})

test('pickBoard: cached 指向已删除板 + 目录恰剩一块板 → ok(剩板)（降级阶梯：多板 ambiguous/单板 auto-pick/无板 none）', () => {
  const one = [{ name: 'survivor.json', type: 'file', mtime: 7 }]
  assert.deepEqual(tb.pickBoard(one, 'deleted.json'), { kind: 'ok', file: 'survivor.json' })
})

test('pickBoard: 两者同时消失（cached 板删除 + 目录清空只剩非板条目）→ none', () => {
  const entries = [
    { name: 'board.json.lock', type: 'file' },
    { name: 'board.json.events.jsonl', type: 'file' },
    { name: 'subdir', type: 'directory' },
  ]
  assert.deepEqual(tb.pickBoard(entries, 'board.json'), { kind: 'none' })
})

test('pickBoard: currentFile 仍在但目录成员变化（新增/删除其他板）→ 仍原样保持', () => {
  // 新增第 3 块板：选定板不受目录成员变化影响（刷新永不移动板维度视线）
  const grew = [
    { name: 'current.json', type: 'file', mtime: 1 },
    { name: 'other.json', type: 'file', mtime: 2 },
    { name: 'third.json', type: 'file', mtime: 3 },
  ]
  assert.deepEqual(tb.pickBoard(grew, 'current.json'), { kind: 'ok', file: 'current.json' })
  // 另一板被删除（目录退化）→ 选定板仍保持
  const shrank = [{ name: 'current.json', type: 'file', mtime: 1 }]
  assert.deepEqual(tb.pickBoard(shrank, 'current.json'), { kind: 'ok', file: 'current.json' })
})

// ---------- T4 回归补强：tbBoardSwitchPatch 重置面逐项断言（spec §12.4 五步） ----------

test('boardSwitchPatch: 五步字段逐项类型与值断言（version/seq/防抖/锚点）', () => {
  const patch = tb.boardSwitchPatch()
  assert.equal(typeof patch.abortInFlight, 'boolean')
  assert.equal(patch.abortInFlight, true, '步1 abort 在途请求')
  assert.equal(typeof patch.versionReset, 'boolean')
  assert.equal(patch.versionReset, true, '步2 versionRef 置空')
  assert.equal(typeof patch.seqIncrement, 'number')
  assert.equal(patch.seqIncrement, 1, '步3 seq 递增恰 1（非字符串、非 0）')
  assert.equal(typeof patch.clearDebounce, 'boolean')
  assert.equal(patch.clearDebounce, true, '步4 清防抖定时器')
  assert.equal(typeof patch.clearAnchor, 'boolean')
  assert.equal(patch.clearAnchor, true, '滚动锚点随旧板现场一并清空')
  assert.equal(patch.resetUi.expandedId, null, 'expandedId 未定（null 非 false）')
  assert.equal(patch.resetUi.doneFolded, null, 'doneFolded 交初载推导（null 非 false）')
  assert.equal(patch.resetUi.ownerFilter, null)
  assert.equal(patch.resetUi.blockedOnly, false)
  assert.ok(Array.isArray(patch.resetUi.statusFilter))
  assert.equal(typeof patch.resetUi.scrollTop, 'number')
  assert.equal(patch.resetUi.scrollTop, 0, '滚动回顶')
})

// ---------- T4 回归补强：L3 旧条目降级不污染 + 形态误置防御（spec §12.5） ----------

test('uiCacheRead: 旧条目降级零污染——read 未命中不写不改删缓存任何键', () => {
  const legacy = { expandedId: 'T1', doneFolded: true, scrollTop: 88 }
  const cache = { 'sid\u0000a.json': legacy, sid: { junk: true } }
  const snapshot = JSON.stringify(cache)
  assert.equal(tb.uiCacheRead(cache, 'sid', 'a.json'), null)
  assert.equal(tb.uiCacheRead(cache, 'sid', 'b.json'), null)
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), null)
  assert.equal(JSON.stringify(cache), snapshot, '未命中路径不得触碰缓存对象')
  // board 字段指向别的板 → 未命中（防串板读取）
  assert.equal(tb.uiCacheRead({ 'sid\u0000a.json': { board: 'b.json', expandedId: 'T1' } }, 'sid', 'a.json'), null)
})

test('uiCacheWrite: 写入升级覆盖旧条目并落 board 标记；selected 形态误置不串扰', () => {
  const legacy = { expandedId: 'OLD', doneFolded: true }
  const cache = { 'sid\u0000a.json': legacy }
  const written = tb.uiCacheWrite(cache, 'sid', 'a.json', { expandedId: 'T9', scrollTop: 5 })
  assert.equal(written.board, 'a.json')
  assert.equal(tb.uiCacheRead(cache, 'sid', 'a.json').expandedId, 'T9')
  // selected 条目 {selected:…} 落在 board 组合键位 → 无 board 标记不命中（两形态互不误认）
  cache['sid\u0000b.json'] = { selected: 'b.json' }
  assert.equal(tb.uiCacheRead(cache, 'sid', 'b.json'), null)
  // 旧/坏 selected 形态（无 selected 字段、空串、非对象）→ null，不猜
  const selKey = tb.uiCacheSelectedKey('sid')
  cache[selKey] = { file: 'a.json' }
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), null)
  cache[selKey] = { selected: '' }
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), null)
  cache[selKey] = ['a.json']
  assert.equal(tb.uiCacheReadSelected(cache, 'sid'), null)
})

// ---------- T4 回归补强：受控重载五步次序（spec §12.4 顺序断言，接线面静态锚点） ----------

test('switchBoard: 受控重载五步按 spec 次序执行（abort→version→seq→防抖→清锚点/初载）', () => {
  const fn = source.slice(source.indexOf('function switchBoard(file)'), source.indexOf('apiRef.current = {'))
  assert.ok(fn.length > 0, 'switchBoard 函数体应可提取')
  const pos = [
    ['步1 abort', fn.indexOf('if (patch.abortInFlight) abortInFlight();')],
    ['步2 version', fn.indexOf('if (patch.versionReset) versionRef.current = null;')],
    ['步3 seq', fn.indexOf('seqRef.current += patch.seqIncrement')],
    ['步4 防抖', fn.indexOf('if (patch.clearDebounce && debounceRef.current)')],
    ['步5 初载', fn.indexOf('readBoard(file, signal)')],
  ]
  for (let i = 0; i < pos.length; i++) assert.ok(pos[i][1] > 0, `switchBoard 缺 ${pos[i][0]}`)
  for (let i = 1; i < pos.length; i++) {
    assert.ok(pos[i][1] > pos[i - 1][1], `${pos[i][0]} 应晚于 ${pos[i - 1][0]}（spec §12.4 五步次序）`)
  }
})

// ---------- T9 回炉：切板落位机理钉子（F1 修复） + 宽档 720 边界公式钉子（F2 修复） ----------

test('switchBoard 落位: 覆写前先把旧板 UI 现场写入 L3 缓存（先于 patch 重置与 state 覆写，spec §12.5/裁决②）', () => {
  const fn = source.slice(source.indexOf('function switchBoard(file)'), source.indexOf('apiRef.current = {'))
  assert.ok(fn.length > 0, 'switchBoard 函数体应可提取')
  // 字段完整性：落位 = render 期五字段快照 + 滚动锚点，与卸载落位同一六字段组合
  const writeAt = fn.indexOf('tbUiCacheWrite(TB_UI_CACHE, sessionId, outgoing,')
  assert.ok(writeAt > 0, 'switchBoard 应对旧板（outgoing）调用 tbUiCacheWrite 落位')
  const writeSeg = fn.slice(writeAt, fn.indexOf('));', writeAt))
  assert.ok(writeSeg.includes('uiSnapRef.current'), '落位现场应含 render 期五字段快照（expandedId/doneFolded/ownerFilter/blockedOnly/statusFilter）')
  assert.ok(writeSeg.includes('scrollTop: uiScrollRef.current'), '落位现场应含滚动锚点 scrollTop（uiScrollRef）')
  // 写入时机：先于 patch 重置（五步之首 abort）与新板 state 覆写——T3 受控重载语义不被破坏
  const patchAt = fn.indexOf('var patch = tbBoardSwitchPatch();')
  const setStateAt = fn.indexOf('setSelectedFile(file);')
  assert.ok(patchAt > writeAt, '写缓存必须先于 patch 重置')
  assert.ok(setStateAt > writeAt, '写缓存必须先于新板 state 覆写')
  // 守卫语义与卸载落位一致：无选定板（S1/S2）不落位
  assert.ok(fn.includes('typeof outgoing === "string" && outgoing !== ""'), '无选定板不得落位')
})

test('切板落位机理（纯函数层）: 两板各自写读互不串——A→B→A 现场完整恢复', () => {
  const cache = Object.create(null)
  const sid = 'sid'
  // A 板现场（六字段）：切走前落位（与 switchBoard 写入同构：五字段快照 + scrollTop）
  tb.uiCacheWrite(cache, sid, 'a.json', {
    expandedId: 'T5', doneFolded: true, ownerFilter: '前端开发者',
    blockedOnly: true, statusFilter: ['ready', 'done'], scrollTop: 320,
  })
  assert.equal(tb.uiCacheReadSelected(cache, sid), null, '切板尚未选定新板，selected 未写')
  tb.uiCacheWriteSelected(cache, sid, 'b.json')
  // B 板现场落位：两级键 sessionId→board 隔离，不得覆盖 A 的键位
  tb.uiCacheWrite(cache, sid, 'b.json', {
    expandedId: 'T9', doneFolded: false, ownerFilter: null,
    blockedOnly: false, statusFilter: ['blocked'], scrollTop: 64,
  })
  // 切回 A：六字段现场完整恢复（A→B→A 不丢）
  assert.deepEqual(tb.uiCacheRead(cache, sid, 'a.json'), {
    board: 'a.json', expandedId: 'T5', doneFolded: true, ownerFilter: '前端开发者',
    blockedOnly: true, statusFilter: ['ready', 'done'], scrollTop: 320,
  })
  // B 现场同样不串
  const backB = tb.uiCacheRead(cache, sid, 'b.json')
  assert.equal(backB.expandedId, 'T9')
  assert.equal(backB.scrollTop, 64)
  // A 再次落位（字段缺省走安全默认）不污染 B
  tb.uiCacheWrite(cache, sid, 'a.json', { expandedId: 'T7', scrollTop: 12 })
  assert.equal(tb.uiCacheRead(cache, sid, 'a.json').scrollTop, 12)
  assert.equal(tb.uiCacheRead(cache, sid, 'b.json').expandedId, 'T9')
})

test('宽档 720 边界: grid min 总宽 + board 水平 padding ≤ 720 阈值（参照面=.eso-tb-lanes 可用宽，不改密度阈值语义）', () => {
  const line = cssRegion().split('\n').find((l) => l.includes('data-eso-tb-wide') && l.includes('.eso-tb-lanes'))
  assert.ok(line, '宽档泳道 grid 规则应存在')
  const minmax = line.match(/repeat\(4,\s*minmax\((\d+)px,1fr\)\)/)
  assert.ok(minmax, '宽档泳道应为 repeat(4, minmax(Npx,1fr)) 四列结构')
  const gap = line.match(/gap:(\d+)px/)
  assert.ok(gap, '列距 gap 应可提取')
  // F2 复修：grid 实际约束容器是 .eso-tb-lanes，其可用宽 = 根宽 − .eso-tb-board 水平 padding（宽档无覆写），
  // 故断言参照面为「总宽 + board 水平 padding ≤ 720」而非「总宽 ≤ 720」（锚定 board padding 值，不用魔法数）
  const boardLine = cssRegion().split('\n').find((l) => l.includes('.eso-tb-board{'))
  assert.ok(boardLine, '.eso-tb-board 规则应存在')
  const pad = boardLine.match(/padding:(\d+)px (\d+)px (\d+)px/)
  assert.ok(pad, '.eso-tb-board padding 应可提取')
  const padX = Number(pad[2]) * 2 // 水平 padding = 左 + 右
  const total = 4 * Number(minmax[1]) + 3 * Number(gap[1])
  assert.ok(Number(minmax[1]) === 168, '宽档列 min 应为 168px（4×168+3×8=696=720−24，恰合 lanes 可用宽）')
  assert.ok(total + padX <= 720, `宽档 grid min 总宽 ${total}px + board 水平 padding ${padX}px = ${total + padX}px 不得超过宽档阈值 720px（根宽 [720,744) 区间逐像素不再溢出）`)
  // 阈值语义不回归：宽档密度断点仍为 720（以收窄列宽修边界，而非改阈值）
  assert.ok(source.includes('var wide = width >= 720;'), '宽档密度阈值应保持 720')
})

test('done 泳道防回归: 双列 grid 规则与 data-eso-tb-xl 已彻底移除（用户裁决 2026-10-27，done 泳道卡片全程单列）', () => {
  const lines = cssRegion().split('\n')
  // cssRegion 返回原始源码切片，TB_CSS 行内引号为 JS 转义形式 data-lane=\"done\"
  const laneDone = 'data-lane=\\"done\\"'
  const doneGrid = lines.filter((l) => l.includes(laneDone) && l.includes('.eso-tb-lane-cards') && l.includes('repeat(2'))
  assert.ok(doneGrid.length === 0, 'done 泳道不得再出现双列 grid 规则（repeat(2)），卡片应全程 flex column 单列排布')
  const wideDone = lines.filter((l) => l.includes('data-eso-tb-wide') && l.includes(laneDone) && l.includes('.eso-tb-lane-cards'))
  assert.ok(wideDone.length === 0, 'done 泳道卡片布局规则不得锚定任何密度属性（全程单列）')
  const xlLeftover = lines.filter((l) => l.includes('data-eso-tb-xl'))
  assert.ok(xlLeftover.length === 0, 'data-eso-tb-xl 死属性不得在 CSS 区残留（唯一消费方双列规则已删）')
  const xlSource = source.split('\n').filter((l) => l.includes('data-eso-tb-xl'))
  assert.ok(xlSource.length === 0, 'data-eso-tb-xl set/remove 源码应彻底移除（无消费方即死属性）')
})

// ---------- T11 移动端候选卡点按兜底（Android 触屏 click 合成不到达的回归钉子） ----------

test('tbIsTap: 同 pointerId 位移 ≤ slop 且时长 ≤ 500ms 视为有效点按（移动端 tap 兜底判定，含边界与勾股）', () => {
  // Chrome 156 实测：触屏位移 ≤14px 合成 click、≥16px 走 pointercancel（滚动接管，pointerup 不投递）
  // → slop 钉 20px：覆盖宿主抑制 click 合成时 pointerup 仍投递的兜底带，仍远小于滚动位移
  assert.equal(tb.TB_TAP_SLOP_PX, 20, 'tap slop 阈值应钉死为 20px')
  const down = { pointerId: 7, clientX: 120, clientY: 300, timeMs: 1000 }
  // 干净点按：零位移 / 小抖动
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 120, clientY: 300, timeMs: 1100 }), true, '零位移 tap 应命中')
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 126, clientY: 304, timeMs: 1100 }), true, '√(6²+4²)≈7.2px 抖动应命中')
  // 边界：恰 20px 勾股距离仍有效（16,12 → 20）；超出不命中
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 136, clientY: 312, timeMs: 1100 }), true, '恰 20px 边界应命中')
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 137, clientY: 313, timeMs: 1100 }), false, '√(17²+13²)≈21.4px 应不命中（滚动/拖动）')
  // 水平/垂直大位移（滚动意图）
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 150, clientY: 300, timeMs: 1100 }), false, '水平 30px 应不命中')
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 120, clientY: 340, timeMs: 1100 }), false, '垂直 40px 应不命中')
  // 长按防误触发：>500ms（Android contextmenu 阈值 ~500ms）后释放不得兜底
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 120, clientY: 300, timeMs: 1650 }), false, '长按 650ms 释放应不命中')
  assert.equal(tb.isTap(down, { pointerId: 7, clientX: 120, clientY: 300, timeMs: 1500 }), true, '恰 500ms 内释放应命中')
  // timeMs 缺失宽容（不影响位移判定主路径）
  assert.equal(tb.isTap({ pointerId: 7, clientX: 120, clientY: 300 }, { pointerId: 7, clientX: 120, clientY: 300 }), true, 'timeMs 缺失应跳过时长判定')
  // pointerId 不同（多指第二指抬起）不命中
  assert.equal(tb.isTap(down, { pointerId: 8, clientX: 120, clientY: 300, timeMs: 1100 }), false, '异 pointerId 应不命中')
  // 缺 down 记录（pointerdown 未达/已被消费）不命中
  assert.equal(tb.isTap(null, { pointerId: 7, clientX: 120, clientY: 300, timeMs: 1100 }), false, 'down 缺失应不命中')
  assert.equal(tb.isTap(down, null), false, 'up 缺失应不命中')
})

test('T11 接线: 候选卡 onPointerUp 兜底 + onClick 保留 + 非主键/缺 down 守卫（桌面路径不回退）', () => {
  const fn = source.slice(source.indexOf('function renderCandidates(candidates)'), source.indexOf('function renderStructuralEmpty'))
  assert.ok(fn.length > 0, 'renderCandidates 函数体应可提取')
  // 移动端兜底路径：pointerdown 记录 → pointerup 判定 → 兜底触发切板
  assert.ok(fn.includes('onPointerDown: function (event)'), '候选卡应有 onPointerDown 坐标记录')
  assert.ok(fn.includes('cardTapRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, timeMs: event.timeStamp }'), 'onPointerDown 应记录 pointerId/坐标/按压起始时刻')
  assert.ok(fn.includes('onPointerUp: function (event)'), '候选卡应有 onPointerUp 兜底')
  const upSeg = fn.slice(fn.indexOf('onPointerUp: function (event)'), fn.indexOf('onClick: function'))
  assert.ok(upSeg.includes('cardTapRef.current = null'), 'pointerup 应消费（置空）暂存记录，防多指串扰')
  assert.ok(upSeg.includes('event.button !== 0'), '非主键（右键/中键抬起）不得兜底触发')
  assert.ok(upSeg.includes('!tbIsTap(down, event)'), '兜底必须经 tbIsTap 位移判定')
  assert.ok(upSeg.includes('requestSwitchBoard(candidate.name)'), '兜底路径应经 requestSwitchBoard 触发切板（T13：render 作用域禁裸引用 effect 闭包内 switchBoard）')
  // 桌面路径不回退：onClick 仍在（含键盘 Enter/Space 原生点击）
  assert.ok(fn.includes('onClick: function () { requestSwitchBoard(candidate.name); }'), 'onClick 直调路径应保留（桌面不回退）')
  // 幂等前提：switchBoard 守卫先于一切副作用——pointerup 先触发后，后到 click 不双重切板
  const sw = source.slice(source.indexOf('function switchBoard(file)'), source.indexOf('apiRef.current = {'))
  const guardAt = sw.indexOf('file === selectedFileRef.current')
  assert.ok(guardAt >= 0 && guardAt < sw.indexOf('tbUiCacheWrite'), '同板重入守卫应先于 L3 落位（双触发幂等的前提）')
  assert.ok(sw.indexOf('selectedFileRef.current = file;') < sw.indexOf('setState({ phase: "loading" })'), 'selectedFileRef 同步覆写先于 loading（click 后到时守卫已生效）')
})

// ---------- T13 根因回归钉子：render 作用域不得裸引用 effect 闭包内 switchBoard ----------
// 真根因（T13 取证）：switchBoard 定义在 React.useEffect 闭包内（deps [sessionId, io]），
// render 作用域 4 处裸引用 → ReferenceError: switchBoard is not defined，点击无任何反应
// （桌面/移动皆失效；事件投递层完好，fiber props.onClick 均为 function 但一调用即抛）。
// 修法：apiRef.current 桥接 switchBoard + render 作用域守卫包装 requestSwitchBoard，
// 4 个调用点（候选卡 pointerup/onClick、板菜单 keydown Enter/菜单项 onClick）一律经它。

test('T13 接线: apiRef 桥接 switchBoard + render 作用域 requestSwitchBoard 守卫（ReferenceError 根因回归钉子）', () => {
  // 桥接：effect 闭包内的 switchBoard 真身必须挂到 apiRef（沿用 refresh/redetect 桥接模式）
  const apiLine = source.split('\n').find((l) => l.includes('apiRef.current = {') && l.includes('switchBoard: switchBoard'))
  assert.ok(apiLine, 'apiRef.current 应含 switchBoard: switchBoard（effect→render 桥）')
  // 守卫包装：render 作用域唯一入口，经 apiRef 调用（effect 未挂载时静默忽略）
  const guard = source.split('\n').find((l) => l.includes('function requestSwitchBoard(file)'))
  assert.ok(guard, 'render 作用域应有 requestSwitchBoard(file) 守卫包装')
  const guardBody = source.slice(source.indexOf(guard), source.indexOf(guard) + 300)
  assert.ok(guardBody.includes('apiRef.current.switchBoard'), 'requestSwitchBoard 应经 apiRef.current.switchBoard 调用')
  assert.ok(guardBody.includes('if (apiRef.current.switchBoard)'), 'requestSwitchBoard 应有守卫（effect 未挂载时静默忽略）')
})

test('T13 调用点: 全源码裸 switchBoard( 引用只剩定义/桥接/守卫三处，事件层零裸引用', () => {
  // 全源码中含 "switchBoard(" 且非 "requestSwitchBoard(" 的行只允许：
  // ① effect 闭包内定义 function switchBoard(file) ② requestSwitchBoard 守卫体内 apiRef 调用
  const bare = source.split('\n')
    .map((l, i) => ({ l: l, n: i + 1 }))
    .filter((x) => x.l.includes('switchBoard(') && !x.l.includes('requestSwitchBoard('))
  assert.equal(bare.length, 2, '裸 switchBoard( 引用应恰 2 处（定义 + 守卫体内经 apiRef 调用），实得 ' + bare.length + ' 处: ' + bare.map((x) => x.n).join(','))
  assert.ok(bare[0].l.includes('function switchBoard(file)'), '第 1 处应为 effect 闭包内定义')
  assert.ok(bare[1].l.includes('apiRef.current.switchBoard'), '第 2 处应为 requestSwitchBoard 守卫体内 apiRef 调用')
  // 候选卡（renderCandidates）与板菜单（工具条内联段）两处事件面均经 requestSwitchBoard
  const candidates = source.slice(source.indexOf('function renderCandidates(candidates)'), source.indexOf('function renderStructuralEmpty'))
  assert.ok(!/[^.]switchBoard\(/.test(candidates.replace(/requestSwitchBoard\(/g, '')), 'renderCandidates 内不得裸引用 switchBoard')
  const toolbarSeg = source.slice(source.indexOf('// —— 工具条'))
  const menuCalls = toolbarSeg.split('\n').filter((l) => l.includes('requestSwitchBoard('))
  assert.ok(menuCalls.length >= 2, '板菜单 keydown Enter 与菜单项 onClick 两处应经 requestSwitchBoard')
  // 守卫定义在 render 作用域（manualRefresh 之后）
  const around = source.slice(source.indexOf('function manualRefresh()'), source.indexOf('function manualRefresh()') + 400)
  assert.ok(around.includes('function requestSwitchBoard(file)'), 'requestSwitchBoard 应紧邻 manualRefresh 定义于 render 作用域')
})

test('T11 CSS: 候选卡 touch-action:manipulation（触屏双击缩放/300ms 延迟歧义消除，产品 token 不新增）', () => {
  const line = cssRegion().split('\n').find((l) => l.includes('.eso-tb-board-card{'))
  assert.ok(line, '.eso-tb-board-card 基础规则应存在')
  assert.ok(line.includes('touch-action:manipulation'), '候选卡应声明 touch-action:manipulation')
  // 不扩散：兜底语义只加在候选卡（选择板页报告缺陷面），linklike/其余按钮不改动
  const linklike = cssRegion().split('\n').find((l) => l.includes('.eso-tb-linklike{'))
  assert.ok(linklike && !linklike.includes('touch-action'), '本次不改 .eso-tb-linklike（改动最小化）')
})
