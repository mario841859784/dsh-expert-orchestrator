// test/hook-multiboard.selftest.mjs — commit-msg 门禁 hook 多板运行时解析自测（v2.13.1 T1，node:test，零依赖）。
// 核心回归=「提交根与板路径解耦」：hook 运行时以 git rev-parse --show-toplevel 取提交所在仓库根，
// 扫描其 .expert-taskboards/ 下全部 *.json 板联合三查——worktree 与主仓共享 .git/hooks，worktree
// 私有板同样被读取。全部用例跑在 tmp git 仓库（mkdtemp），不改本仓 .git/hooks/。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const TB = join(repoRoot, 'skills', 'expert-orchestration', 'tools', 'taskboard.py')

function tb(args, cwd) {
  return spawnSync('python3', [TB, ...args], { cwd, encoding: 'utf8' })
}

function makeRepo(tag) {
  const root = mkdtempSync(join(tmpdir(), `hook-multiboard-${tag}-`))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.expert-taskboards'), { recursive: true })
  execFileSync('git', ['init', '-q', '.'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  return { root, repo }
}

function board(name, title, scope, cwd) {
  const b = join('.expert-taskboards', name)
  const r = tb(['--board', b, 'create', title, '--owner', 'x', '--scope', scope], cwd)
  assert.equal(r.status, 0, `create 失败: ${r.stderr}`)
  return r.stdout
}

function claim(name, cwd) {
  const r = tb(['--board', join('.expert-taskboards', name), 'claim', 'T1', 'x'], cwd)
  assert.equal(r.status, 0, `claim 失败: ${r.stderr}`)
}

function commit(repo, msg, files) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true })
    writeFileSync(join(repo, p), content)
  }
  execFileSync('git', ['add', ...Object.keys(files)], { cwd: repo })
  return spawnSync('git', ['commit', '-m', msg], { cwd: repo, encoding: 'utf8' })
}

function hookScript(repo) {
  return join(repo, '.git', 'hooks', 'commit-msg')
}

