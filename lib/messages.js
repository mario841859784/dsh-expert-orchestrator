// T4v2（gh-issues T9）：lib 注入文案目录化——人读 + 模型可读协议行 zh/en 字典。
//
// 定位与边界：
// - 语言生效面 = lib 注入的全部协议行 + 人读提示行（用户裁决 2026-10-08）。zh 路径
//   输出与收口前文本逐字节一致（硬契约：effort-preflight model 降级告警等既有
//   行为面测试按 zh 字面断言，不得漂移）。
// - 【】tag 与既有 console 前缀（[dsh-expert-orchestrator]）保持原字面不进字典
//   （协议标记稳定性：模型按行文行动、watchdog adopt 等机制依赖稳定形态）；
//   tag 之后的正文切换语言。
// - lang 口径与 resolveReplyLanguage 降级一致（lib/tools.js）：仅精确 'en' 生效
//   英文，非法/缺失/其余值一律按 zh，绝不 throw（未知 key 属编程错误，throw 交
//   由测试拦截——所有调用点 key 均为字面量）。
// - en 语料撰写原则：模型可读协议行的 en 版与 zh 语义精确对齐（模型按行文行动：
//   跳过/不覆盖/不阻断/手工 claim 等行动指令逐一保留），人读行 en 亦可读。

/** 语言归一：仅精确 'en' 生效英文；非法/缺失一律 zh（与 resolveReplyLanguage
 *  的降级口径一致）。导出供自测与调用方复用。 */
export function normalizeReplyLang(lang) {
  return lang === 'en' ? 'en' : 'zh'
}

