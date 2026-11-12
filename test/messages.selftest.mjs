// test/messages.selftest.mjs — T4v2（gh-issues T9）lib 注入文案目录化自测
// （node:test，零依赖）。覆盖任务书验收：
//   ① zh 逐字节一致：lib/messages.js 字典 zh 值对照收口前各模块模板字面量
//      （HEAD=a1e46b4 原文逐字复制）断言——硬契约，含 effort model 降级告警；
//   ② lang 归一：仅精确 'en' 生效英文，非法/缺失（'EN'/'zh-Hans'/undefined/''）
//      一律降级 zh（与 resolveReplyLanguage 降级口径一致），绝不 throw；
//   ③ en 语料：全量 key 双语完整性 + en 输出英文且【】tag 保持中文原字面；
//   ④ producer 级 lang 参数：withLessonHint / buildResumePrompt /
//      preflightEffort / budgetNoticeFromEnvelope / createOscillationDetector /
//      autoClaimSummonedTasks（skipLocate 路径，tmp cwd 无板）en 生效、缺省 zh；
//   ⑤ 未知 key throw（编程错误拦截）。
// en 语料覆盖放本文件（prompt-corpus.selftest 覆盖的是 experts/*.md 语料文件，
// 与 lib 消息文案无关——已在交付摘要声明）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { msg, messageKeys, normalizeReplyLang } from '../lib/messages.js'
import { withLessonHint, buildResumePrompt, autoClaimSummonedTasks } from '../lib/tools.js'
import { preflightEffort } from '../lib/effort-preflight.js'
import { budgetNoticeFromEnvelope } from '../lib/budget.js'
import { createOscillationDetector } from '../lib/oscillation.js'

// ---------- ① zh 逐字节一致（对照 HEAD=a1e46b4 收口前模板字面量）----------

test('T9 ① zh 逐字节：经验提示头行（含 expertName 缺省兜底「专家」）', () => {
  assert.equal(msg('lesson.header', 'zh', { name: '后端工程师' }), '【经验提示｜来自 后端工程师 历次任务沉淀】')
  assert.equal(msg('lesson.header', 'zh', {}), '【经验提示｜来自 专家 历次任务沉淀】')
  // withLessonHint 整行（原实现：`${taskText}\n\n头行\n${lesson}`）
  assert.equal(
    withLessonHint('做 T9', '后端工程师', '- 第一课', 'zh'),
    '做 T9\n\n【经验提示｜来自 后端工程师 历次任务沉淀】\n- 第一课',
  )
  assert.equal(withLessonHint('做 T9', undefined, '- 第一课'), '做 T9\n\n【经验提示｜来自 专家 历次任务沉淀】\n- 第一课')
  assert.equal(withLessonHint('原样', 'x', ''), '原样') // 无命中=原样返回（行为零变化）
})

test('T9 ① zh 逐字节：auto-claim / 认领全路径（动态 tag）', () => {
  const tag = 'auto-claim'
  assert.equal(msg('claim.preflightTimeout', 'zh', { tag, id: 'T9', timeoutMs: 8000 }),
    '【auto-claim】T9 认领前置检查超时（taskboard.py 8000ms 无响应），跳过认领')
  assert.equal(msg('claim.notOnBoard', 'zh', { tag, id: 'T9' }),
    '【auto-claim】T9 不在任务板或板不可读，跳过认领')
  assert.equal(msg('claim.contractViolation', 'zh', { tag, id: 'T9', hint: 'missing revision' }),
    '【auto-claim】T9 任务板回执契约违规：missing revision，跳过认领')
  assert.equal(msg('claim.unparseable', 'zh', { tag, id: 'T9' }),
    '【auto-claim】T9 任务板输出无法解析，跳过认领')
  assert.equal(msg('claim.wrongStatus', 'zh', { tag, id: 'T9', status: 'done', owner: '编排者' }),
    '【auto-claim】T9 状态为 done（owner=编排者），跳过认领')
  assert.equal(msg('claim.taken', 'zh', { tag, id: 'T9', owner: '编排者' }),
    '【auto-claim】T9 已有 owner=编排者，不覆盖，跳过认领')
  assert.equal(msg('claim.writeTimeout', 'zh', { tag, id: 'T9', timeoutMs: 8000 }),
    '【auto-claim】T9 认领写入超时（taskboard.py 8000ms 无响应；条目可能已/未被认领，请按板现状处置）')
  assert.equal(msg('claim.failed', 'zh', { tag, id: 'T9', why: 'board busy' }),
    '【auto-claim】T9 认领失败（已忽略，不阻塞派工）：board busy')
  assert.equal(msg('claim.ok', 'zh', { tag, id: 'T9', owner: '后端工程师', board: 'gh-issues-1-2.json' }),
    '【auto-claim】T9 已自动认领（owner=后端工程师，板=gh-issues-1-2.json）')
  // 动态 tag：idle-edge 历史复用形态（tag 原字面透传）
  assert.equal(msg('claim.notOnBoard', 'zh', { tag: '自动续领', id: 'T2' }),
    '【自动续领】T2 不在任务板或板不可读，跳过认领')
})

