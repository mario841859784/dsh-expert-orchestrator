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
    + ' groupByStatus: tbGroupByStatus, computeDepBadges: tbComputeDepBadges, countRunning: tbCountRunning, diffCount: tbDiffCount,'
    + ' tbInitialDoneFold: tbInitialDoneFold };',
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
  // L3 会话缓存（模块级、零依赖）
  assert.ok(source.includes('var TB_UI_CACHE = Object.create(null);'), 'L3 模块级会话缓存应存在')
  assert.ok(source.includes('TB_UI_CACHE[sessionId]'), 'L3 缓存应按 sessionId 读写')
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
