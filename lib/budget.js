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
export function budgetMaybeEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_TOOL_BUDGET
  return !(flag === undefined || flag === '' || flag === '0')
}

/** budget --json 信封 → summon 提示行（纯函数，导出供自测）。
 *  信封形态（v2.8 S1 契约，报告型命令 data 恒非空）：{ok:true, cmd:'budget',
 *  data:{task, budget:{enabled, thresholds:{alarm,'wrap-up',interrupt}, epoch, stamped, budgets:[{owner,count,tier}]}}}。
 *  未启用/不可解析/owner 无归因计数/未达任何档位 → ''（零变化）；达档按 alarm/wrap-up/
 *  interrupt 三档给可行动文案（档位语义与 taskboard.py 固定档位一一对应）。 */
export function budgetNoticeFromEnvelope(envelope, owner) {
  if (!envelope || typeof envelope !== 'object' || envelope.ok !== true) return ''
  const budget = envelope.data?.budget
  if (!budget || budget.enabled !== true || !Array.isArray(budget.budgets)) return ''
  const row = budget.budgets.find((b) => b && b.owner === owner && b.tier)
  if (!row) return ''
  const th = budget.thresholds ?? {}
  const who = row.owner
  if (row.tier === 'interrupt') {
    return (`【预算】${who} 在本任务的执行面调用已达硬预算（${row.count}/${th.interrupt ?? '?'}，interrupt 档）`
      + '——推进类调用（claim/progress/heartbeat/own）会被拒；交付出口 done/fail 仍开放。'
      + '请让该专家立即收尾交付，或改派他人 / budget --reset 显式重置（编排者裁决）')
  }
  if (row.tier === 'wrap-up') {
    return (`【预算】${who} 在本任务已计入 ${row.count}/${th['wrap-up'] ?? '?'} 次执行面调用（wrap-up 收尾档）`
      + '——任务书须要求立即收敛交付，勿再展开新阶段')
  }
  return `【预算】${who} 在本任务已计入 ${row.count}/${th.alarm ?? '?'} 次执行面调用（alarm 告警档）——注意调用开销，保持收敛`
}
