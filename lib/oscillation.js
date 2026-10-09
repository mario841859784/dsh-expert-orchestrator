// #22 之二：振荡检测（v2.8 M8-2 / WP-7 ④，T26）
//
// 参考实现：expert-team lib/loop-guard.js（调研 C-expert-team-swarm §2 门禁体系；借鉴结论
// 见 expert-team-research/C-expert-team-swarm.md 第 9 条）。对齐验收 (e)：**振荡 N 次来回后
// 告警**。本插件面振荡的形态是「委派目标来回横跳」：编排者在两个专家间反复交替派工
// （A→B→A→B→A…，典型成因是方案分歧未收敛就来回返工）——宿主 repeat-tool-reminder 只管
// 同参数重复调用，跨专家的方案横跳无人管（调研原文）。
//
// 与参考实现的刻意差异（验收口径对齐）：
// - expert-team 选 block 型（「振荡从来不是合法行为」）；本插件验收 (e) 原文是**告警**——
//   采用非阻断告警（提示行附 summon 结果尾部，与 auto-claim hint 同通道），编排者看得见、
//   流程不被工具擅断。回炉迭代（评审→修复→复审）在任务板面已有 REVIEW_ROUND_LIMIT/
//   REPAIR_RETRY_LIMIT 硬顶，本告警管的是任务板之外的自发交替派工。
// - 判据收窄到「同一对专家交替」（参考实现收窄到「同一文件」，本插件没有 per-file 写面）：
//   连续交替运行段（strict alternation run，序列中相邻两两不同且仅含两个名字）内的来回数
//   = floor((run 长度 - 1) / 2)——「来回」以回到出发专家计（A→B→A=1 次，A→B→A→B→A=2 次，
//   A→B→A→B→A→B→A=3 次；停在异侧的半程不折算完整来回），达到阈值 N（默认 3，
//   DSH_EXPERT_OSCILLATION_N 可覆盖）即告警。
// - 同一对专家只在当前交替段内告警一次（「同对只提醒一次」，参考实现教训：重复提醒是
//   噪音）；交替段被第三个名字打断后重臂（新段可再次告警）。
//
// 边界（如实声明）：状态为本进程内存态（registerExpertTools 每会话一份）——跨宿主进程的
// 交替派工不聚合；宿主重启即清零。判定只看派发顺序，不看任务内容（窄判据的取舍：误报
// 面=同一对专家的合法多轮协作，告警非阻断所以代价是提示行而非拦截）。
export function oscillationEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_OSCILLATION
  return !(flag === '0' || flag === '')
}

/** 阈值解析：DSH_EXPERT_OSCILLATION_N 十进制整数 ≥2；非法/未设置回默认 3。 */
export function oscillationThreshold(env = process.env) {
  const raw = env.DSH_EXPERT_OSCILLATION_N
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 2 ? n : 3
}

/** 来回数：run 为末尾连续交替段（长度 ≥2）；来回以回到出发专家计 = floor((段长-1)/2)。 */
export function oscillationRoundTrips(runLength) {
  return Math.floor((runLength - 1) / 2)
}

/** 计算以 seq 末尾结尾的连续交替段长度：从尾向前走，相邻不同名且全程只含两个名字。
 *  尾部不足两个不同名（全同名/空）→ 1/0（不构成交替）。导出供自测。 */
export function alternationRunLength(seq) {
  const s = seq ?? []
  const n = s.length
  if (n < 2) return n
  if (s[n - 1] === s[n - 2]) return 1
  const pair = new Set([s[n - 1], s[n - 2]])
  let run = 2
  for (let i = n - 3; i >= 0; i--) {
    if (!pair.has(s[i]) || s[i] === s[i + 1]) break
    run += 1
  }
  return run
}

/** 派发序列记录器（registerExpertTools 每会话一份；summon_expert 与 summon_experts 共用）。
 *  record(name) → 告警字符串 | null；内部维护序列与当前交替段的「已告警对」——段被打断
 *  即重臂（新段同对可再次告警），段内恒只告警一次。导出供自测。 */
export function createOscillationDetector({ threshold = 3 } = {}) {
  const seq = []
  let alertedPair = null
  return {
    record(name) {
      if (typeof name !== 'string' || !name) return null
      seq.push(name)
      if (seq.length > 64) seq.splice(0, seq.length - 64) // 上限防长会话无界增长
      const run = alternationRunLength(seq)
      if (run < 2) {
        alertedPair = null // 交替段结束（连续同名/空）：重臂
        return null
      }
      const names = [...new Set(seq.slice(-run))]
      if (names.length !== 2) {
        alertedPair = null
        return null
      }
      const key = [...names].sort().join('\u0000')
      const roundTrips = oscillationRoundTrips(run)
      if (roundTrips < threshold) {
        // 未达阈值：若当前段的对已与告警缓存不同（旧段被打断后的新段累积期）→ 重臂
        if (alertedPair !== null && alertedPair !== key) alertedPair = null
        return null
      }
      if (alertedPair === key) return null
      alertedPair = key
      return (
        `【振荡告警】检测到「${names[0]}」与「${names[1]}」之间已交替派工 ${roundTrips} 次来回` +
        `（阈值 ${threshold}；近 ${run} 次委派呈 A↔B 交替）——请核对任务分解：方案分歧应先收敛裁决` +
        '（评审/PM 检查点/用户裁决），而不是在两位专家间反复横跳返工。本告警不阻断派工。'
      )
    },
    /** 供测试重置内部状态。 */
    reset() {
      seq.length = 0
      alertedPair = null
    },
  }
}
