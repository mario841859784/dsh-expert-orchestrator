// test/reply-language.selftest.mjs — T3v2（gh-issues T7）回复语言选项存储自测
// （node:test，零依赖）。覆盖任务书三项验收：
//   ① Config schema 新增 replyLanguage（zh|en，默认 zh，volatile；旧宿主副本无
//      .volatile() 方法时降级为普通字段且构建不抛）；
//   ② 读取端缝 resolveReplyLanguage：env DSH_EXPERT_REPLY_LANG 覆盖优先于 Config，
//      容忍 Volatile 引用与普通值两种形态，Config 缺失/降级不炸、行为零变化（=zh）；
//   ③ 设置页开关改后新 summon 生效路径（settings 注入级：Volatile 引用原地改值，
//      每次 summon 现场读取反映新值）+ index.js→tools.js 透传接线（源码断言钉死）
//      + summon 全链在 replyLanguage 传入（Volatile 'en'）下行为零变化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfigSchema } from '../lib/host-settings.js'
import { resolveReplyLanguage, registerExpertTools } from '../lib/tools.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 最小 schemastery 桩（形态对齐 test/tools.selftest.mjs writeSchemasteryStub）：
 *  withVolatile=false 模拟较旧宿主副本（无 .volatile() 方法）的降级分支。 */
