// #22 之一：per-cwd 并发写锁（v2.8 M8-2 / WP-7 ④，T26）
//
// 参考实现：dsh-crew src/cwd-lock.mjs（调研 C-expert-team-swarm §3 ③；借鉴结论见
// expert-team-research/C-expert-team-swarm.md 第 5 条）。语义逐条对齐验收 (d)：
// **同 cwd 双专家并发写被拒绝而非排队**——「排队会把调用方 bug 藏在静默等待后面，第二个
// 写者通常本来就在破坏第一个的成果」。这是协议既有红线（SKILL.md §3「共享工作树写互斥：
// 同一仓库同一时间只委派一个写型专家」）的工具级执法点，在 summon 派发边界生效
// （拉起专家之前拒绝，crew 教训：拒绝发生在拉起任何东西之前且信息可读可行动）。
//
// 与既有 board_lock（taskboard.py fcntl.flock）惯例的关系：同样是「锁文件 + 原子语义 +
// 崩溃自愈」的运行时协调面，但 Node 核心无 fcntl——用 O_EXCL 独占创建实现互斥（等价
// 语义），锁文件落 <cwd>/.expert-bus/（gitignore 豁免类，与 bus 根同区，不新增顶层脏项）。
//
// 重入语义（任务书要求「同专家重入语义想清楚再定」，裁定如下）：
// - 单专家多阶段的**顺序**再召唤：前一次 run 结束即释放（synchronous summon 天然串行），
//   永不误伤；
// - 同专家**并发**再召唤（summon_experts 同批双开同名专家的分工场景）：同 pid + 同专家名
//   计为重入，计数放行（持有者 JSON count 字段；同步读写段无 await，进程内无竞态）；
// - 跨进程同名不构成重入（两个宿主进程写同一工作区正是本锁要挡的事故面），照拒。
// - 释放面（T37 评审回炉裁定）：重入与原始持有者各自按计数递减，**递减到 0 才 unlink**——
//   原始先完成不提前放锁（在途重入仍受保护），重入先退不误清原始持有；重入 release
//   闭包捕获锁文件**原 token**（本次新生成随机 token 从未写入锁文件，不可作比对基准）。
//
// 降级可见（crew 纪律「门禁降级必须可见」）：锁面内部错误（权限等）→ stderr 告警后放行
// （fail-open），绝不因门禁自身故障炸掉召唤主流程；持有者进程死亡（ESRCH）→ 偷锁自愈。
// 只读扇出逃生口：summon 显式声明 readOnly（验收 (d) 拒绝信息的三条出路之一）。
import { mkdirSync, openSync, readFileSync, closeSync, writeFileSync, unlinkSync, existsSync, fstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeCwdAnchor } from './origin-chain.js'

/** 开关（T26 裁定：**默认关闭，显式开启**）：本门禁是阻断型——默认开启会击穿
 *  summon_experts 并行批量（≤8、并发 4，部分成功语义）这一核心文档化流程（同 cwd
 *  不同专家并发派发是批量的正常形态），破坏性默认不应由工具单方面引入；故沿
 *  DSH_EXPERT_* 命名空间但取 opt-in 语义：DSH_EXPERT_CWD_LOCK 置 '0'/''/未设置 = 关
 *  （既有并发行为零变化，工具级执法退回协议自觉），置任何其他值 = 开。开启后同 cwd
 *  不同专家并发派发被拒（验收 (d)），只读扇出经 readOnly 逃生口，排障可临时再置 '0'。 */
export function cwdLockEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_CWD_LOCK
  return !(flag === undefined || flag === '' || flag === '0')
}

const LOCK_DIRNAME = '.expert-bus'
const LOCK_FILENAME = 'cwd-write.lock'

function lockPath(cwdKey) {
  return join(cwdKey, LOCK_DIRNAME, LOCK_FILENAME)
}

function readHolder(p) {
  try {
    const raw = readFileSync(p, 'utf-8')
    const h = JSON.parse(raw)
    if (!h || typeof h !== 'object') return null
    return h
  } catch {
    return null // 空文件（创建与写入之间崩溃的残骸）或损坏 JSON → 按「持有者身份不明」处理
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM' // EPERM=活着但非本人所有；ESRCH=已死
  }
}

function writeHolder(p, holder) {
  const fd = openSync(p, 'w')
  try {
    writeFileSync(fd, JSON.stringify(holder), 'utf-8')
  } finally {
    closeSync(fd)
  }
}

/** 按计数递减释放（T37 必改2 统一释放面）：token 匹配才动（锁被偷走/换手绝不删别人的）；
 *  递减到 0 才 unlink——原始与重入共用同一语义，谁把 count 归 0 谁删锁文件，
 *  原始先释放不再无条件 unlink（在途重入仍受保护），重入 release 恒失配不递减的
 *  死代码缺陷随之消除。 */
function releaseCounted(p, token) {
  if (!existsSync(p)) return
  const h = readHolder(p)
  if (!h || h.token !== token) return
  const left = (Number(h.count) || 1) - 1
  if (left <= 0) unlinkSync(p)
  else writeHolder(p, { ...h, count: left })
}

