// 编排经济学 · 方向 2（v2.14 开发线）：token 估算 + 会话级召唤记账 + 预算熔断提示
//
// 依据 docs/research/orchestration-economics/00-overview.md §4 清单 #3/#8（effort 预算
// 下发的计量面 + 「命中率指标 + 预算熔断」）与 02-cache-cost-economics.md D5。设计映射
// 与诚实边界见 docs/internal/direction2-orchestration-economics.md。
//
// 定位与边界（如实声明）：
// - **估算≠计量**：宿主结算观察面（createSettlementWatcher）产出 {stopReason, output,
//   lastAssistantMessage}，无 token/usage 字段——真实 prompt_cache_hit/miss_tokens 在当前
//   宿主 seam 不可采集。本模块用字符启发式估算（标注「估算」）做规模对账与熔断提示，
//   不用于计费对账。**真实 usage 接入点**：宿主结算面出现 usage 字段时，在
//   runExpertOneShot/runExpertContinuable 的 result 消费缝读出并替换估算值（本文件
//   record 的 estTokens 换成 usage 实测值即可，记账/熔断结构不变）。
// - **熔断=提示级**：沿振荡告警（lib/oscillation.js）先例——超阈值只附【成本】提示行，
//   绝不阻断派工；阻断型门禁的「默认关闭、显式开启」纪律同样适用（DSH_EXPERT_TOKEN_
//   BUDGET 未设置/'0'/空串时零提示行，summon 输出逐字节不变）。
// - **记账纯内存**：每会话（registerExpertTools 实例）一份，条目封顶防无界增长，零 I/O
//   零子进程——路由/调度层自身必须轻量（清单 #11：编排层成本不可忽略）。
import { msg } from './messages.js'

/** token 预算开关与阈值解析（沿 DSH_EXPERT_* 惯例 + taskboard.py budget_thresholds
 *  的 fail-open 先例）。返回阈值（单位：token）或 null（禁用）：
 *  - 未设置 / '' / '0' → null（关闭，零提示零变化）；
 *  - 合法正数（千 token，支持小数，如 '500' → 500000、'0.5' → 500000）→ 阈值；
 *  - 非法值 → null + stderr 告警（宁降级可见勿误启用）。导出供自测。 */
export function tokenBudgetTokens(env = process.env, warn = (m) => console.warn(`[dsh-expert-orchestrator] ${m}`)) {
  const flag = env.DSH_EXPERT_TOKEN_BUDGET
  if (flag === undefined || flag === '' || flag === '0') return null
  const n = Number(flag)
  if (!Number.isFinite(n) || n <= 0) {
    warn(`DSH_EXPERT_TOKEN_BUDGET 非法（${JSON.stringify(flag)}，须为正数，单位千 token）——成本熔断提示整体禁用`)
    return null
  }
  return n * 1000
}

/** 字符启发式 token 估算（诚实边界见文件头）：CJK 区码点按 0.75 token/字、其余按
 *  0.25 token/字符（4 字符≈1 token 的 ASCII 经验值），向上取整。只做规模对账，
 *  不做计费口径。导出供自测。 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    // CJK 统一表意文字 + 扩展 A + 兼容表意：中文字符是估算的主要构成面，
    // 其余（ASCII/标点/空白/emoji 代理对）一律按 other 计。
    const code = ch.codePointAt(0)
    const isCjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)
    if (isCjk) cjk++
    else other++
  }
  return Math.ceil(cjk * 0.75 + other * 0.25)
}

/** 会话级召唤记账（纯内存）。record 在召唤边界取**实际文本**当场估算（任务书+
 *  回包，CJK 感知口径与 estimateTokens 一致），条目只存规模与估算值，不留正文
 *  （防长会话内存膨胀）。maxEntries 封顶：超限丢最旧。导出供自测。 */
export function createCostLedger({ maxEntries = 500 } = {}) {
  const entries = []
  return {
    record(entry) {
      const taskText = typeof entry?.taskText === 'string' ? entry.taskText : ''
      const answerText = typeof entry?.answerText === 'string' ? entry.answerText : ''
      entries.push({
        expert: typeof entry?.expert === 'string' ? entry.expert : '',
        model: typeof entry?.model === 'string' ? entry.model : '',
        ok: entry?.ok === true,
        taskChars: [...taskText].length,
        answerChars: [...answerText].length,
        estTokens: estimateTokens(taskText) + estimateTokens(answerText),
      })
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
    },
    /** 累计面：{summons, okCount, failCount, estTokens}——estTokens 为封顶窗口内
     *  全条目（任务书+回包）估算 token 合计。 */
    totals() {
      let estTokens = 0
      let okCount = 0
      for (const e of entries) {
        estTokens += e.estTokens
        if (e.ok) okCount++
      }
      return { summons: entries.length, okCount, failCount: entries.length - okCount, estTokens }
    },
  }
}

/** 规模标签格式化：≥1000 → 一位小数 K；<1000 → 原始 token 数带单位（避免小值
 *  被取整成「0K」的误导显示）。导出供自测。 */
export function formatTokenScale(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 tok'
  return n >= 1000 ? `${Math.round(n / 100) / 10}K` : `${n} tok`
}

/** 熔断提示行（纯函数，导出供自测）：累计估算 ≥ 阈值 → 【成本】收敛建议行（沿
 *  budget.wrapup 文案语义：提示收敛/降档，不阻断）；未超 → ''（零变化）。
 *  lang 口径与 messages 字典一致（仅精确 'en' 生效英文）。 */
export function costBudgetHint(totals, thresholdTokens, lang = 'zh') {
  if (!thresholdTokens || thresholdTokens <= 0) return ''
  if (!totals || totals.estTokens < thresholdTokens) return ''
  return msg('cost.budgetExceeded', lang, { used: formatTokenScale(totals.estTokens), budget: formatTokenScale(thresholdTokens) })
}