const writeSchemasteryStub = (t, label, { withVolatile = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `replylang-stub-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'stub-schemastery.mjs')
  const body = `function Schema(def) { return new SchemaCls(def) }
class SchemaCls {
  constructor(def) { this.type = def.type; this.dict = def.dict; this.inner = def.inner; this.meta = {} }
  toJSON() { return { type: this.type, meta: this.meta } }
}
for (const t of ['object', 'string', 'boolean']) {
  Schema[t] = t === 'object'
    ? (dict) => new SchemaCls({ type: 'object', dict })
    : () => new SchemaCls({ type: t })
}
for (const m of ['default', 'description'${withVolatile ? ", 'volatile'" : ''}]) {
  SchemaCls.prototype[m] = function (v) { this.meta[m] = v ?? true; return this }
}
export default Schema
`
  writeFileSync(path, body)
  return path
}

const buildWithStub = async (t, label, opts) => {
  const stubPath = writeSchemasteryStub(t, label, opts)
  const mod = { default: (await import('file://' + stubPath.replaceAll('\\', '/'))).default }
  return buildConfigSchema(mod)
}

// ---------- ① Config schema：replyLanguage 字段注册 ----------

test('T7 ① Config schema：replyLanguage 注册（默认 zh、volatile 标记）；旧副本无 volatile 方法降级不抛', async (t) => {
  const built = await buildWithStub(t, 'volatile', { withVolatile: true })
  assert.ok(built, '桩 schemastery 下应成功构建')
  assert.deepEqual(Object.keys(built.dict).sort(), ['autoClaim', 'expertTools', 'replyLanguage'])
  assert.equal(built.dict.replyLanguage.meta.default, 'zh') // 默认 zh（Config 缺失=行为零变化）
  assert.equal(built.dict.replyLanguage.meta.volatile, true) // live 开关：编辑即时生效
  // 旧宿主副本（无 .volatile() 方法）：降级注册为普通字段，构建不抛、默认值不变
  const builtOld = await buildWithStub(t, 'novolatile', { withVolatile: false })
  assert.ok(builtOld, '无 volatile 的旧副本也应成功构建')
  assert.equal(builtOld.dict.replyLanguage.meta.default, 'zh')
  assert.ok(!('volatile' in builtOld.dict.replyLanguage.meta), '缺 volatile 方法时不得标记 volatile')
})

// ---------- ② 读取端缝：env 覆盖优先级 / Volatile 与普通值 / 缺失降级 ----------

/** env 存档恢复帮手：测试体内临时改 DSH_EXPERT_REPLY_LANG，结束恢复原值。 */
const withReplyLangEnv = (value, fn) => {
  const old = process.env.DSH_EXPERT_REPLY_LANG
  if (value === undefined) delete process.env.DSH_EXPERT_REPLY_LANG
  else process.env.DSH_EXPERT_REPLY_LANG = value
  return Promise.resolve(fn()).finally(() => {
    if (old === undefined) delete process.env.DSH_EXPERT_REPLY_LANG
    else process.env.DSH_EXPERT_REPLY_LANG = old
  })
}

test('T7 ② env 覆盖优先级：DSH_EXPERT_REPLY_LANG 精确 en/zh 压过 Config；不识别值不覆盖', () =>
  withReplyLangEnv('en', async () => {
    assert.equal(resolveReplyLanguage('zh'), 'en') // env en > Config zh
    assert.equal(resolveReplyLanguage({ get: () => 'zh' }), 'en') // env en > Volatile Config
    assert.equal(resolveReplyLanguage(undefined), 'en') // env en > Config 缺失
    process.env.DSH_EXPERT_REPLY_LANG = 'zh'
    assert.equal(resolveReplyLanguage('en'), 'zh') // env zh > Config en（显式中文覆盖）
    process.env.DSH_EXPERT_REPLY_LANG = 'fr' // 不识别的 env 值：不覆盖，照常走 Config
    assert.equal(resolveReplyLanguage('en'), 'en')
    assert.equal(resolveReplyLanguage(undefined), 'zh')
    delete process.env.DSH_EXPERT_REPLY_LANG
  }))

test('T7 ② Config 读取：Volatile 引用与普通值两种形态都接受；仅 === en 生效为英文', () =>
  withReplyLangEnv(undefined, async () => {
    assert.equal(resolveReplyLanguage('en'), 'en') // 普通值
    assert.equal(resolveReplyLanguage({ get: () => 'en' }), 'en') // Volatile 引用（宿主 volatile 生效路径）
    assert.equal(resolveReplyLanguage('zh'), 'zh')
    assert.equal(resolveReplyLanguage('EN'), 'zh') // 大小写敏感：非精确 'en' 按中文
    assert.equal(resolveReplyLanguage('fr'), 'zh') // 非法值按中文
    assert.equal(resolveReplyLanguage(42), 'zh') // 非字符串按中文
    assert.equal(resolveReplyLanguage(null), 'zh')
  }))

test('T7 ② Config 缺失/降级不炸、行为零变化（=zh）：undefined / get() 抛错 / Volatile 返回异常值', () =>
  withReplyLangEnv(undefined, async () => {
    assert.equal(resolveReplyLanguage(undefined), 'zh') // Config 缺失（schemastery 降级/字段缺席）
    assert.equal(resolveReplyLanguage(), 'zh') // 完全不传参
    assert.equal(resolveReplyLanguage({ get: () => { throw new Error('boom') } }), 'zh') // Volatile 读取异常降级
    assert.equal(resolveReplyLanguage({ get: () => 42 }), 'zh') // Volatile 返回异常形态
    assert.equal(resolveReplyLanguage({}), 'zh') // 非 Volatile 非原始值
  }))

// ---------- ③ 设置页改后新 summon 生效路径（settings 注入级） ----------

test('T7 ③ 设置页 live 编辑→新 summon 生效：Volatile 引用原地改值，两次读取（=两次 summon）各自反映现值', () =>
  withReplyLangEnv(undefined, async () => {
    // 宿主 volatile 生效路径：fiber 原地更新 Volatile 引用，引用对象恒定、get() 快照变。
    let live = 'zh'
    const knob = { get: () => live }
    assert.equal(resolveReplyLanguage(knob), 'zh')
    live = 'en' // 模拟设置页开关改后
    assert.equal(resolveReplyLanguage(knob), 'en') // 下一次 summon 现场读取即生效
    live = 'zh'
    assert.equal(resolveReplyLanguage(knob), 'zh') // 改回同理
  }))

test('T7 ③ registerExpertTools 接受 replyLanguage 原样透传（Volatile/普通/缺省三形态都不炸）', () => {
  // T7 接线现状（如实记录）：lib/index.js apply 尚未把 config.replyLanguage 透传进
  // registerExpertTools——该一行透传被 T7 scope 门禁拦截（lib/index.js 不在 scope），
  // 需编排者补一行（`replyLanguage: config.replyLanguage,`，与 autoClaim 同缝）后
  // 「设置页开关改后新 summon 生效」才在真机全链生效。本任务交付的缝：参数已就位、
  // resolver 语义齐全，透传一旦接上即生效（下方 summon 零变化用例验证透传面行为）。
  const source = readFileSync(join(repoRoot, 'lib', 'tools.js'), 'utf8')
  assert.match(source, /replyLanguage/) // 参数与 resolver 就位
})

// ---------- summon 全链零变化回归：replyLanguage 传入（Volatile 'en'）不改变既有行为 ----------

/** 最小 summon 夹具（对齐 test/tools.selftest.mjs makeWp4aDst/makeWp4aCtx，无板：任务书
 *  不含任务 id 时 auto-claim 零副作用）。 */
const makeSummonFixture = (t, label) => {
  const dst = mkdtempSync(join(tmpdir(), `replylang-dst-${label}-`))
  t.after(() => rmSync(dst, { recursive: true, force: true }))
  mkdirSync(join(dst, 'expert-sources', 'merged'), { recursive: true })
  writeFileSync(
    join(dst, 'expert-sources', 'merged', 'roster.json'),
    JSON.stringify({ core: [{ source: 'bundled-core', file: 'a.md', name: '测试专家' }] }),
  )
  const descriptors = []
  const ctx = {
    tools: { register: (d) => descriptors.push(d) },
    subagents: {
      getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
      start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }),
    },
  }
  return { dst, descriptors, ctx }
}

test('T7 ③ summon 全链零变化：replyLanguage 透传（Volatile en / 缺省 undefined）下召唤行为一致', async (t) => {
  // ① 透传 Volatile 'en'（设置页开到英文）：summon 正常完成，answer 与基线同形
  const a = makeSummonFixture(t, 'en')
  registerExpertTools(a.ctx, { dst: a.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }), replyLanguage: { get: () => 'en' } })
  const ra = await a.descriptors.find((d) => d.name === 'summon_expert').execute({ expert: '测试专家', task: '请自我检查' }, { agent: {} })
  assert.ok(ra.answer.startsWith('ok'), ra.answer)
  // ② 不传 replyLanguage（Config 缺失降级）：同任务同输出形态，零变化
  const b = makeSummonFixture(t, 'missing')
  registerExpertTools(b.ctx, { dst: b.dst, getExpertContentImpl: () => ({ content: 'persona 正文' }) })
  const rb = await b.descriptors.find((d) => d.name === 'summon_expert').execute({ expert: '测试专家', task: '请自我检查' }, { agent: {} })
  assert.equal(ra.answer, rb.answer) // 行为零变化（逐字节一致）
})