test('T9 ① zh 逐字节：auto-claim 入口三行（skipLocate 经真实调用路径）', async (t) => {
  const saved = process.env.DSH_EXPERT_AUTOCLAIM
  t.after(() => { if (saved === undefined) delete process.env.DSH_EXPERT_AUTOCLAIM; else process.env.DSH_EXPERT_AUTOCLAIM = saved })
  delete process.env.DSH_EXPERT_AUTOCLAIM
  const dir = mkdtempSync(join(tmpdir(), 't9-messages-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // tmp cwd 无 .expert-taskboards 板 → skipLocate 行（fail-open 提示，不查板）
  const line = await autoClaimSummonedTasks({ taskText: '认领 T1、T2', owner: '后端工程师', cwd: dir })
  assert.equal(line, '【auto-claim 跳过】cwd 下没有 .expert-taskboards/*.json 任务板；任务 T1、T2 未自动认领，请按协议手工 claim')
  assert.equal(msg('autoclaim.exception', 'zh', { id: 'T1', message: 'boom' }),
    '【auto-claim】T1 认领异常（已忽略，不阻塞派工）：boom')
  assert.equal(msg('autoclaim.truncated', 'zh', { total: 10, max: 8, ids: 'T1、T2', joined: 'x' }),
    '【auto-claim】任务 id 共 10 个，超过上限 8，仅认领前 8 个（T1、T2），其余请按协议手工 claim；x')
})

test('T9 ① zh 逐字节：预算三档 + 契约违规行', () => {
  const envelope = (tier, th, count) => ({
    ok: true, cmd: 'budget',
    data: { task: 'T1', budget: { enabled: true, thresholds: th, budgets: [{ owner: 'w', count, tier }] } },
  })
  // 三档原文（lib/budget.js 收口前字面量，含全角标点与空格）
  assert.equal(budgetNoticeFromEnvelope(envelope('interrupt', { interrupt: 30 }, 31), 'w'),
    '【升级｜预算｜中断档】现状：w 在本任务的执行面调用已达硬预算（31/30，跨 attempt/续领累计）——推进类调用（claim/progress/heartbeat/own）此后当场被拒，交付出口 done/fail 仍开放。建议：让该专家立即收尾交付，或改派他人 / budget --reset 显式重置（编排者裁决）。本提示不阻断。')
  assert.equal(budgetNoticeFromEnvelope(envelope('wrap-up', { 'wrap-up': 24 }, 24), 'w'),
    '【升级｜预算｜收尾档】现状：w 在本任务已计入 24/24 次执行面调用。建议：任务书须要求立即收敛交付（尽快 done/fail），勿再展开新阶段。本提示不阻断。')
  assert.equal(budgetNoticeFromEnvelope(envelope('alarm', { alarm: 10 }, 11), 'w'),
    '【升级｜预算｜告警档】现状：w 在本任务已计入 11/10 次执行面调用。建议：注意调用开销，保持收敛。本提示不阻断。')
  assert.equal(msg('budget.contractViolation', 'zh', { id: 'T1', hint: 'missing data' }),
    '【预算】T1 任务板回执契约违规：missing data')
})

test('T9 ① zh 逐字节：振荡告警 + 自动续领全路径行', () => {
  const det = createOscillationDetector({ threshold: 3 })
  let out = ''
  for (let i = 0; i < 7; i++) out = det.record(i % 2 === 0 ? 'A' : 'B') ?? out
  assert.equal(out,
    '【升级｜振荡｜告警】现状：「A」与「B」之间已交替派工 3 次来回（阈值 3；近 7 次委派呈 A↔B 交替，典型成因是方案分歧未收敛就反复返工）。建议：方案分歧先收敛裁决（评审/PM 检查点/用户裁决），勿在两位专家间反复横跳；同段同对只告警一次，第三个名字打断后重臂。本提示不阻断。')
  assert.equal(msg('reclaim.contractViolation', 'zh', { hint: 'missing ok' }),
    '【自动续领】任务板回执契约违规：missing ok，本轮跳过')
  assert.equal(msg('reclaim.writeTimeout', 'zh', { timeoutMs: 8000 }),
    '【自动续领】认领写入超时（taskboard.py 8000ms 无响应；条目可能已/未被认领，请按板现状处置）')
  assert.equal(msg('reclaim.boardNotIdle', 'zh'),
    '【自动续领】板面已有开放执行（并发认领先行），本轮整轮跳过：board_not_idle')
  assert.equal(msg('reclaim.budgetInterrupted', 'zh', { task: 'T3' }),
    '【自动续领】T3 认领失败（已忽略，不阻塞派工）：budget_interrupted')
  assert.equal(msg('reclaim.noopSkip', 'zh', { id: 'T3', reason: '状态已变化' }),
    '【自动续领】T3 状态已变化，跳过认领')
  assert.equal(msg('reclaim.stateChanged', 'zh'), '状态已变化')
  assert.equal(msg('reclaim.failed', 'zh', { why: 'board busy' }),
    '【自动续领】认领失败（已忽略，不阻塞派工）：board busy')
  assert.equal(msg('reclaim.claimed', 'zh', { id: 'T3', owner: '编排者', board: 'b.json' }),
    '【自动续领】T3 已自动认领（owner=编排者，板=b.json）')
  assert.equal(msg('reclaim.truncated', 'zh', { total: 12, max: 8, ids: 'T1、T2', joined: 'x' }),
    '【自动续领】就绪任务共 12 个，超过上限 8，仅续领前 8 个（T1、T2），其余请按协议手工 claim；x')
})

test('T9 ① zh 逐字节：断点续跑（buildResumePrompt 整帧 + answer 尾行）', () => {
  // 有清单 + 截断行 + 专家尾行
  assert.equal(
    buildResumePrompt({ progress: [{ source: '任务板检查点', text: 'T9 收口中' }], partialOutput: '半成品产出', expertName: '后端工程师' }),
    [
      '【断点续跑】上一次执行中断，宿主已按持久会话恢复本会话——这是恰好一次的续跑 turn：从中断点继续完成剩余工作，不要重做已完成阶段，完成后正常汇报。',
      '已完成进度清单（断点数据，勿重做）：',
      '- [中断前部分产出] 半成品产出',
      '- [任务板检查点] T9 收口中',
      '（续跑专家：后端工程师）',
    ].join('\n'),
  )
  // 无清单行（协议 §3 禁止盲续）
  assert.equal(
    buildResumePrompt({}),
    [
      '【断点续跑】上一次执行中断，宿主已按持久会话恢复本会话——这是恰好一次的续跑 turn：从中断点继续完成剩余工作，不要重做已完成阶段，完成后正常汇报。',
      '已完成进度清单：无（中断前未落检查点也未汇报）——先按任务板 progress 落一个检查点再继续，禁止无检查点盲续。',
    ].join('\n'),
  )
  assert.equal(msg('resume.truncated', 'zh'), '- （更多断点数据超出预算已截断）')
  assert.equal(msg('resume.answerSuffix', 'zh', { reason: 'max_turns' }),
    '【断点续跑】首轮中断（stopReason=max_turns），已按持久会话恢复并完成恰好 1 个续跑 turn')
})

test('T9 ① zh 逐字节：effort 预检双行（model 行有 T15 契约测试钉死）+ 写锁降级', () => {
  const r = preflightEffort({ profile: { model: 'model-A', effort: 'high' }, providerName: 'spawn' })
  assert.deepEqual(r.warnings, [
    '专家档案 model=model-A 未生效：provider "spawn" 未声明 agentOptions 能力（旧代宿主，降级可见）',
    '专家档案 effort=high 未生效（effort 预检）：provider "spawn" 未声明 agentOptions 能力（旧代宿主，降级可见）',
  ])
  assert.deepEqual(r.answerHints, [r.warnings[1]]) // 仅 effort 行进 answer（model 行 console-only）
  assert.equal(msg('lock.degraded', 'zh'), '【per-cwd 写锁降级】本次召唤未加锁（锁面内部错误，fail-open 可见）')
})

// ---------- ② lang 归一（非法/缺失一律 zh）----------

test('T9 ② lang 归一：仅精确 en 生效英文，其余降级 zh；normalizeReplyLang 纯函数', () => {
  assert.equal(normalizeReplyLang('en'), 'en')
  for (const bad of ['EN', 'En', 'zh', 'zh-Hans', 'fr', '', undefined, null, 0, {}, ['en']]) {
    assert.equal(normalizeReplyLang(bad), 'zh', `lang=${String(bad)} 应降级 zh`)
  }
  const enText = msg('claim.notOnBoard', 'en', { tag: 'auto-claim', id: 'T9' })
  for (const bad of ['EN', 'zh-Hans', '', undefined, null]) {
    assert.equal(msg('claim.notOnBoard', bad, { tag: 'auto-claim', id: 'T9' }),
      msg('claim.notOnBoard', 'zh', { tag: 'auto-claim', id: 'T9' }), `lang=${String(bad)} 应输出 zh 文本`)
    assert.notEqual(msg('claim.notOnBoard', bad, { tag: 'auto-claim', id: 'T9' }), enText)
  }
})

// ---------- ③ en 语料完整性（全量 key 双语 + tag 原字面）----------

test('T9 ③ en 完整性：全量 key 双语齐备、en 输出含英文且【】tag 保持中文原字面', () => {
  const keys = messageKeys()
  assert.ok(keys.length >= 30, `字典应覆盖全部收口行（实测 ${keys.length}）`)
  for (const key of keys) {
    // 双语条目存在且可调用（参数给空对象即可判形态；插值缺失不 throw 即可）
    const zh = msg(key, 'zh')
    const en = msg(key, 'en')
    assert.ok(typeof zh === 'string' && zh.length > 0, `${key} zh 应为非空串`)
    assert.ok(typeof en === 'string' && en.length > 0, `${key} en 应为非空串`)
    assert.notEqual(zh, en, `${key} en 不应照抄 zh`)
  }
  // 抽样：【】tag 保持中文原字面（协议标记稳定性）
  const tagSamples = [
    ['lesson.header', {}, '【经验提示'],
    ['autoclaim.skipLocate', { reason: 'r', ids: 'T1' }, '【auto-claim 跳过】'],
    ['budget.interrupt', { who: 'w', count: 1, threshold: 1 }, '【升级｜预算｜中断档】'],
    ['oscillation.warning', { a: 'A', b: 'B', roundTrips: 3, threshold: 3, run: 7 }, '【升级｜振荡｜告警】'],
    ['reclaim.claimed', { id: 'T1', owner: 'o', board: 'b' }, '【自动续领】'],
    ['resume.header', {}, '【断点续跑】'],
    ['lock.degraded', {}, '【per-cwd 写锁降级】'],
  ]
  for (const [key, params, tag] of tagSamples) {
    assert.ok(msg(key, 'en', params).startsWith(tag), `${key} en 应以中文 tag「${tag}」开头`)
  }
  // 抽样 5 条 en 语料语义对照 zh（行动指令保留）：
  assert.equal(msg('claim.taken', 'en', { tag: 'auto-claim', id: 'T1', owner: 'w' }),
    '【auto-claim】T1 already has owner=w; not overwriting, claim skipped')
  assert.equal(msg('autoclaim.truncated', 'en', { total: 10, max: 8, ids: 'T1', joined: 'x' }),
    '【auto-claim】10 task ids in total, exceeding the cap of 8; only the first 8 will be claimed (T1) — claim the rest manually per the protocol; x')
  assert.equal(msg('budget.interrupt', 'en', { who: 'w', count: 31, threshold: 30 }),
    '【升级｜预算｜中断档】现状：w has reached the hard tool-call budget on this task (31/30, cumulative across attempts/reclaims) — advancing calls (claim/progress/heartbeat/own) will now be rejected on the spot; the delivery exits done/fail remain open. 建议：have this expert wrap up and deliver immediately, or reassign the task / reset explicitly via budget --reset (orchestrator\'s call). 本提示不阻断。')
  assert.ok(msg('reclaim.boardNotIdle', 'en').endsWith('board_not_idle'))
  assert.ok(msg('resume.progressEmpty', 'en').includes('checkpoint'), 'en 无清单行保留「先落检查点」行动指令')
})

// ---------- ④ producer 级 lang 参数（en 生效 / 缺省 zh / 显式 en 透传）----------

test('T9 ④ producer en：withLessonHint / buildResumePrompt / preflightEffort / budget / 振荡', () => {
  assert.equal(withLessonHint('做 T9', '后端工程师', '- 第一课', 'en'),
    '做 T9\n\n【经验提示｜from 后端工程师\'s past-task lessons】\n- 第一课')
  const resume = buildResumePrompt({ progress: [{ source: '任务板检查点', text: 'x' }], expertName: '后端工程师', lang: 'en' })
  assert.ok(resume.includes('The previous execution was interrupted'))
  assert.ok(resume.startsWith('【断点续跑】'))
  assert.ok(resume.endsWith('(resumed expert: 后端工程师)'))
  const eff = preflightEffort({ profile: { model: 'model-A' }, providerName: 'spawn', lang: 'en' })
  assert.deepEqual(eff.warnings, [
    'Expert profile model=model-A not applied: provider "spawn" does not declare the agentOptions capability (legacy host; degraded but visible)',
  ])
  const bud = budgetNoticeFromEnvelope({
    ok: true, cmd: 'budget',
    data: { task: 'T1', budget: { enabled: true, thresholds: { alarm: 10 }, budgets: [{ owner: 'w', count: 11, tier: 'alarm' }] } },
  }, 'w', 'en')
  assert.ok(bud.startsWith('【升级｜预算｜告警档】'))
  assert.ok(bud.includes('has used 11/10 tool calls'))
  const det = createOscillationDetector({ threshold: 3 })
  let out = ''
  for (let i = 0; i < 7; i++) out = det.record(i % 2 === 0 ? 'A' : 'B', 'en') ?? out
  assert.ok(out.startsWith('【升级｜振荡｜告警】'))
  assert.ok(out.includes('round-trips of dispatch (threshold 3'))
  // 非法 lang 降级 zh：producer 级同样只认精确 'en'
  assert.equal(preflightEffort({ profile: { model: 'm' }, providerName: 'p', lang: 'EN' }).warnings[0],
    '专家档案 model=m 未生效：provider "p" 未声明 agentOptions 能力（旧代宿主，降级可见）')
})

test('T9 ④ producer en：autoClaimSummonedTasks lang 透传（skipLocate 路径）', async (t) => {
  const saved = process.env.DSH_EXPERT_AUTOCLAIM
  t.after(() => { if (saved === undefined) delete process.env.DSH_EXPERT_AUTOCLAIM; else process.env.DSH_EXPERT_AUTOCLAIM = saved })
  delete process.env.DSH_EXPERT_AUTOCLAIM
  const dir = mkdtempSync(join(tmpdir(), 't9-messages-en-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const line = await autoClaimSummonedTasks({ taskText: '认领 T1', owner: '后端工程师', cwd: dir, lang: 'en' })
  assert.ok(line.startsWith('【auto-claim 跳过】'), 'en 模式 tag 仍为中文原字面')
  assert.ok(line.includes('were not auto-claimed'), 'en 正文应切换英文')
  assert.ok(line.includes('T1'), '任务 id 应保留')
})

// ---------- ⑤ 未知 key throw（编程错误拦截）----------

test('T9 ⑤ msg 未知 key throw；messageKeys 全量覆盖断言', () => {
  assert.throws(() => msg('no.suchKey', 'zh'), /unknown key "no\.suchKey"/)
  // 全量 key 清单与字典收口范围对齐（新增 key 必须双语齐备，见 ③）
  assert.ok(messageKeys().includes('effort.modelDegraded'))
  assert.ok(messageKeys().includes('resume.answerSuffix'))
})
