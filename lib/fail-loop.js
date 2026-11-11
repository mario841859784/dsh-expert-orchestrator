// 方向 3 之二：召唤失败循环告警（dev/orchestration-economics-345）
//
// 循环失控四轴的第四轴（另三轴：watchdog 时间窗 / #16 工具调用硬预算 / A↔B 振荡告警
// lib/oscillation.js——各管一个轴）。本模块管「同一专家连续召唤失败」：编排者反复硬试
// 同一失败调用（工具快照陈旧/环境损坏/名字拼错）是最常见的无意义 token 消耗模式，
// SKILL.md §3 既有「不要反复硬试同一调用」纪律，本检测器把它变成确定性告警。
//
// 与振荡告警的分工：oscillation 检测「派发目标来回横跳」（A→B→A↔B），本模块检测
// 「同一点反复坠落」（A→A→A 失败）——两轴独立计数，互不重臂。
//
// 与 taskboard.py fail-loop 升级（同方向 Part 1）的分工：后者管任务板面的连续失败
// （fail→retry 循环，达限自动 escalated 执法 opt-in）；本模块管召唤通道本身的失败
// （召唤失败=专家根本没跑起来，无任务板写面可言），只做告警不阻断——升级处置权在
// 编排者（换专家/换通道/上报用户）。
//
// 边界（如实声明）：状态为本进程内存态（registerExpertTools 每会话一份）——跨宿主
// 进程不聚合，宿主重启即清零；判定只看召唤成败序列，不看失败原因文本。
import { msg } from './messages.js'

/** 排障开关（沿 DSH_EXPERT_* 惯例）：'0' 或空串整体关闭（召唤失败不再累计告警）。 */
export function summonFailLoopEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_SUMMON_FAILLOOP
  return !(flag === '0' || flag === '')
}

/** 阈值解析：DSH_EXPERT_SUMMON_FAILLOOP_N 十进制整数 ≥2；非法/未设置回默认 3
 *  （沿 oscillationThreshold 口径）。 */
export function summonFailLoopThreshold(env = process.env) {
  const raw = env.DSH_EXPERT_SUMMON_FAILLOOP_N
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 2 ? n : 3
}

/** 召唤失败循环检测器（registerExpertTools 每会话一份；summon_expert 与
 *  summon_experts 共用同一实例——批量项失败同样计入）。
 *  - recordSuccess(name)：成功即清零该专家的连续失败计数（恢复=循环打断）。
 *  - recordFailure(name, lang) → 告警字符串 | null：连续失败计数 +1；达到阈值后
 *    **每次**失败都返回告警行（每次都是新的事件，重复提醒成本≈0，比静默好）。
 *  导出供自测。 */
export function createSummonFailLoopDetector({ threshold = 3 } = {}) {
  const streaks = new Map()
  return {
    recordSuccess(name) {
      if (typeof name === 'string' && name) streaks.delete(name)
    },
    recordFailure(name, lang = 'zh') {
      if (typeof name !== 'string' || !name) return null
      const count = (streaks.get(name) ?? 0) + 1
      streaks.set(name, count)
      if (count < threshold) return null
      return msg('failloop.summon', lang, { name, count, threshold })
    },
    /** 供测试重置内部状态。 */
    reset() {
      streaks.clear()
    },
  }
}