// ── 模板层：_hook_content 按 --board 有无切换多板/固化单板 ──────────────────
test('模板与安装产物：无 --board → 运行时按提交根扫描多板；有 --board → 固化单板', () => {
  const { repo, root } = makeRepo('template')
  let r = tb(['--install-hook'], repo)
  assert.equal(r.status, 0)
  const sh = execFileSync('cat', [hookScript(repo)], { encoding: 'utf8' })
  assert.match(sh, /\$\(git rev-parse --show-toplevel 2>\/dev\/null \|\| pwd -P\)\/\.expert-taskboards/)
  assert.match(sh, /_hook-check "\$1"\s+"\$\(git rev-parse/)
  assert.doesNotMatch(sh, /--board "/)
  // 固化单板形态：显式 --board 后不含 rev-parse，含固化绝对路径（向后兼容）
  r = tb(['--install-hook', '--board', join(root, 'fixed.json')], repo)
  assert.equal(r.status, 0)
  const sh2 = execFileSync('cat', [hookScript(repo)], { encoding: 'utf8' })
  assert.match(sh2, /--board "[^"]+fixed\.json" _hook-check "\$1"\n/) // 调用行=固化单板
  assert.doesNotMatch(sh2, /_hook-check "\$1"\s+"\$\(git rev-parse/) // 调用行不再按提交根解析
  rmSync(root, { recursive: true, force: true })
})

// ── 端到端：真实 git commit 走 hook ──────────────────────────────────────────
function setupGate(repo, boards) {
  for (const [name, scope] of boards) board(name, name, scope, repo)
  for (const [name] of boards) claim(name, repo)
  const r = tb(['--install-hook'], repo)
  assert.equal(r.status, 0, `install-hook 失败: ${r.stderr}`)
}

test('单板过/不过：消息 id 在板内且 running + 文件在 scope 内 → 过；夹带假 id → 拒', () => {
  const { repo, root } = makeRepo('single')
  setupGate(repo, [['default.json', 'src']])
  // 首个提交（worktree add 需要非 unborn HEAD）
  let r = commit(repo, 'chore: init T1', { 'src/a.txt': 'x' })
  assert.equal(r.status, 0, `应通过: ${r.stderr}`)
  r = commit(repo, 'feat: T1 T9', { 'src/b.txt': 'x' })
  assert.equal(r.status, 1, '夹带不在板内的 T9 应被拒')
  assert.match(r.stderr, /任务 T9 不在任务板内/)
  rmSync(root, { recursive: true, force: true })
})

test('单板：scope 超界拒（fail closed）；done 后引用合法（存在性校验），终态 scope 仍约束超界', () => {
  const { repo, root } = makeRepo('single-fail')
  setupGate(repo, [['default.json', 'src']])
  let r = commit(repo, 'chore: init T1', { 'src/a.txt': 'x' })
  assert.equal(r.status, 0)
  r = commit(repo, 'feat: T1', { 'other/b.txt': 'x' })
  assert.equal(r.status, 1, 'scope 超界应被拒')
  assert.match(r.stderr, /超出任务 T1 scope/)
  // done 后再提交：② 存在性校验——终态 id 仍在板内即过（不要求 running），终态 scope 仍进并集
  const d = tb(['done', 'T1', 'x', '--by', 'x'], repo)
  assert.equal(d.status, 0)
  spawnSync('git', ['reset'], { cwd: repo }) // 撤销上一步被拒提交遗留的暂存（other/b.txt 不得混入）
  r = commit(repo, 'feat: T1 again', { 'src/c.txt': 'x' })
  assert.equal(r.status, 0, `done 后引用应通过（存在性校验）: ${r.stderr}`)
  assert.match(String(r.stdout) + String(r.stderr), /id 均在板内/)
  r = commit(repo, 'feat: T1 out of scope', { 'other/d.txt': 'x' })
  assert.equal(r.status, 1, 'done 后 scope 超界仍应被拒')
  assert.match(r.stderr, /超出任务 T1 scope/)
  rmSync(root, { recursive: true, force: true })
})

test('多板并集：跨板任务 id 各在任一板 running，scope 并集跨板覆盖 → 过', () => {
  const { repo, root } = makeRepo('multi')
  setupGate(repo, [['default.json', 'src'], ['extra.json', 'docs']])
  // 两块板各自都有 T1（任务 id 按板独立编号），消息引 T1 任一板 running 即过，scope 并集=src+docs
  const r = commit(repo, 'feat: both boards T1', { 'src/a.txt': 'x', 'docs/b.md': 'x' })
  assert.equal(r.status, 0, `跨板并集应通过: ${r.stderr}`)
  rmSync(root, { recursive: true, force: true })
})

test('核心回归：worktree 根解析正确——共享 .git/hooks 下 worktree 私有板被读取（提交根与板路径解耦）', () => {
  const { repo, root } = makeRepo('wt')
  setupGate(repo, [['default.json', 'src']])
  let r = commit(repo, 'chore: init T1', { 'src/a.txt': 'x' })
  assert.equal(r.status, 0)
  // 建 worktree（共享 .git/hooks，这正是多板修复的生产场景）
  const wt = join(root, 'wt')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wtb', wt], { cwd: repo })
  // worktree 私有板：主仓 default.json 不存在于 worktree 的 .expert-taskboards
  assert.ok(!existsSync(join(wt, '.expert-taskboards', 'default.json')))
  board('private.json', 'p', 'wt-src', wt)
  claim('private.json', wt)
  // 修复后：hook 以 worktree 根扫描，私有板 T1 running 生效
  r = commit(wt, 'feat: wt task T1', { 'wt-src/a.txt': 'x' })
  assert.equal(r.status, 0, `worktree 私有板应生效: ${r.stderr}`)
  // 主仓提交仍走主仓板（互不串扰）
  r = commit(repo, 'feat: main T1', { 'src/b.txt': 'x' })
  assert.equal(r.status, 0, `主仓板应不受 worktree 板影响: ${r.stderr}`)
  rmSync(root, { recursive: true, force: true })
})

test('无板 fail-open：.expert-taskboards 为空目录时提交放行并告警', () => {
  const { repo, root } = makeRepo('empty')
  const r0 = tb(['--install-hook'], repo)
  assert.equal(r0.status, 0)
  // 需要一个不引任务 id 的提交——无板时连 ① 都不查（fail-open 降级语义）
  const r = commit(repo, 'chore: init no task id', { 'a.txt': 'x' })
  assert.equal(r.status, 0, `无板应 fail-open 放行: ${r.stderr}`)
  assert.match(r.stderr, /fail-open/)
  rmSync(root, { recursive: true, force: true })
})

test('向后兼容：显式 --board 固化单板 hook 仍可用（单板过/不过）', () => {
  const { repo, root } = makeRepo('fixed')
  board('default.json', 'a', 'src', repo)
  claim('default.json', repo)
  const r0 = tb(['--install-hook', '--board', join(repo, '.expert-taskboards', 'default.json')], repo)
  assert.equal(r0.status, 0)
  let r = commit(repo, 'chore: init T1', { 'src/a.txt': 'x' })
  assert.equal(r.status, 0, `固化单板应通过: ${r.stderr}`)
  r = commit(repo, 'feat: T1', { 'other/b.txt': 'x' })
  assert.equal(r.status, 1, '固化单板 scope 超界应被拒')
  rmSync(root, { recursive: true, force: true })
})

test('多板降级：板目录存在但全部板损坏 → fail-open；好板+坏板混存 → 坏板跳过、好板照常裁决', () => {
  const { repo, root } = makeRepo('corrupt')
  const bdir = join(repo, '.expert-taskboards')
  writeFileSync(join(bdir, 'bad.json'), '{ not json')
  const r0 = tb(['--install-hook'], repo)
  assert.equal(r0.status, 0)
  let r = commit(repo, 'chore: no loadable board', { 'a.txt': 'x' })
  assert.equal(r.status, 0, '全部板加载失败应 fail-open')
  assert.match(r.stderr, /无任何可加载任务板/)
  // 混存：好板 default.json + 坏板 bad.json —— 好板照常裁决
  board('default.json', 'a', 'src', repo)
  claim('default.json', repo)
  rmSync(join(bdir, 'bad.json'))
  writeFileSync(join(bdir, 'bad.json'), '[]') // 顶层非对象，加载失败但好板在场
  r = commit(repo, 'feat: T1 with corrupt sibling', { 'src/a.txt': 'x' })
  assert.equal(r.status, 0, `好板应照常裁决: ${r.stderr}`)
  assert.match(r.stderr, /跳过该板/)
  rmSync(root, { recursive: true, force: true })
})

test('多板终态背书：done 板的 T1 scope 仍进并集（并集=src+docs；并集外文件仍拒）', () => {
  const { repo, root } = makeRepo('done-board')
  setupGate(repo, [['default.json', 'src'], ['extra.json', 'docs']])
  // extra 板 T1 收口后，其 docs scope 仍背书：③ 并集取全部命中条目（含终态）= src+docs
  const d = tb(['--board', join('.expert-taskboards', 'extra.json'), 'done', 'T1', 'x', '--by', 'x'], repo)
  assert.equal(d.status, 0)
  let r = commit(repo, 'feat: T1 after extra done', { 'src/a.txt': 'x', 'docs/b.md': 'x' })
  assert.equal(r.status, 0, `done 板 scope 应背书（并集含终态条目）: ${r.stderr}`)
  assert.match(String(r.stdout) + String(r.stderr), /id 均在板内.*scope 并集内/)
  r = commit(repo, 'feat: T1 out of union', { 'other/c.txt': 'x' })
  assert.equal(r.status, 1, '并集外文件仍应被拒')
  // 拒绝消息点名的并集即终态背书的凭证：docs（done 板）仍在并集内
  assert.match(r.stderr, /超出任务 T1 scope/)
  assert.match(r.stderr, /并集: src, docs/)
  rmSync(root, { recursive: true, force: true })
})

test('跨板存在性+终态背书：同 id 一板 done 一板 running → 任一板存在即过，done 板 scope 跨板背书', () => {
  const { repo, root } = makeRepo('cross-done')
  setupGate(repo, [['default.json', 'src'], ['extra.json', 'docs']])
  const d = tb(['--board', join('.expert-taskboards', 'extra.json'), 'done', 'T1', 'x', '--by', 'x'], repo)
  assert.equal(d.status, 0)
  // default 板 T1 running、extra 板 T1 done：② 任一板存在即过；只触 docs（仅 done 板 scope 覆盖，
  // running 板只声明 src）也通过——证明 ③ 并集跨板取全部命中条目（含终态），终态板 scope 可背书
  const r = commit(repo, 'feat: cross board T1 done+running', { 'docs/only.md': 'x' })
  assert.equal(r.status, 0, `跨板终态背书应通过: ${r.stderr}`)
  assert.match(String(r.stdout) + String(r.stderr), /id 均在板内/)
  rmSync(root, { recursive: true, force: true })
})

test('临时目录卫生：用例结束后清理', () => {
  const left = readdirSync(tmpdir()).filter((d) => d.startsWith('hook-multiboard-'))
  assert.ok(left.length <= 2, `残留 tmp 目录过多: ${left.join(',')}`)
})
