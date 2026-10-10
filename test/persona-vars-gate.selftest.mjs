// test/persona-vars-gate.selftest.mjs — 发布门禁⑦自测（node:test，零依赖）。
// 语义（.expert-lessons.md:271）：persona 模板 {{变量}} ⊆ {provider, model}。
// 正例=当前仓库两文件（agent.cordis.yml + 生成物 cordis.patch.yml）通过；
// 负例=os.tmpdir() 临时 fixture 注入 {{cwd}} 必须失败；文件缺失/无 persona
// 块必须失败（不静默跳过）；注释行豁免与块标量折叠延续为固化的策略定义。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ALLOWED_PERSONA_VARS, extractPersonaLines, scanPersonaTemplateVars } from '../lib/persona-vars-gate.js'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..')
const REPO_TARGETS = [join(repoRoot, 'agent.cordis.yml'), join(repoRoot, 'cordis.patch.yml')]

test('门禁⑦：白名单恒为 {provider, model}', () => {
  assert.deepEqual([...ALLOWED_PERSONA_VARS].sort(), ['model', 'provider'])
})

test('门禁⑦正例：当前仓库 agent.cordis.yml + cordis.patch.yml 均通过', () => {
  const { ok, violations } = scanPersonaTemplateVars(REPO_TARGETS)
  assert.equal(ok, true, `当前仓库不应有违规: ${JSON.stringify(violations)}`)
})

test('门禁⑦正例：两文件的 persona 块都被找到且含 {{model}}（防扫描空转）', () => {
  for (const file of REPO_TARGETS) {
    const lines = extractPersonaLines(readFileSync(file, 'utf8'))
    assert.ok(lines.length > 0, `${file} 应提取到 persona 块行`)
    assert.ok(lines.some((l) => l.includes('{{model}}')), `${file} persona 块应含 {{model}}`)
  }
})

test('门禁⑦负例：persona prefix 注入 {{cwd}} → 扫描失败并定位变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-gate-'))
  try {
    const file = join(dir, 'bad.cordis.yml')
    writeFileSync(file, [
      'plugins:',
      '  - id: persona',
      "    name: '@deepseek-ai/dsh-persona'",
      '    config:',
      '      prefix: |-',
      '        你是专家。',
      '        当前驱动模型：{{model}}。',
      '        工作目录：{{cwd}}。',
      ''
    ].join('\n'))
    const { ok, violations } = scanPersonaTemplateVars([file])
    assert.equal(ok, false)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].kind, 'disallowed-var')
    assert.equal(violations[0].variable, 'cwd')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁⑦负例：折叠块标量（>-）跨行引用 {{cwd}} → 仍失败（经验提示①）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-gate-'))
  try {
    const file = join(dir, 'folded.cordis.yml')
    writeFileSync(file, [
      'plugins:',
      '  - id: persona',
      '    config:',
      '      suffix: >-',
      '        上下文根目录为',
      '        {{cwd}}，请勿越界。',
      ''
    ].join('\n'))
    const { ok, violations } = scanPersonaTemplateVars([file])
    assert.equal(ok, false)
    assert.equal(violations[0].variable, 'cwd')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁⑦策略固化：块标量外注释行的 {{cwd}} 豁免（agent.cordis.yml:57 场景）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-gate-'))
  try {
    const file = join(dir, 'comment.cordis.yml')
    writeFileSync(file, [
      'plugins:',
      '  - id: persona',
      '    config:',
      '      # suffix 省略：{{cwd}} 不是注册的提示词变量（历史故障解释注释）',
      '      prefix: |-',
      '        当前驱动模型：{{model}}。',
      ''
    ].join('\n'))
    const { ok, violations } = scanPersonaTemplateVars([file])
    assert.equal(ok, true, `块外注释行不应判违规: ${JSON.stringify(violations)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁⑦策略固化：块标量内以 # 起始的行是字面内容，{{cwd}} 照判违规', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-gate-'))
  try {
    const file = join(dir, 'hash-content.cordis.yml')
    writeFileSync(file, [
      'plugins:',
      '  - id: persona',
      '    config:',
      '      prefix: |-',
      '        # {{cwd}} 被注入到字面内容首行',
      ''
    ].join('\n'))
    const { ok, violations } = scanPersonaTemplateVars([file])
    assert.equal(ok, false)
    assert.equal(violations[0].variable, 'cwd')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁⑦：目标文件缺失 → fail，不静默跳过', () => {
  const ghost = join(tmpdir(), `persona-gate-missing-${process.pid}-不存在.yml`)
  const { ok, violations } = scanPersonaTemplateVars([ghost])
  assert.equal(ok, false)
  assert.equal(violations[0].kind, 'missing')
})

test('门禁⑦：文件存在但无 persona 块 → fail，不静默跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-gate-'))
  try {
    const file = join(dir, 'no-persona.cordis.yml')
    writeFileSync(file, 'plugins:\n  - id: tool-bash\n    name: x\n')
    const { ok, violations } = scanPersonaTemplateVars([file])
    assert.equal(ok, false)
    assert.equal(violations[0].kind, 'no-persona-block')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁⑦：CLI 入口对仓库两文件退出 0，对缺失文件退出 1', () => {
  const cli = join(repoRoot, 'scripts', 'scan-persona-vars.mjs')
  const passRun = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
  assert.equal(passRun.status, 0, `CLI 应通过: ${passRun.stderr}`)
  assert.match(passRun.stdout, /PASS/)
  const failRun = spawnSync(process.execPath, [cli, join(tmpdir(), `gate-missing-${process.pid}.yml`)], { encoding: 'utf8' })
  assert.equal(failRun.status, 1)
  assert.match(failRun.stderr, /无法读取目标文件/)
})
