// test/preset-list-agents-guard.selftest.mjs — list-agents 行导出探测门控自测（node:test，零依赖）。
//
// 背景（2026-11-01 真机诊断）：宿主 ≥0.2.2-alpha.2 的 dsh-tool-subagent-control
// 把 list_agents 收编进主行（lib/index.js apply() 内 registerListAgents）并删除
// `./list-agents` 子路径导出；0.2.1 系（实测 0.2.1-rc.5）则相反——主行不注册
// list_agents，仅有子路径导出。preset 声明面（agent.cordis.yml delegation 组，
// 生成到 cordis.patch.yml）里的 `tool-subagent-list-agents` 行在 ≥0.2.2 宿主上
// 解析不到模块，loader 不给 fiber，registry auditRows 记为
// "tool-subagent-list-agents (…/list-agents): never started"，整卡打「加载失败」
// （dsh-client-ui-agent-preset brokenBadge）。
//
// 修复：该行加 `disabled: !!js` 导出探测门控——createRequire(process.argv[1])
// （dsh bin，与 loader 解析宿主包同域）尝试 resolve 子路径：可解析（≤0.2.1）→
// 保留行；解析不到（≥0.2.2，子路径导出已删）→ 停用行，list_agents 由主行提供。
//
// 本套件覆盖三层（防「断言生成器输出==生成器输出」自指盲区，T14 回炉同款口径）：
//   1) 提交产物形态：cordis.patch.yml 的 list-agents 行必须带 `disabled: !!js` 门控；
//   2) 表达式语义实测：0.2.1 形态导出（有 ./list-agents）→ 行保留（false）；
//      0.2.2 形态导出（无）→ 行停用（true）；表达式文本从**提交产物**逐字提取；
//   3) 鉴别力自证：把产物里的门控行替换回旧行（无 disabled）后，断言①必须变红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(repoRoot, 'cordis.patch.yml')
const patchText = () => readFileSync(patchPath, 'utf8')

/** 从产物里提取 list-agents 行的 `!!js` 表达式文本（YAML 双引号样式）。 */
function extractGuardExpression(text) {
  const m = text.match(/- id: tool-subagent-list-agents[\s\S]*?disabled: !!js "(.*?)"\s*\n/)
  return m ? m[1] : null
}

test('preset list-agents 行带导出探测门控（产物形态）', () => {
  const text = patchText()
  const row = text.match(/- id: tool-subagent-list-agents[\s\S]*?(?=\n\s+- id: )/)
  assert.ok(row, 'cordis.patch.yml 含 tool-subagent-list-agents 行')
  assert.match(row[0], /disabled: !!js /, 'list-agents 行必须带 disabled: !!js 门控（≥0.2.2 宿主解析不到该行会记 never started，整卡加载失败）')
  assert.match(extractGuardExpression(text) ?? '', /createRequire\(process\.argv\[1\]\)/, '门控必须以 dsh bin（argv[1]）为解析锚')
})

test('门控表达式语义实测——0.2.1 形态保留行、0.2.2 形态停用行（子进程实跑表达式文本）', (t) => {
  const expr = extractGuardExpression(patchText())
  assert.ok(expr, '产物里能提取到门控表达式')
  const run = (exportsMap) => {
    const dir = mkdtempSync(join(tmpdir(), 'list-agents-guard-'))
    t.after(() => { rmSync(dir, { recursive: true, force: true }) })
    const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent-control', 'lib')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-subagent-control', exports: exportsMap }))
    writeFileSync(join(pkg, 'index.js'), 'export default {}\n')
    if (exportsMap['./list-agents']) writeFileSync(join(pkg, 'list-agents.js'), 'export default {}\n')
    // anchor.mjs 在 fixture 根：process.argv[1] 指向它，模拟真机「dsh bin 锚」的解析域
    writeFileSync(join(dir, 'anchor.mjs'), 'const disabled = eval(process.argv[2]);\nconsole.log(disabled)\n')
    const r = spawnSync(process.execPath, [join(dir, 'anchor.mjs'), expr], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  // 0.2.1 形态（实测 0.2.1-rc.5）：主行不注册 list_agents，子路径导出在 → 行保留
  assert.equal(run({ '.': { default: './lib/index.js' }, './list-agents': { default: './lib/list-agents.js' } }), 'false')
  // 0.2.2 形态（实测 0.2.2-alpha.2）：子路径导出已删，list_agents 由主行注册 → 行停用
  assert.equal(run({ '.': { default: './lib/index.js' } }), 'true')
})

test('鉴别力自证——产物回归旧形态（无门控）时，形态断言必须变红', () => {
  const text = patchText()
  const guarded = text.match(/- id: tool-subagent-list-agents[\s\S]*?(?=\n\s+- id: )/)?.[0] ?? ''
  assert.ok(guarded.includes('disabled: !!js'), '前置：提交产物确实带门控')
  const legacy = guarded.split('\n').filter((l) => !l.includes('disabled: !!js')).join('\n')
  assert.ok(!legacy.includes('disabled: !!js'))
  assert.doesNotMatch(legacy, /disabled: !!js /, '旧行形态应不含门控——本断言若红说明行定位漂移')
})