// 字典条目值两种形态：字符串（无参数）或 (params) => string（有插值）。zh 值
// 一律逐字节复制自收口前各模块的模板字面量（含全角标点与空格），是逐字节一致
// 契约的唯一事实源；调用点不得再手写同文案。
const DICT = {
  // ── 经验提示（lib/tools.js withLessonHint：任务书尾部头行）────────────────
  'lesson.header': {
    zh: (p) => `【经验提示｜来自 ${p.name ?? '专家'} 历次任务沉淀】`,
    en: (p) => `【经验提示｜from ${p.name ?? 'expert'}'s past-task lessons】`,
  },

  // ── auto-claim / 自动续领（lib/tools.js autoClaimOne：动态 tag 复用同一执行
  //    面，tag 由调用方传 'auto-claim' | '自动续领'，保持原字面不译）──────────
  'claim.preflightTimeout': {
    zh: (p) => `【${p.tag}】${p.id} 认领前置检查超时（taskboard.py ${p.timeoutMs}ms 无响应），跳过认领`,
    en: (p) => `【${p.tag}】${p.id} claim preflight check timed out (taskboard.py no response within ${p.timeoutMs}ms); claim skipped`,
  },
  'claim.notOnBoard': {
    zh: (p) => `【${p.tag}】${p.id} 不在任务板或板不可读，跳过认领`,
    en: (p) => `【${p.tag}】${p.id} not on the taskboard or board unreadable; claim skipped`,
  },
  'claim.contractViolation': {
    zh: (p) => `【${p.tag}】${p.id} 任务板回执契约违规：${p.hint}，跳过认领`,
    en: (p) => `【${p.tag}】${p.id} taskboard receipt contract violation: ${p.hint}; claim skipped`,
  },
  'claim.unparseable': {
    zh: (p) => `【${p.tag}】${p.id} 任务板输出无法解析，跳过认领`,
    en: (p) => `【${p.tag}】${p.id} taskboard output could not be parsed; claim skipped`,
  },
  'claim.wrongStatus': {
    zh: (p) => `【${p.tag}】${p.id} 状态为 ${p.status}${p.owner ? `（owner=${p.owner}）` : ''}，跳过认领`,
    en: (p) => `【${p.tag}】${p.id} status is ${p.status}${p.owner ? ` (owner=${p.owner})` : ''}; claim skipped`,
  },
  'claim.taken': {
    zh: (p) => `【${p.tag}】${p.id} 已有 owner=${p.owner}，不覆盖，跳过认领`,
    en: (p) => `【${p.tag}】${p.id} already has owner=${p.owner}; not overwriting, claim skipped`,
  },
  'claim.writeTimeout': {
    zh: (p) => `【${p.tag}】${p.id} 认领写入超时（taskboard.py ${p.timeoutMs}ms 无响应；条目可能已/未被认领，请按板现状处置）`,
    en: (p) => `【${p.tag}】${p.id} claim write timed out (taskboard.py no response within ${p.timeoutMs}ms; the entry may or may not have been claimed — handle it per the current board state)`,
  },
  'claim.failed': {
    zh: (p) => `【${p.tag}】${p.id} 认领失败（已忽略，不阻塞派工）：${p.why}`,
    en: (p) => `【${p.tag}】${p.id} claim failed (ignored; does not block dispatch): ${p.why}`,
  },
  'claim.ok': {
    zh: (p) => `【${p.tag}】${p.id} 已自动认领（owner=${p.owner}，板=${p.board}）`,
    en: (p) => `【${p.tag}】${p.id} auto-claimed (owner=${p.owner}, board=${p.board})`,
  },

  // ── auto-claim 入口（lib/tools.js autoClaimSummonedTasks）──────────────────
  'autoclaim.skipLocate': {
    zh: (p) => `【auto-claim 跳过】${p.reason}；任务 ${p.ids} 未自动认领，请按协议手工 claim`,
    en: (p) => `【auto-claim 跳过】${p.reason}; tasks ${p.ids} were not auto-claimed — claim them manually per the protocol`,
  },
  'autoclaim.exception': {
    zh: (p) => `【auto-claim】${p.id} 认领异常（已忽略，不阻塞派工）：${p.message}`,
    en: (p) => `【auto-claim】${p.id} claim error (ignored; does not block dispatch): ${p.message}`,
  },
  'autoclaim.truncated': {
    zh: (p) => `【auto-claim】任务 id 共 ${p.total} 个，超过上限 ${p.max}，仅认领前 ${p.max} 个（${p.ids}），其余请按协议手工 claim；${p.joined}`,
    en: (p) => `【auto-claim】${p.total} task ids in total, exceeding the cap of ${p.max}; only the first ${p.max} will be claimed (${p.ids}) — claim the rest manually per the protocol; ${p.joined}`,
  },

  // ── 预算（lib/budget.js budgetNoticeFromEnvelope 三档 + lib/tools.js 契约违规行）──
  'budget.contractViolation': {
    zh: (p) => `【预算】${p.id} 任务板回执契约违规：${p.hint}`,
    en: (p) => `【预算】${p.id} taskboard receipt contract violation: ${p.hint}`,
  },
  'budget.interrupt': {
    zh: (p) => `【预算】${p.who} 在本任务的执行面调用已达硬预算（${p.count}/${p.threshold}，interrupt 档）——推进类调用（claim/progress/heartbeat/own）会被拒；交付出口 done/fail 仍开放。请让该专家立即收尾交付，或改派他人 / budget --reset 显式重置（编排者裁决）`,
    en: (p) => `【预算】${p.who} has reached the hard tool-call budget on this task (${p.count}/${p.threshold}, interrupt tier) — advancing calls (claim/progress/heartbeat/own) will be rejected; the delivery exits done/fail remain open. Have this expert wrap up and deliver immediately, or reassign the task / reset explicitly via budget --reset (orchestrator's call)`,
  },
  'budget.wrapup': {
    zh: (p) => `【预算】${p.who} 在本任务已计入 ${p.count}/${p.threshold} 次执行面调用（wrap-up 收尾档）——任务书须要求立即收敛交付，勿再展开新阶段`,
    en: (p) => `【预算】${p.who} has used ${p.count}/${p.threshold} tool calls on this task (wrap-up tier) — the task brief must require immediate convergence and delivery; do not open new phases`,
  },
  'budget.alarm': {
    zh: (p) => `【预算】${p.who} 在本任务已计入 ${p.count}/${p.threshold} 次执行面调用（alarm 告警档）——注意调用开销，保持收敛`,
    en: (p) => `【预算】${p.who} has used ${p.count}/${p.threshold} tool calls on this task (alarm tier) — mind the call overhead and keep converging`,
  },

  // ── 振荡告警（lib/oscillation.js createOscillationDetector.record）────────
  'oscillation.warning': {
    zh: (p) => `【振荡告警】检测到「${p.a}」与「${p.b}」之间已交替派工 ${p.roundTrips} 次来回（阈值 ${p.threshold}；近 ${p.run} 次委派呈 A↔B 交替）——请核对任务分解：方案分歧应先收敛裁决（评审/PM 检查点/用户裁决），而不是在两位专家间反复横跳返工。本告警不阻断派工。`,
    en: (p) => `【振荡告警】Detected ${p.roundTrips} round-trips of alternating dispatch between "${p.a}" and "${p.b}" (threshold ${p.threshold}; the last ${p.run} delegations alternate A↔B) — re-check the task decomposition: plan disagreements should be converged and adjudicated first (review / PM checkpoint / user ruling), not bounced back and forth between two experts. This warning does not block dispatch.`,
  },

  // ── 自动续领（lib/tools.js idleReclaimSweep 专属行；claim.* 复用行见上）────
  'reclaim.contractViolation': {
    zh: (p) => `【自动续领】任务板回执契约违规：${p.hint}，本轮跳过`,
    en: (p) => `【自动续领】Taskboard receipt contract violation: ${p.hint}; this round is skipped`,
  },
  'reclaim.writeTimeout': {
    zh: (p) => `【自动续领】认领写入超时（taskboard.py ${p.timeoutMs}ms 无响应；条目可能已/未被认领，请按板现状处置）`,
    en: (p) => `【自动续领】Claim write timed out (taskboard.py gave no response within ${p.timeoutMs}ms; entries may or may not have been claimed — dispose according to the current board state)`,
  },
  'reclaim.boardNotIdle': {
    zh: () => '【自动续领】板面已有开放执行（并发认领先行），本轮整轮跳过：board_not_idle',
    en: () => '【自动续领】The board already has open executions (a concurrent claim won the race); this entire round is skipped: board_not_idle',
  },
  'reclaim.budgetInterrupted': {
    zh: (p) => `【自动续领】${p.task} 认领失败（已忽略，不阻塞派工）：budget_interrupted`,
    en: (p) => `【自动续领】${p.task} claim failed (ignored, dispatch is not blocked): budget_interrupted`,
  },
  'reclaim.noopSkip': {
    zh: (p) => `【自动续领】${p.id} ${p.reason}，跳过认领`,
    en: (p) => `【自动续领】${p.id} ${p.reason}; claim skipped`,
  },
  'reclaim.stateChanged': {
    zh: () => '状态已变化',
    en: () => 'state has changed',
  },
  'reclaim.failed': {
    zh: (p) => `【自动续领】认领失败（已忽略，不阻塞派工）：${p.why}`,
    en: (p) => `【自动续领】Claim failed (ignored, dispatch is not blocked): ${p.why}`,
  },
  'reclaim.claimed': {
    zh: (p) => `【自动续领】${p.id} 已自动认领（owner=${p.owner}，板=${p.board}）`,
    en: (p) => `【自动续领】${p.id} auto-claimed (owner=${p.owner}, board=${p.board})`,
  },
  'reclaim.truncated': {
    zh: (p) => `【自动续领】就绪任务共 ${p.total} 个，超过上限 ${p.max}，仅续领前 ${p.max} 个（${p.ids}），其余请按协议手工 claim；${p.joined}`,
    en: (p) => `【自动续领】${p.total} ready tasks in total, exceeding the cap of ${p.max}; only the first ${p.max} are resumed (${p.ids}); for the rest, claim manually per the protocol; ${p.joined}`,
  },

  // ── 断点续跑（lib/tools.js buildResumePrompt + 续跑 answer 尾行）────────────
  'resume.header': {
    zh: () => '【断点续跑】上一次执行中断，宿主已按持久会话恢复本会话——这是恰好一次的续跑 turn：从中断点继续完成剩余工作，不要重做已完成阶段，完成后正常汇报。',
    en: () => '【断点续跑】The previous execution was interrupted and the host has restored this session from the persistent session — this is the exactly-one resume turn: continue the remaining work from the interruption point, do not redo completed phases, and report normally when done.',
  },
  'resume.progressHeader': {
    zh: () => '已完成进度清单（断点数据，勿重做）：',
    en: () => 'Completed-progress checklist (breakpoint data, do not redo):',
  },
  'resume.progressEmpty': {
    zh: () => '已完成进度清单：无（中断前未落检查点也未汇报）——先按任务板 progress 落一个检查点再继续，禁止无检查点盲续。',
    en: () => 'Completed-progress checklist: none (no checkpoint or report before the interruption) — first write a checkpoint via taskboard progress before continuing; blindly resuming without a checkpoint is forbidden.',
  },
  'resume.truncated': {
    zh: () => '- （更多断点数据超出预算已截断）',
    en: () => '- (more breakpoint data truncated beyond budget)',
  },
  'resume.expertTail': {
    zh: (p) => `（续跑专家：${p.name}）`,
    en: (p) => `(resumed expert: ${p.name})`,
  },
  'resume.answerSuffix': {
    zh: (p) => `【断点续跑】首轮中断（stopReason=${p.reason}），已按持久会话恢复并完成恰好 1 个续跑 turn`,
    en: (p) => `【断点续跑】First turn interrupted (stopReason=${p.reason}); restored from the persistent session and completed exactly 1 resume turn`,
  },

  // ── effort 预检降级告警（lib/effort-preflight.js：warnings + answerHints 双通道）──
  // zh 行为 model 降级告警文本有逐字节契约测试（T15 基线），一字不得差。
  'effort.modelDegraded': {
    zh: (p) => `专家档案 model=${p.model} 未生效：provider "${p.provider}" 未声明 agentOptions 能力（旧代宿主，降级可见）`,
    en: (p) => `Expert profile model=${p.model} not applied: provider "${p.provider}" does not declare the agentOptions capability (legacy host; degraded but visible)`,
  },
  'effort.effortDegraded': {
    zh: (p) => `专家档案 effort=${p.effort} 未生效（effort 预检）：provider "${p.provider}" 未声明 agentOptions 能力（旧代宿主，降级可见）`,
    en: (p) => `Expert profile effort=${p.effort} not applied (effort preflight): provider "${p.provider}" does not declare the agentOptions capability (legacy host; degraded but visible)`,
  },

  // ── per-cwd 写锁降级（lib/tools.js runExpert 提示行拼装）──────────────────
  'lock.degraded': {
    zh: () => '【per-cwd 写锁降级】本次召唤未加锁（锁面内部错误，fail-open 可见）',
    en: () => '【per-cwd 写锁降级】This summon ran without a lock (internal lock-layer error; fail-open and visible)',
  },
}

/** 字典取文（纯函数）：msg(key, lang, params)。lang 经 normalizeReplyLang 归一
 *  （非法/缺失一律 zh）；未知 key 视为编程错误 throw（所有调用点 key 均为字面
 *  量，由测试全量覆盖拦截）。导出供各 lib 模块与自测。 */
export function msg(key, lang, params = {}) {
  const entry = DICT[key]
  if (!entry) throw new Error(`[dsh-expert-orchestrator] messages: unknown key "${key}"`)
  const text = entry[normalizeReplyLang(lang)]
  if (typeof text !== 'function' && typeof text !== 'string') {
    throw new Error(`[dsh-expert-orchestrator] messages: key "${key}" missing ${normalizeReplyLang(lang)} entry`)
  }
  return typeof text === 'function' ? text(params ?? {}) : text
}

/** 内部自检面（导出供自测）：全量 key 清单与 zh/en 双语完整性断言所需。 */
export function messageKeys() {
  return Object.keys(DICT).sort()
}
