// test/expert-profiles-remote.selftest.mjs — T6（gh-issues-1-2）专家档案
// Remote 存储缝 + groups/defaults 解析扩展自测（node:test，零依赖）。
// 覆盖：groups/defaults 容错解析与告警、loadExpertProfiles 纯增量透出与向后
// 兼容、层间优先级、profileForExpert 保留键守卫、写侧严格校验拒绝路径、
// remoteGet/SaveExpertProfiles（缺文件/roundtrip/备份/非法输入原文件字节不变）、
// 写入后新 summon 立即生效 E2E、client.js descriptor 契约对齐检查。
// 文件系统用例使用 os.tmpdir() 临时目录，结束后清理，不触碰仓库内任何数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXPERT_PROFILES_FILENAME,
  loadExpertProfiles,
  loadExpertProfilesDoc,
  parseExpertDefaults,
  parseExpertGroup,
  profileForExpert,
  validateExpertProfileDocument,
} from '../lib/expert-profiles.js'
import { remoteGetExpertProfiles, remoteSaveExpertProfiles } from '../lib/index.js'
import { registerExpertTools } from '../lib/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

// ── 夹具（复刻 test/tools.selftest.mjs makeProfileFixture/makeProfileSummonCtx
// 最小集；该文件内 const 不导出，此处自持——两处同步为有意冗余，非共享面）。

