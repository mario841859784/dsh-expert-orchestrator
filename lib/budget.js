// #16 之一：per-(任务,专家) 工具调用硬预算——JS 消费面（v2.8 M8-2 / WP-7 ①，T27）
//
// 执法面（计数/档位/拒绝）唯一落在 taskboard.py（专家经 bash 直呼 taskboard.py，JS lib
// 拦不到也不该拦——专家子代理的 taskboard 调用不经过宿主进程）；本模块只做消费面翻译：
// 把 `taskboard.py --json budget <id>` 结构化信封翻成 summon 提示行，让编排者在派发时
// 看见任务已处的预算档位（wrap-up/interrupt 档语义的编排侧落点：续派任务书自动附
// 「立即收敛」指令，interrupt 档明确告知续派 claim 会被拒）。这也是 #20（idle-edge 自动
// 续领）的复用面：续领路径判预算状态走同一信封，不必复制任何计数/阈值语义。
//
// 配置快路径：本模块只判总开关（跳过无谓子进程），三档阈值语义唯一权威在 taskboard.py
// （budget_thresholds）——JS 侧绝不重复解析阈值，两处解析必然漂移。开关语义与
// taskboard.py budget_enabled 逐字一致：DSH_EXPERT_TOOL_BUDGET 置 '0'/''/未设置 = 关。
import { msg } from './messages.js'

export function budgetMaybeEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_TOOL_BUDGET
  return !(flag === undefined || flag === '' || flag === '0')
}

/** budget --json 信封 → summon 提示行（纯函数，导出供自测）。
 *  信封形态（v2.8 S1 契约，报告型命令 data 恒非空）：{ok:true, cmd:'budget',
 *  data:{task, budget:{enabled, thresholds:{alarm,'wrap-up',interrupt}, epoch, stamped, budgets:[{owner,count,tier}]}}}。
 *  未启用/不可解析/owner 无归因计数/未达任何档位 → ''（零变化）；达档按 alarm/wrap-up/
 *  interrupt 三档给可行动文案（档位语义与 taskboard.py 固定档位一一对应）。
 *  T9（lib/messages 文案目录化）：三档文案收口进字典；lang 仅精确 'en' 生效英文、
 *  非法/缺失一律 zh（与 resolveReplyLanguage 降级口径一致）——zh 路径逐字节一致是
 *  硬契约，缺省 'zh' 保证既有调用点（含全部既有测试）行为零变化。 */
export function budgetNoticeFromEnvelope(envelope, owner, lang = 'zh') {
  if (!envelope || typeof envelope !== 'object' || envelope.ok !== true) return ''
  const budget = envelope.data?.budget
  if (!budget || budget.enabled !== true || !Array.isArray(budget.budgets)) return ''
  const row = budget.budgets.find((b) => b && b.owner === owner && b.tier)
  if (!row) return ''
  const th = budget.thresholds ?? {}
  const who = row.owner
  if (row.tier === 'interrupt') {
    return msg('budget.interrupt', lang, { who, count: row.count, threshold: th.interrupt ?? '?' })
  }
  if (row.tier === 'wrap-up') {
    return msg('budget.wrapup', lang, { who, count: row.count, threshold: th['wrap-up'] ?? '?' })
  }
  return msg('budget.alarm', lang, { who, count: row.count, threshold: th.alarm ?? '?' })
}