/** 非阻塞获取（拒绝而非排队——验收 (d) 原文）。返回：
 *  - { ok: true, release }：已持有；release() 必须在 finally 调用（幂等）；
 *  - { ok: true, disabled: true }：开关关闭（no-op，release 为空函数）；
 *  - { ok: true, degraded: true, reason }：锁面内部错误 fail-open 放行（stderr 告警已在
 *    内部发出），degraded 供调用方在提示行中如实标注「本次未加锁」；
 *  - { ok: false, holder, message }：并发写冲突拒绝（message 含持有者信息与三条出路）。 */
export function acquireCwdWriteLock({ cwd, expert, readOnly = false, warn = (m) => console.warn(`[dsh-expert-orchestrator] ${m}`) } = {}) {
  if (!cwdLockEnabled()) return { ok: true, disabled: true, release: () => {} }
  if (readOnly) return { ok: true, readOnly: true, release: () => {} }
  const key = normalizeCwdAnchor(cwd)
  const p = lockPath(key)
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      mkdirSync(join(key, LOCK_DIRNAME), { recursive: true })
      fd = openSync(p, 'wx') // O_EXCL 独占创建=获取成功；已存在→EEXIST 走持有者裁决
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // 锁面自身故障：fail-open 放行 + stderr 告警（降级可见，绝不炸召唤主流程）
        warn(`per-cwd 写锁内部错误（本次召唤未加锁，fail-open）：${error?.message ?? error}`)
        return { ok: true, degraded: true, reason: String(error?.message ?? error), release: () => {} }
      }
      const holder = readHolder(p)
      if (!holder || typeof holder.pid !== 'number' || !pidAlive(holder.pid)) {
        // 崩溃残骸（持有者已死 / 身份不明）：偷锁自愈（一次），重试独占创建
        try { unlinkSync(p) } catch { /* 偷锁失败下一轮按冲突上报 */ }
        continue
      }
      if (holder.pid === process.pid && holder.expert === expert) {
        // 同进程同名专家重入：计数放行（同步读改写，进程内无竞态）。
        // T37 必改2：release 闭包捕获锁文件**原 token**——原实现误捕获本次新生成随机
        // token（从未写入锁文件），比对恒失配提前 return，count 永不递减成死代码。
        const originalToken = holder.token
        const count = (Number(holder.count) || 1) + 1
        try { writeHolder(p, { ...holder, count }) } catch { /* 计数失败仍放行（重入方向保守） */ }
        let released = false
        return {
          ok: true,
          reentrant: true,
          release: () => {
            if (released) return
            released = true
            try {
              releaseCounted(p, originalToken)
            } catch { /* 释放面故障留给崩溃自愈（ESRCH 偷锁）兜底 */ }
          },
        }
      }
      // 验收 (d)：同 cwd 并发写拒绝——报错含持有者信息 + 三条出路（crew 模板）
      const since = holder.startedAt ? new Date(holder.startedAt).toISOString() : '未知'
      return {
        ok: false,
        holder,
        message:
          `同 cwd 并发写被拒（per-cwd 写锁，拒绝而非排队）：${key} 当前由专家「${holder.expert ?? '未知'}」` +
          `持有（pid=${holder.pid ?? '?'}，since=${since}）。出路：① 等待该专家完成后再派发本任务；` +
          '② 取消本次委派；③ 本任务确为只读时在 summon 显式声明 readOnly=true' +
          '（排障可临时设 DSH_EXPERT_CWD_LOCK=0 关闭本门禁，用后恢复）。',
      }
    }
    // 独占创建成功：持有者经 fd 直写（不走路径重开——create-write 间隙若被并发方
    // 偷锁换手，路径重开会把新持有者的锁文件整个覆盖形成双持）；写后以 fstat(fd)
    // 比对路径 stat 的 inode 复验（fd 所指文件若已被 unlink 换手，inode 必失配），
    // 叠加 token 内容复验双保险，闭「写入前被并发方偷锁」的双持窗口。
    const holder = { token, pid: process.pid, expert: expert ?? '', cwd: key, startedAt: Date.now(), count: 1 }
    try {
      let fdIno = null
      try {
        writeFileSync(fd, JSON.stringify(holder), 'utf-8')
        fdIno = fstatSync(fd).ino
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
      let pathIno = null
      try { pathIno = statSync(p).ino } catch { /* 路径已被偷锁方 unlink 换手 */ }
      if (pathIno !== fdIno || readHolder(p)?.token !== token) { // 输给并发偷锁方：按未获取重试一轮
        continue
      }
    } catch (error) {
      warn(`per-cwd 写锁持有者信息写入失败（释放交由崩溃自愈，本次按已持有）：${error?.message ?? error}`)
    }
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        try {
          // T37 必改2：按 count 递减至 0 才 unlink（原实现无条件 unlink 忽略在途重入——
          // 同批双开同名专家时原始先完成即提前放锁，异名写型专家可趁隙并发）
          releaseCounted(p, token)
        } catch { /* 释放失败留给 ESRCH 偷锁自愈 */ }
      },
    }
  }
  // 两轮独占创建均输（极端竞态）：按冲突拒绝上报，不做第三轮（宁拒勿悬）
  const holder = readHolder(p)
  return {
    ok: false,
    holder,
    message:
      `同 cwd 并发写被拒（per-cwd 写锁，竞态两连败，拒绝而非排队）：${key}` +
      `当前持有者=${holder?.expert ?? '未知'}（pid=${holder?.pid ?? '?'}）。` +
      '出路：① 等待持有者完成；② 取消本次委派；③ 只读任务显式声明 readOnly=true。',
  }
}
