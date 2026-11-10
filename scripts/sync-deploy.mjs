#!/usr/bin/env node
/**
 * sync-deploy.mjs — 发版同步：发版完成后把新包拉到 Mac desktop 与 NAS 生产
 *
 * 用法: node scripts/sync-deploy.mjs <status|mac|nas> [--file] [--restart]
 *
 *   status      三端版本对账（本地工作区 / Mac desktop / NAS web profile）——只读
 *   mac         Mac desktop 同步：git fetch + 与 origin/main 对比 + 未提交改动警告
 *               （desktop 宿主经 link: symlink 直跑工作树，同步 = 工作树最新 + 重启宿主）
 *   nas         NAS 生产同步（npm 副本路径，默认）：profile 依赖升级到 npm latest
 *               （依赖级安装，铁律不手工拷 node_modules——2.13.4 实测 pnpm 对账会回滚）；
 *               NAS 侧 registry 为官方源，镜像/网络异常自动 fallback 官方源 + 7890 代理
 *   nas --file  备用路径：NAS 工作区 git pull --ff-only（ff 不动则退出）后 profile 改
 *               file: 直连（等价 dev 形态，2.13.9 起的 linked-root optional peer 已铺路）
 *   --restart   显式标记（见下）；升级落盘后提示重启指引——NAS dsh web 属 fnOS 应用
 *               用户 Harness，脚本无 kill 权限（EPERM 实证），重启须 appcenter UI 操作
 *
 * 凭据：SSH 免密（公钥已装 NAS authorized_keys，专用 key id_ed25519_74）；脚本零凭据，
 *       连接目标/路径可用环境变量覆盖（见下）。属仓库侧维护工具，不入 npm 包（scripts/
 *       从不在 files 白名单，惯例同 scan-persona-vars 等三个门禁 CLI）。
 *
 * 环境变量: DSH_SYNC_NAS_SSH（缺省 841859784@192.168.5.74）
 *           DSH_SYNC_NAS_KEY（缺省 ~/.ssh/id_ed25519_74）
 *           DSH_SYNC_NAS_PROFILE（缺省 /vol2/@appshare/Harness/.dsh/profiles/web）
 *           DSH_SYNC_NAS_WS（缺省 /vol2/@appshare/Harness/workspace/dsh-expert-orchestrator）
 *           DSH_SYNC_NAS_PROXY（缺省 http://127.0.0.1:7890，置空串禁用 fallback 代理）
 *
 * 退出码: 0=成功（含「已最新无动作」） 1=失败 2=环境缺失跳过（key 不存在/命令未知）
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = 'dsh-expert-orchestrator'
const NAS_SSH = process.env.DSH_SYNC_NAS_SSH || '841859784@192.168.5.74'
const NAS_KEY = process.env.DSH_SYNC_NAS_KEY || join(homedir(), '.ssh', 'id_ed25519_74')
const NAS_PROFILE = process.env.DSH_SYNC_NAS_PROFILE || '/vol2/@appshare/Harness/.dsh/profiles/web'
const NAS_WS = process.env.DSH_SYNC_NAS_WS || '/vol2/@appshare/Harness/workspace/dsh-expert-orchestrator'
const NAS_PROXY = process.env.DSH_SYNC_NAS_PROXY ?? 'http://127.0.0.1:7890'
const DESKTOP_NM = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', PKG)

const args = process.argv.slice(2)
const cmd = args[0]
const flags = new Set(args.slice(1))
const log = (...m) => console.log('[sync-deploy]', ...m)
const die = (code, ...m) => { console.error('[sync-deploy]', ...m); process.exit(code) }

const sh = (c, opts = {}) => spawnSync('sh', ['-c', c], { encoding: 'utf-8', ...opts })
const shOut = (c) => sh(c).stdout?.trim() ?? ''

/** NAS 远程命令（免密 ssh）；返回 { code, stdout, stderr }。 */
const ssh = (remoteCmd) => spawnSync('ssh', ['-i', NAS_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', NAS_SSH, remoteCmd], { encoding: 'utf-8' })
const sshOut = (c) => ssh(c).stdout?.trim() ?? ''

/** npm latest（本地查询，走本机 npm/registry 配置）。 */
const npmLatest = () => {
  const r = sh(`npm view ${PKG} version 2>/dev/null`)
  return r.status === 0 ? r.stdout.trim() : null
}

/** 远端（NAS）npm latest：官方源直取；空则走代理重试一次。 */
const nasNpmLatest = () => {
  let out = sshOut(`curl -s -m 12 https://registry.npmjs.org/${PKG}/latest 2>/dev/null | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p'`)
  if (!out && NAS_PROXY) {
    out = sshOut(`curl -s -m 12 -x ${NAS_PROXY} https://registry.npmjs.org/${PKG}/latest 2>/dev/null | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p'`)
  }
  return out || null
}

/** 读 profile 实装版本（远端）。 */
const nasInstalledVersion = () =>
  sshOut(`grep -m1 '"version"' ${NAS_PROFILE}/node_modules/${PKG}/package.json 2>/dev/null | sed 's/.*: *"\\(.*\\)".*/\\1/'`)

const localVersion = () => {
  try { return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version } catch { return '?' }
}
const desktopInfo = () => {
  if (!existsSync(DESKTOP_NM)) return { linked: false, version: null }
  let target = null
  try { target = realpathSync(DESKTOP_NM) } catch { /* not a symlink or broken */ }
  const version = shOut(`grep -m1 '"version"' ${DESKTOP_NM}/package.json 2>/dev/null | sed 's/.*: *"\\(.*\\)".*/\\1/'`)
  return { linked: !!target, target, version }
}

// ── status ────────────────────────────────────────────────────────────────────
function cmdStatus() {
  const latest = npmLatest()
  const d = desktopInfo()
  const head = shOut(`git -C ${REPO} log -1 --oneline 2>/dev/null`)
  const tag = shOut(`git -C ${REPO} describe --tags --abbrev=0 2>/dev/null || echo '(无 tag)'`)
  log(`npm latest      : ${latest ?? '查询失败'}`)
  log(`本地工作区      : ${localVersion()} @ ${head || 'git 不可用'}（最近 tag ${tag}）`)
  log(`Mac desktop     : ${d.linked ? `link: ${d.target}（实装 ${d.version}）` : '非 symlink 安装'}${d.version === latest ? ' —— 已最新' : ''}`)
  if (!existsSync(NAS_KEY)) die(2, `SSH key 不存在：${NAS_KEY}（发版同步需要免密通道，先装公钥）`)
  const ni = nasInstalledVersion()
  const nl = nasNpmLatest()
  const ws = sshOut(`git -C ${NAS_WS} log --oneline -1 2>/dev/null`)
  log(`NAS web profile : ${ni || '未安装/不可达'}${nl && ni && ni !== nl ? ` —— 落后，latest ${nl}` : ni && ni === nl ? ' —— 已最新' : ''}`)
  log(`NAS 工作区      : ${ws || '不可达/非 git'}`)
}

// ── mac ───────────────────────────────────────────────────────────────────────
function cmdMac() {
  log('git fetch origin …')
  const f = sh(`git -C ${REPO} fetch origin 2>&1`)
  if (f.status !== 0) die(1, `git fetch 失败：${f.stderr?.trim()}`)
  const head = shOut(`git -C ${REPO} rev-parse HEAD`)
  const main = shOut(`git -C ${REPO} rev-parse origin/main`)
  const dirty = shOut(`git -C ${REPO} status --porcelain`)
  if (dirty) log(`⚠ 工作树有未提交改动（desktop 实跑的就是这些）：\n${dirty.split('\n').map((l) => '    ' + l).join('\n')}`)
  if (head === main) {
    log(`已与 origin/main 一致（${head.slice(0, 9)}），无动作。`)
  } else if (dirty) {
    log(`⚠ 本地领先/分叉且工作树不干净——desktop 跑的是工作树现场，git pull 请自行裁决；不自动 pull。`)
  } else {
    const p = sh(`git -C ${REPO} pull --ff-only origin main 2>&1`)
    if (p.status !== 0) die(1, `git pull 失败：${p.stdout}${p.stderr}`)
    log(p.stdout.trim())
  }
  log('提醒：desktop 宿主需重启才会加载新 lib（Electron 无法脚本重启）。')
}

// ── nas（npm 主路径 / --file 备用路径）────────────────────────────────────────
function cmdNas() {
  if (!existsSync(NAS_KEY)) die(2, `SSH key 不存在：${NAS_KEY}`)
  const ping = ssh('echo ok')
  if (ping.status !== 0 || ping.stdout.trim() !== 'ok') die(1, `NAS ssh 不可达（${NAS_SSH}）：${ping.stderr?.trim()}`)

  // 前置：pnpm 可用 + profile 可写
  const pre = ssh(`which pnpm >/dev/null 2>&1 && test -w ${NAS_PROFILE} && echo PRE-OK`)
  if (!pre.stdout.includes('PRE-OK')) die(2, `NAS 环境缺失：pnpm 不可用或 profile 不可写（${NAS_PROFILE}）`)

  const installed = nasInstalledVersion()
  const wsHead = sshOut(`git -C ${NAS_WS} log --oneline -1 2>/dev/null`)
  log(`NAS 现状：实装 ${installed || '无'}；工作区 ${wsHead || '非 git'}`)

  if (flags.has('--file')) return nasFile()
  return nasNpmPath(installed)
}

/** 依赖级升级（改 spec → pnpm install → 校验实装）。NAS registry 缺版本时走代理 fallback。 */
function nasNpmPath(installed) {
  const latest = nasNpmLatest()
  if (!latest) die(1, 'npm latest 查询失败（NAS 侧 curl 官方源与代理皆空）')
  if (installed === latest) {
    log(`NAS 已是 latest（${latest}），无动作。`)
    return maybeRestart()
  }
  log(`升级 ${installed || '(无)'} → ${latest}（依赖级安装）…`)
  // spec 收敛到 ^latest（node -e 改 JSON，避免 sed 转义坑），随后 pnpm install；
  // CI=true：ssh 非 TTY 下 pnpm 清理 node_modules 需确认（ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY）
  const setSpec = `node -e "const fs=require('fs');const f='${NAS_PROFILE}/package.json';const p=JSON.parse(fs.readFileSync(f,'utf8'));p.dependencies['${PKG}']='^${latest}';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\\n')"`
  const install = (extra) => ssh(`env CI=true pnpm -C ${NAS_PROFILE} install ${extra} 2>&1 | tail -3`)
  let r = ssh(`${setSpec} && ${install('')}`)
  const verify = () => nasInstalledVersion()
  if (r.status !== 0 || verify() !== latest) {
    if (!NAS_PROXY) die(1, `升级失败且代理 fallback 已禁用：${r.stderr?.trim() || r.stdout?.trim()}`)
    log('默认通道未到位，走官方源 + 代理 fallback 重试一次 …')
    r = ssh(`${setSpec} && env HTTPS_PROXY=${NAS_PROXY} HTTP_PROXY=${NAS_PROXY} pnpm -C ${NAS_PROFILE} install 2>&1 | tail -3`)
  }
  const got = verify()
  if (got !== latest) die(1, `升级后校验失败：实装 ${got} ≠ ${latest}。输出：${r.stdout?.trim()}`)
  log(`✓ NAS 实装 ${got}（依赖级安装，pnpm-lock 已随动）。`)
  return maybeRestart()
}

/** 备用路径：工作区 ff-only pull → profile 改 file: 直连。 */
function nasFile() {
  const dirty = sshOut(`git -C ${NAS_WS} status --porcelain 2>/dev/null | head -3`)
  if (dirty) die(1, `NAS 工作区不干净，pull 请人工裁决：\n${dirty}`)
  let pull = ssh(`git -C ${NAS_WS} pull --ff-only origin main 2>&1 | tail -2`)
  if (pull.status !== 0 && NAS_PROXY) {
    log('直连 pull 失败，走代理重试一次 …')
    pull = ssh(`git -C ${NAS_WS} -c http.proxy=${NAS_PROXY} -c https.proxy=${NAS_PROXY} pull --ff-only origin main 2>&1 | tail -2`)
  }
  if (pull.status !== 0) die(1, `git pull --ff-only 失败：${pull.stdout?.trim() || pull.stderr?.trim()}`)
  log(`工作区：${pull.stdout.trim() || '已最新'}`)
  const target = `${NAS_WS}`
  const setSpec = `node -e "const fs=require('fs');const f='${NAS_PROFILE}/package.json';const p=JSON.parse(fs.readFileSync(f,'utf8'));p.dependencies['${PKG}']='file:${target}';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\\n')"`
  const r = ssh(`${setSpec} && env CI=true pnpm -C ${NAS_PROFILE} install 2>&1 | tail -3`)
  const got = nasInstalledVersion()
  const wsVer = sshOut(`grep -m1 '"version"' ${NAS_WS}/package.json | sed 's/.*: *"\\(.*\\)".*/\\1/'`)
  if (got !== wsVer) die(1, `file: 安装后校验失败：实装 ${got} ≠ 工作区 ${wsVer}。输出：${r.stdout?.trim()}`)
  log(`✓ NAS 已 file: 直连工作区（${wsVer} @ ${sshOut(`git -C ${NAS_WS} log --oneline -1`)}）。`)
  return maybeRestart()
}

/** --restart：升级已落盘，但 dsh web 属主是 fnOS 应用用户 Harness（appcenter 应用），
 *  ssh 用户 kill 会 EPERM（两次实证；且 pkill/pgrep 的 -f 模式会匹配到承载自身命令串的
 *  远程 shell 自杀导致输出为空、误判「已终止」）——脚本侧重启不可行，如实给指引。 */
function maybeRestart() {
  const pid = sshOut(`pgrep -f 'dsh web --no-open --port 1308[0]' | head -1`)
  if (!pid) {
    log('dsh web 未在运行——升级已落盘，启动即用新版本。')
    return
  }
  log(`dsh web 在跑（pid ${pid}，仍是内存中的旧代码）。NAS 磁盘实装已是新版本，重启后生效：`)
  log('  → fnOS 应用中心 → Harness → 重启（或停止后再启动）。')
  if (!flags.has('--restart')) return
  log('（--restart 仅为显式标记；脚本对应用用户进程无 kill 权限，重启仍需 appcenter UI 操作。）')
}

// ── 入口 ──────────────────────────────────────────────────────────────────────
const handlers = { status: cmdStatus, mac: cmdMac, nas: cmdNas }
if (!handlers[cmd]) {
  console.error('用法: node scripts/sync-deploy.mjs <status|mac|nas> [--file] [--restart]（详见文件头注释）')
  process.exit(cmd ? 1 : 2)
}
handlers[cmd]()
