// #20 idle-edge 自动续领（v2.8 M8-2 / WP-7 ②，T28）
//
// 编排者空闲且板上无开放执行（无 running 任务）时，自动领取就绪任务——自调度最后落地
// （#21 origin chain 递归防护与 #16 硬预算守卫已先在位）。设计（依据 v2.6-plan WP-7 ②
// 原文「空闲+无开放 attempt 自动领取就绪任务」与 T28 任务书）：
//
// - 触发信号（空闲边沿）：编排者会话内「最后一位在途专家执行收尾」——lib/tools.js
//   runExpert 在受保护段入口对在途专家执行计数，成功收尾且计数归 0 时做一次续领扫描
//   （失败边沿不扫描：宁漏勿错）。这是插件侧唯一可观测的「编排者空闲」信号：summon
//   同步等结果，最后一位专家收尾即编排者无在途执行。
// - 板面条件（无开放执行）：`list --json` 全量任务里存在任何 running 任务即整轮不动
//   ——有开放执行（含开放 attempt 的认领）说明仍有在途工作，自动领取可能与之冲突；
//   只认领 status=ready 且 owner 为空的条目（非 ready/已有 owner 一律不动，负向用例
//   见 test/tools.selftest.mjs T28 段）。
// - 领取面（不绕板）：复用 lib/tools.js autoClaimOne 的既有 claim 路径——show 读实时
//   状态复判 → claim（带 --expected-revision CAS）→ 事件流留痕；与派工即回写
//   auto-claim（WP-4a）同一执行面、同一代际语义（lib 侧认领不建派工代际，代际仍由
//   编排者经 claim --attempt / reassign 建立）。绝不直改板文件。
// - 领取≠召唤（失控面红线）：自动续领只做板面认领（owner=编排者），绝不自动 spawn/
//   召唤专家——召唤仍由编排者/用户驱动。owner=编排者的语义是「任务被编排者领取、
//   等待派工」：板从「不可见的停摆」变成「watchdog 可探测的在领态」——续领后未及时
//   派工的任务由 watchdog 时间面接管（nudge→reclaim 回 ready，reclaim 清 owner），
//   回收后的再次续领受 #16 预算累计兜底（claim 计数跨 reclaim 累计，达 interrupt 档
//   当场被拒，budget --reset 是唯一放行出口）——不会无限空转。
// - 开关（用户既定裁决：默认关闭、显式开启，与 hook 门禁同哲学）：DSH_EXPERT_IDLE_RECLAIM
//   未设置/'0'/空串=关闭（写路径零变化，连板读取都不发生），置其他值=开启。命名沿
//   DSH_EXPERT_* 惯例；关闭时 summon 行为与开启前逐字节一致。
//
// 边界（如实声明）：「空闲」的观测面是本插件的在途专家执行计数——编排者用 subagent
// 等其他通道并行跑任务时本插件不可见，但板面「无 running 任务」条件仍兜底（其他通道
// 在做板面任务时板上必有 running 条目，扫描整轮不动）；多会话共享同一板时同理由板面
// 条件互斥，不依赖会话间通信。

/** 自动续领的认领方身份（owner=编排者）：领取是编排者的板面动作。固定常量而非配置
 *  ——避免与花名册专家名冲突（花名册无「编排者」），协议文本（SKILL.md §3）按此名
 *  成文；实际执行者与 owner 的同步仍由编排者按协议用 reassign/纠正完成。 */
export const IDLE_RECLAIM_OWNER = '编排者'

/** 单次空闲边沿扫描的续领条目上限：与 WP-4a auto-claim 的 AUTOCLAIM_MAX_IDS=8 同档
 *  （宁漏勿错，超出取前 8 并在提示行说明截断）。 */
export const IDLE_RECLAIM_MAX_TASKS = 8

/** 开关（opt-in，默认关闭）：DSH_EXPERT_IDLE_RECLAIM 置 '0'/''/未设置 = 关；
 *  置任何其他值 = 开。语义与 lib/budget.js budgetMaybeEnabled（#16）逐字同构——
 *  两处都是「破坏性/行为性默认不由工具单方面引入」的 opt-in 惯例。导出供自测。 */
export function idleReclaimEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_IDLE_RECLAIM
  return !(flag === undefined || flag === '' || flag === '0')
}

/** 从 `list --json` 信封的 tasks 数组选出本次可续领的条目（纯函数，导出供自测）。
 *  tasks：taskboard.py 折叠视图任务对象数组（含 id/status/owner 字段；owner 缺失或
 *  空串均视为无 owner）。判定：
 *  - 板上存在任何 status=running 的任务 → { ok:false, reason:'open_attempt' }
 *    ——有开放执行（开放 attempt 的认领或无代际的认领）整轮不动（负向条件①）；
 *  - 否则取 status=ready 且无 owner 的条目 id（保持 list 的 id 升序，确定性），
 *    截到 max 个，truncated 标记是否发生截断。
 *  非数组/条目形状非法按空处理（fail-open，与信封解析失败同语义）。 */
export function selectIdleReclaimTasks(tasks, { max = IDLE_RECLAIM_MAX_TASKS } = {}) {
  const list = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id)
  if (list.some((t) => t.status === 'running')) return { ok: false, reason: 'open_attempt' }
  const ids = list
    .filter((t) => t.status === 'ready' && !t.owner)
    .map((t) => t.id)
  return { ok: true, ids: ids.slice(0, max), truncated: ids.length > max, total: ids.length }
}