const makeProfileFixture = (t, label) => {
  const root = mkdtempSync(join(tmpdir(), `t6-profiles-remote-${label}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dst = join(root, 'dst')
  mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(join(dst, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [{ source: 'bundled-core', file: 'a.md', name: '测试专家' }] }))
  // 全局层路径 = <root>/expert-profiles.json，与 remoteSave{Get} 的 DSH_HOME 注入
  // 定位（globalProfilesPath({DSH_HOME: root})）一致——E2E 直接走 Remote 写缝。
  const homePath = join(root, EXPERT_PROFILES_FILENAME)
  const projectPath = join(root, 'ws', '.dsh', EXPERT_PROFILES_FILENAME)
  const writeDoc = (doc, path = homePath) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
  }
  return { root, dst, homePath, projectPath, writeDoc }
}

const guardProfilesEnv = (t) => {
  const saved = process.env.DSH_EXPERT_PROFILES
  delete process.env.DSH_EXPERT_PROFILES
  const restore = () => {
    if (saved === undefined) delete process.env.DSH_EXPERT_PROFILES
    else process.env.DSH_EXPERT_PROFILES = saved
  }
  if (t) t.after(restore)
  else process.on('exit', restore)
}

const makeProfileSummonCtx = ({ capabilities = {} } = {}) => {
  const descriptors = []
  const specs = []
  const tools = { register: (d) => descriptors.push(d) }
  return {
    descriptors,
    specs,
    ctx: {
      tools,
      subagents: {
        getProvider: () => ({ capabilities: { persona: true, toolFilter: true, ...capabilities } }),
        start: async (_provider, opts) => {
          specs.push(opts)
          return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }
        },
      },
    },
  }
}

// ── ① groups/defaults 容错解析 ──────────────────────────────────────────────

test('T6 parseExpertGroup：合法条目收敛（trim）+ 字段级容错（非法字段告警丢弃、全非法条目跳过）', () => {
  const warns = []
  const warn = (msg) => warns.push(msg)
  assert.deepEqual(parseExpertGroup({ model: ' m1 ', members: [' 甲 ', '乙'] }, warn), { model: 'm1', members: ['甲', '乙'] })
  assert.deepEqual(warns, [])
  // 字段级：非法字段告警丢弃，合法字段保留
  warns.length = 0
  assert.deepEqual(parseExpertGroup({ model: 42, members: 'x' }, warn), null)
  assert.equal(warns.length, 2)
  warns.length = 0
  assert.deepEqual(parseExpertGroup({ model: 'm1', members: [] }, warn), { model: 'm1' }) // 空数组视同未配置
  assert.equal(warns.length, 1)
  warns.length = 0
  assert.deepEqual(parseExpertGroup({ model: 'm1' }, warn), { model: 'm1' }) // 无 members 合法（结构留扩展位）
  assert.equal(warns.length, 0)
  // 未知字段告警忽略
  warns.length = 0
  assert.deepEqual(parseExpertGroup({ model: 'm1', effort: 'high' }, warn), { model: 'm1' })
  assert.ok(warns.some((m) => m.includes('未知字段') && m.includes('effort')))
  // 非对象/空对象 → null（条目跳过）
  assert.equal(parseExpertGroup('x', warn), null)
  assert.equal(parseExpertGroup({}, warn), null)
  assert.equal(parseExpertGroup(null, warn), null)
})

test('T6 parseExpertDefaults：{model} 收敛 + 非法/未知字段容错', () => {
  const warns = []
  const warn = (msg) => warns.push(msg)
  assert.deepEqual(parseExpertDefaults({ model: ' m ' }, warn), { model: 'm' })
  assert.deepEqual(warns, [])
  warns.length = 0
  assert.deepEqual(parseExpertDefaults({ model: 1 }, warn), null)
  assert.equal(warns.length, 1)
  assert.deepEqual(parseExpertDefaults({ effort: 'high' }, warn), null) // 本期仅 model，未知字段告警后条目为空
  assert.ok(warns.some((m) => m.includes('未知字段')))
  assert.equal(parseExpertDefaults('x', warn), null)
  assert.equal(parseExpertDefaults({}, warn), null)
})

test('T6 loadExpertProfilesDoc：缺/坏层 → 空 doc（三键恒齐）；合法层三键齐全', (t) => {
  const warns = []
  const warn = (msg) => warns.push(msg)
  assert.deepEqual(loadExpertProfilesDoc(join(tmpdir(), `t6-no-such-${Date.now()}.json`), warn), { experts: {}, groups: {}, defaults: {} })
  assert.deepEqual(warns, []) // 缺失=正常态静默
  warns.length = 0
  const root = mkdtempSync(join(tmpdir(), 't6-doc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bad = join(root, 'bad.json')
  writeFileSync(bad, '{ not json')
  assert.deepEqual(loadExpertProfilesDoc(bad, warn), { experts: {}, groups: {}, defaults: {} })
  assert.equal(warns.length, 1)
  const good = join(root, 'good.json')
  writeFileSync(good, JSON.stringify({ experts: { 甲: { model: 'm1' } }, groups: { 组A: { model: 'g1', members: ['甲'] } }, defaults: { model: 'd1' } }))
  assert.deepEqual(loadExpertProfilesDoc(good, warn), { experts: { 甲: { model: 'm1' } }, groups: { 组A: { model: 'g1', members: ['甲'] } }, defaults: { model: 'd1' } })
})

test('T6 顶层未知键告警豁免：groups/defaults 不再触发未知顶层键告警；陌生键仍告警', (t) => {
  const warns = []
  const warn = (msg) => warns.push(msg)
  const root = mkdtempSync(join(tmpdir(), 't6-topkeys-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, EXPERT_PROFILES_FILENAME)
  writeFileSync(path, JSON.stringify({ experts: {}, groups: {}, defaults: {}, stranger: 1 }))
  loadExpertProfilesDoc(path, warn)
  assert.equal(warns.filter((m) => m.includes('未知顶层键')).length, 1)
  assert.ok(warns.find((m) => m.includes('stranger')))
})

// ── ② 增量透出与向后兼容 ────────────────────────────────────────────────────

test('T6 向后兼容：无 groups/defaults 时 loadExpertProfiles 返回结构与 v2.9 现状逐字节一致（平面对象）', (t) => {
  guardProfilesEnv(t)
  const root = mkdtempSync(join(tmpdir(), 't6-compat-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const homePath = join(root, EXPERT_PROFILES_FILENAME)
  assert.deepEqual(loadExpertProfiles({ homePath }), {})
  writeFileSync(homePath, JSON.stringify({ experts: { 甲: { model: 'm1' } } }))
  const out = loadExpertProfiles({ homePath })
  assert.deepEqual(out, { 甲: { model: 'm1' } })
  assert.deepEqual(Object.keys(out), ['甲']) // 无增量键
})

test('T6 增量透出：配置 groups/defaults 后 .groups/.defaults 纯增量附加，专家条目不变；profileForExpert 保留键守卫', (t) => {
  guardProfilesEnv(t)
  const root = mkdtempSync(join(tmpdir(), 't6-additive-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const homePath = join(root, EXPERT_PROFILES_FILENAME)
  writeFileSync(homePath, JSON.stringify({
    experts: { 甲: { model: 'm1' } },
    groups: { 组A: { model: 'g1', members: ['甲', '乙'] }, 空组: { model: 42 } }, // 空组条目全非法 → 跳过
    defaults: { model: 'd1' },
  }))
  const out = loadExpertProfiles({ homePath })
  assert.deepEqual(out, {
    甲: { model: 'm1' },
    groups: { 组A: { model: 'g1', members: ['甲', '乙'] } },
    defaults: { model: 'd1' },
  })
  // 保留键守卫：增量字段永不作为专家名命中
  assert.deepEqual(profileForExpert(out, '甲'), { model: 'm1' })
  assert.equal(profileForExpert(out, 'groups'), null)
  assert.equal(profileForExpert(out, 'defaults'), null)
  assert.equal(profileForExpert(out, 'GROUPS'), null) // 归一名（lower）同样守卫
  assert.equal(profileForExpert(out, '不存在'), null)
})

test('T6 层间优先级：groups 按组名、defaults 按字段，项目层覆盖全局层；专家条目合并不变', (t) => {
  guardProfilesEnv(t)
  const root = mkdtempSync(join(tmpdir(), 't6-precedence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const homePath = join(root, 'home.json')
  const projectPath = join(root, 'proj.json')
  writeFileSync(homePath, JSON.stringify({
    experts: { 甲: { model: 'gm' }, 乙: { model: 'g-only' } },
    groups: { 组A: { model: 'g-model', members: ['甲'] }, 组B: { model: 'b-global', members: ['乙'] } },
    defaults: { model: 'g-default' },
  }))
  writeFileSync(projectPath, JSON.stringify({
    experts: { 甲: { model: 'pm' } },
    groups: { 组A: { model: 'p-model', members: ['丙'] } },
    defaults: { model: 'p-default' },
  }))
  const out = loadExpertProfiles({ homePath, projectPath })
  assert.deepEqual(out, {
    甲: { model: 'pm' }, // 专家条目：项目层覆盖
    乙: { model: 'g-only' },
    groups: {
      组A: { model: 'p-model', members: ['丙'] }, // 按组名整体覆盖（非字段合并）
      组B: { model: 'b-global', members: ['乙'] },
    },
    defaults: { model: 'p-default' }, // 按字段覆盖
  })
})

// ── ③ 写侧严格校验 ──────────────────────────────────────────────────────────

test('T6 validateExpertProfileDocument：合法文档归一化通过；非法路径逐一拒绝（error 含定位）', () => {
  // 合法：归一化（trim、空组/默认省略）
  const v = validateExpertProfileDocument({ experts: { ' 甲 ': { model: ' m1 ' } }, groups: { 组A: { members: ['x'] } }, defaults: {} })
  assert.deepEqual(v, { ok: true, doc: { experts: { 甲: { model: 'm1' } }, groups: { 组A: { members: ['x'] } } } })
  // experts 可为 {}（清空语义）
  assert.deepEqual(validateExpertProfileDocument({ experts: {} }), { ok: true, doc: { experts: {} } })
  // 未知顶层键
  assert.deepEqual(validateExpertProfileDocument({ experts: {}, stranger: {} }).ok, false)
  assert.match(validateExpertProfileDocument({ experts: {}, stranger: {} }).error, /stranger/)
  // experts 非对象 / 缺席
  assert.equal(validateExpertProfileDocument({}).ok, false)
  assert.equal(validateExpertProfileDocument({ experts: [] }).ok, false)
  // 条目未知字段（严格，不容错）
  assert.match(validateExpertProfileDocument({ experts: { 甲: { modle: 'x' } } }).error, /未知字段/)
  // 非法字段值
  assert.equal(validateExpertProfileDocument({ experts: { 甲: { model: 42 } } }).ok, false)
  assert.match(validateExpertProfileDocument({ experts: { '': {} } }).error, /条目名为空/)
  // groups/defaults 严格路径
  assert.match(validateExpertProfileDocument({ experts: {}, groups: [] }).error, /groups/)
  assert.match(validateExpertProfileDocument({ experts: {}, groups: { A: { members: 'x' } } }).error, /groups\.A/)
  assert.match(validateExpertProfileDocument({ experts: {}, groups: { A: { bogus: 1 } } }).error, /未知字段/)
  assert.equal(validateExpertProfileDocument({ experts: {}, groups: { A: {} } }).ok, false) // 全空条目拒绝
  assert.match(validateExpertProfileDocument({ experts: {}, defaults: { bogus: 1 } }).error, /defaults/)
  assert.equal(validateExpertProfileDocument({ experts: {}, defaults: { model: '' } }).ok, false)
  assert.equal(validateExpertProfileDocument('x').ok, false)
  assert.equal(validateExpertProfileDocument(null).ok, false)
})

// ── ④ Remote 存储缝 ─────────────────────────────────────────────────────────

test('T6 remoteGetExpertProfiles：缺文件 → 空 doc + 空 merged；有文件 → 文档与双层视图；path 锚点正确', (t) => {
  guardProfilesEnv(t)
  const f = makeProfileFixture(t, 'get')
  // 缺文件
  const empty = remoteGetExpertProfiles({ DSH_HOME: f.root })
  assert.equal(empty.path, f.homePath)
  assert.deepEqual(empty.experts, {})
  assert.deepEqual(empty.groups, {})
  assert.deepEqual(empty.defaults, {})
  assert.deepEqual(empty.merged, {})
  // 有文件（全局层；merged 的项目层取 process.cwd()=运行时会话工作区，无法 env
  // 注入——项目层覆盖语义已在 loadExpertProfiles 层间优先级用例覆盖）
  f.writeDoc({ experts: { 甲: { model: 'g1' } }, groups: { 组A: { model: 'gg', members: ['甲'] } } })
  const view = remoteGetExpertProfiles({ DSH_HOME: f.root })
  assert.deepEqual(view.experts, { 甲: { model: 'g1' } })
  assert.deepEqual(view.groups, { 组A: { model: 'gg', members: ['甲'] } })
  assert.deepEqual(view.defaults, {})
  assert.deepEqual(view.merged, { 甲: { model: 'g1' }, groups: { 组A: { model: 'gg', members: ['甲'] } } })
})

test('T6 remoteSaveExpertProfiles：roundtrip + 首写无备份 + 覆写滚动备份 + 非法输入原文件字节不变', (t) => {
  guardProfilesEnv(t)
  const f = makeProfileFixture(t, 'save')
  const env = { DSH_HOME: f.root }
  // 首写：无备份
  const doc = { experts: { 甲: { model: ' m1 ' } }, groups: { 组A: { model: 'g1', members: ['甲'] } }, defaults: { model: 'd1' } }
  const r1 = remoteSaveExpertProfiles(doc, env)
  assert.equal(r1.path, f.homePath)
  assert.equal(r1.backup, null)
  assert.deepEqual(r1.experts, { 甲: { model: 'm1' } }) // 归一化
  assert.deepEqual(r1.groups, { 组A: { model: 'g1', members: ['甲'] } })
  assert.deepEqual(r1.defaults, { model: 'd1' })
  // 落盘文件归一化且可读回（roundtrip）
  const onDisk = JSON.parse(readFileSync(f.homePath, 'utf-8'))
  assert.deepEqual(onDisk, { experts: { 甲: { model: 'm1' } }, groups: { 组A: { model: 'g1', members: ['甲'] } }, defaults: { model: 'd1' } })
  const got = remoteGetExpertProfiles(env)
  assert.deepEqual(got.experts, onDisk.experts)
  // 覆写：写前备份 = 原内容
  remoteSaveExpertProfiles({ experts: { 乙: { model: 'm2' } } }, env)
  const backupPath = f.homePath + '.bak'
  assert.ok(existsSync(backupPath))
  assert.deepEqual(JSON.parse(readFileSync(backupPath, 'utf-8')), { experts: { 甲: { model: 'm1' } }, groups: { 组A: { model: 'g1', members: ['甲'] } }, defaults: { model: 'd1' } })
  const r2 = remoteSaveExpertProfiles({ experts: { 丙: { model: 'm3' } } }, env)
  assert.equal(r2.backup, backupPath)
  assert.deepEqual(JSON.parse(readFileSync(backupPath, 'utf-8')), { experts: { 乙: { model: 'm2' } } }) // 滚动单份
  // 非法输入：throw（key=invalid）+ 原文件/备份字节不变
  const before = readFileSync(f.homePath)
  const beforeBak = readFileSync(backupPath)
  for (const bad of [null, 'x', [], {}, { experts: [] }, { experts: {}, nope: 1 }, { experts: { 甲: { bogus: 1 } } }]) {
    assert.throws(() => remoteSaveExpertProfiles(bad, env), (e) => e.key === 'invalid')
  }
  assert.ok(before.equals(readFileSync(f.homePath)))
  assert.ok(beforeBak.equals(readFileSync(backupPath)))
  // 清空语义：experts:{} 落盘，读回为空（现状语义：{} 文档 experts 键在 → 空档案）
  remoteSaveExpertProfiles({ experts: {} }, env)
  assert.deepEqual(remoteGetExpertProfiles(env).merged, {})
})

test('T6 E2E：remoteSaveExpertProfiles 写全局层 → 新 summon 立即生效（agentOptions.model 与 defaults/groups 链路留 T8）', async (t) => {
  guardProfilesEnv(t)
  const f = makeProfileFixture(t, 'e2e')
  const { descriptors, specs, ctx } = makeProfileSummonCtx({ capabilities: { agentOptions: true } })
  registerExpertTools(ctx, { dst: f.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), autoClaimCwd: f.root, profilesPaths: { homePath: f.homePath, projectPath: f.projectPath } })
  // 起点无档案：summon 无 agentOptions 键
  const summon = descriptors.find((d) => d.name === 'summon_expert')
  await summon.execute({ expert: '测试专家', task: '任务' }, { agent: {} })
  assert.ok(!('agentOptions' in specs[0]))
  // Remote 写缝落盘（默认组→归一名匹配由既有解析链处理，本期 model 生效）
  remoteSaveExpertProfiles({ experts: { 测试专家: { model: 'remote-model' } }, defaults: { model: 'fallback-model' } }, { DSH_HOME: f.root })
  await summon.execute({ expert: '测试专家', task: '任务' }, { agent: {} })
  assert.equal(specs[1].agentOptions?.model, 'remote-model')
  // 热改（再写）→ 新 summon 即生效
  remoteSaveExpertProfiles({ experts: { 测试专家: { model: 'remote-model-2' } } }, { DSH_HOME: f.root })
  await summon.execute({ expert: '测试专家', task: '任务' }, { agent: {} })
  assert.equal(specs[2].agentOptions?.model, 'remote-model-2')
  // groups/defaults 随 loadExpertProfiles 双层视图透出（消费接线 T8，此处断言数据面）
  const view = remoteGetExpertProfiles({ DSH_HOME: f.root })
  assert.deepEqual(view.merged, { 测试专家: { model: 'remote-model-2' } })
  assert.deepEqual(view.defaults, {})
})

// ── ⑤ client.js descriptor 契约对齐（源文本级：client.js 为浏览器模块，node
// 侧不可 import；既有 client-settings.selftest.mjs 亦以提取面校验，口径一致）──

test('T6 client.js 契约对齐：EXPERT_SOURCES_DESCRIPTORS 含 getExpertProfiles/saveExpertProfiles，host 具名导出同名', () => {
  const clientSrc = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf-8')
  assert.ok(clientSrc.includes('sourceMethod("getExpertProfiles", [], expertProfilesViewSchema)'), 'client descriptor 缺 getExpertProfiles')
  assert.ok(clientSrc.includes('sourceMethod("saveExpertProfiles", [jsonParameter("input", "ExpertProfilesDoc", expertProfilesDocSchema)], expertProfilesSaveResultSchema)'), 'client descriptor 缺 saveExpertProfiles')
  assert.ok(clientSrc.includes('function vRecord(inner)'), 'client 缺 vRecord schema 帮手')
  const indexSrc = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf-8')
  assert.ok(indexSrc.includes('export function remoteGetExpertProfiles'), 'index.js 缺 remoteGetExpertProfiles 导出')
  assert.ok(indexSrc.includes('export function remoteSaveExpertProfiles'), 'index.js 缺 remoteSaveExpertProfiles 导出')
  // 参数面：saveExpertProfiles 的 input 参数名/wire 与 host 形参对齐（input）
  assert.ok(clientSrc.includes('jsonParameter("input", "ExpertProfilesDoc"'))
})
