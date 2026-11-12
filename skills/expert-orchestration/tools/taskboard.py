#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""expert-orchestrator 任务板：状态机 + 依赖 DAG + 崩溃恢复。

状态文件默认 <cwd>/.expert-taskboard.json，可用 --board 覆盖。
状态流转：pending（依赖未满足）-> ready -> running -> done | failed
  claim: ready -> running；done: running -> done（依赖它的任务自动转 ready）
  fail:  running -> failed；retry: failed -> ready；recover: 所有 running -> ready
staged 计划草案（v2.7，WP-5/S1）：create --draft 创建 PM 规划草案（status=draft，可编辑待批准）；
  approve <id>: draft -> ready 走既有事件追加路径（依赖未满足时先回 pending，由既有依赖自动提升在
  依赖 done 时转 ready——保持「ready 蕴含依赖已满足」不变量；CAS --expected-revision 共存）。
  批准前零 spawn 在工具级执法：draft 不可 claim（拒绝零事件零落盘）、不参与依赖自动提升
  （refresh 只提升 pending）、不被 recover/watchdog 触碰（均只扫 running）；插件 lib 侧 auto-claim
  仅对 ready 认领（draft≠ready 天然跳过）。draft 是合法状态值——事件流/折叠视图/replay/hash 校验
  全链透明，不新增板顶层键。reject <id>：draft -> rejected 终态（被否决草案退出批准面不永久滞留，
  archive 不因 draft 滞留被迫 --force；rejected 不可 claim/approve）；progress/reassign 拒 draft/rejected/
  escalated（草案无执行进度、终态不可再动）；metrics 不计 draft/rejected（未开工不计 owner 工作量）。
质量门禁 kind 化（v2.7，WP-5/S2）：create --kind review 声明评审任务（缺省不带 kind 字段，行为完全不变）；
  review 任务完成语义分叉——done 须显式 --verdict pass|needs_revision：结论 pass 才可 done；结论 needs_revision
  必须携带 --findings（缺 findings 在任何变更与 save 之前被拒，零事件零落盘），且不完成原任务——自动生成
  repair 任务（引用原任务+findings，--repair-owner 可指定，不经 draft 直接 ready：来源是工具自动编排而非
  PM 规划；repair_of 字段回指原任务，scope 继承原任务供 hook 第三查覆盖修复提交），原任务的全部下游依赖
  改挂 repair（DAG 重排，与原任务/repair/重排下游同落单事件 after 快照，事件流可追溯），原任务回 ready
  待修复后复审；repair 完成后下游按既有依赖提升自然解锁。repair 重试超过上限（REPAIR_RETRY_LIMIT=3，
  轮次参数后续由 m 票任务统一接配置）不再生成 repair：任务转 escalated 终态交回用户处置——不可
  claim/done/progress/reassign，用户显式 retry 解除升级并重置重试预算回 ready。
  回炉修订（T19 评审重要-1/2 + 建议①-④ + 多轮语义）：①watchdog 对 review 任务永不 adopt——评审结论
  必须经显式 done --verdict 落地，即使发现落盘报告也照常 reclaim 回 ready 重新评审；②复审 pass 时自动
  收口名下开放 repair（ready/pending/failed）为 rejected 终态（作废语义——rejected 承载草案否决与 repair 收口
  两类来源），其下游依赖改挂回已 done 的评审任务、按既有提升逻辑自然解锁；③多轮 needs_revision 每轮
  都重排：下游（挂原任务或任一旧 repair）一律改挂最新 repair，已 ready 的下游回 pending（保持「ready
  蕴含依赖已满足」），running/done 下游不打断；④--findings 超 FINDINGS_MAX_CHARS=4000 码点硬拒（与断点
  恢复 prompt 预算同口径，不静默截断）；⑤needs_revision 路径 --rework/--switched/--by 落档（对齐普通
  done 审计）；⑥verify 写路径拒 draft/rejected/escalated；⑦show 对 pass 后旧 findings 只展示归档标注
  （数据与事件流不动）。
m 票布尔共识（v2.7，WP-5/S3，用户裁决 Q3=3A）：create --kind review --quorum-m [N] 声明 N 人陪审团
  （裸 --quorum-m 即默认 DEFAULT_REVIEW_QUORUM_M=3；未声明或 N=1 为单评审员路径，行为与上一段完全
  一致）。评审员独立 vote <id> --by <评审员名> --score <0..1> 落票（任务级 votes 字段承载，多代理分别
  写入：flock+CAS 串行、--attempt 代际校验共存；同一评审员每轮一票，重投 duplicate_vote 具名拒绝）。
  投票口径：恰 1=pass 票、恰 0=fail 票、(0,1) 中间值=弃权（不计入同向计数，也不构成反向票）。生效规则：
  ≥m 张同向布尔票且零反向票——pass 生效（状态仍 running，由显式 done --verdict pass 收口；未生效收口
  被 quorum_not_met 具名拒绝）；fail 生效当场走 needs_revision 路径（复用上段 repair 生成+DAG 重排+
  回 ready 机制，轮次上限改用 REVIEW_ROUND_LIMIT，超限 escalated），本轮票箱清空、vote_round 进次轮。
  任一反向票出现即僵局：零反向约束使任一同向永不生效（票不可撤改，等待剩余票不改变结局）——任务当场
  escalated 交回用户处置。回 ready 重新评审的路径（用户 retry 解除 escalated / failed 任务 retry /
  watchdog reclaim / recover）都同步清空票箱、重置轮次（_mvote_reset_ballot 一处实现，T20 回炉评审
  重要-1：旧票跨轮残留会伪造共识——旧同向票+新一轮少量同向票假生效——或伪造僵局）。m 票任务拒单方
  done --verdict needs_revision（vote_required 具名拒绝）——fail 只能经投票生效，防单方绕过陪审团。
依赖：create 时 --dep T1,T2 声明；引用不存在的任务会报错。
代理 scoped 自建任务（M1）：create --created-by <专家名> --of <任务id> 二者必须成对出现（只给其一或给
  空串/纯空白——入口 strip 归一后视同缺参——一律具名拒绝 created_by_of_pair_required）；校验链按序——
  ①--of 任务须存在于本板且 owner == --created-by
  （认领关系核实，否则 not_task_owner）；②新任务 scope 必须显式非空（否则 agent_create_requires_scope，
  不继承父 scope）且逐项 ⊆ --of 任务 scope（复用 _scope_match 语义，
  否则 scope_out_of_violation）；③强制 status=draft（缺 --draft 即拒绝 agent_create_requires_draft）；
  ④kind 允许面=缺省 kind（follow-up 语义），--kind 同传具名拒绝 agent_create_kind_rejected（Q5 裁决）；
  ⑤owner 一致性：显式 --owner 必须等于 --created-by（自建自领，否则 agent_owner_mismatch）；
  ⑥代理 draft 进入既有待批面（approve/reject/claim 拒绝语义零改动）。任务 JSON 落单键字符串字段
  created_by（事件流 type=create 的 args 携带 created_by/of 留档）；lead 派发（不带新参数）不落此字段，
  输出与旧版逐字节一致。
检查点：progress <id> "<说明>" 向任务追加带时间戳的检查点记录（新字段 checkpoints，旧板无此字段兼容）；长任务/多阶段委派每完成一个阶段记一次，专家失败重试前编排者先读取它组装续跑任务书，禁止无检查点直接从头重跑。
指标：metrics 按 owner 聚合 任务数/累计返工/换人次数（新字段 rework/switched，旧板无此字段兼容）；done 支持 --rework N / --switched 记录返工与换人，--by 记录实际执行者（新字段 executors，旧板无此字段兼容），供项目收口时反哺专家路由表。
并发正确性（v2.6）：
  进程互斥与原子写：除 boards 外所有命令全程持有 <board>.lock 文件的 fcntl.flock 独占锁，CAS 校验在锁内
    针对最新落盘状态进行、与写入原子（无 TOCTOU）；无 fcntl 平台（如 Windows）或设 TASKBOARD_DISABLE_FLOCK=1
    时降级为无锁——写入仍走唯一 tmp（pid+uuid 后缀）+ os.replace 原子替换，不会互相截断板文件，
    但校验-写入的强一致仅 POSIX 保证。
  CAS 乐观锁：板级 revision 随每次写自增；除 boards/archive 外所有命令末行输出 revision=N，写命令可带
    --expected-revision N，与当前不符返回具名错误 {"error":"stale_revision",...} 且不落盘；不带该参数行为与旧版一致。
  attempt 代际：claim --attempt <id> 建立派工代际；reassign <id> <新attempt> 转派先撤销旧代际（记入 attempt_revoked），
    且拒绝复活任何已撤销代际；done/fail/progress 带 --attempt 时按代际校验（fail closed：任务无开放代际时
    返回 {"error":"no_attempt",...}），旧/已撤销代际返回 {"error":"stale_attempt",...} 且不落盘；不带 --attempt 行为与旧版一致。
  reassign 代际能力化（T7）：reassign <id> auto 由工具生成不可猜 token（at-<16hex>，show/--json 回显，供抄入下游任务书，
    绝不复用已撤销代际与当前代际）；reassign <id> auto --attempt <当前代际> 为 peer 互派通道——持有证明按 check_attempt
    口径校验当前开放代际（no_attempt/stale_attempt 具名拒绝、零写零事件），且限任务当前 owner==自己（R1 投影：token 只随
    任务书下发给当前 owner，持当前开放代际即视作 owner 本人；CLI 无鉴权，防误用非防伪造）。持有证明与自报新 attempt_id
    混用返回 {"error":"attempt_source_conflict",...}（peer 持有证明时新 token 必须由工具生成）；任务无 owner 时 peer 通道
    返回 {"error":"not_task_owner",...}（无主任务的派发权在编排者通道）。'auto' 自本版起为 reassign 保留触发词；
    不带 --attempt 且不自报 'auto' 的旧用法逐字节不变；生成模式事件 args 携带 generated=true 与 proof_attempt（有持有
    证明时）留痕，token 也是合法 attempt_id——八命令既有 --attempt 校验零改动复用。
  能力标签（T8）：create --tags "a,b" 落任务 tags 字符串数组（逗号分隔、逐项 strip、去空保序去重；
    显式给参但解析为空一律拒绝，缺省不落 tags 字段、输出逐字节不变）。claim --tags <声明>：任务带 tags
    且与声明无交集，或任务带 tags 而声明缺失，均返回 {"error":"tag_mismatch",...} 拒绝（宁拒勿猜 Q3，
    零写零事件）；任务无 tags 任何认领不受影响。claim_idle --tags 同口径：不匹配候选逐个跳过
    （skipped.reason=tag_mismatch 进既有 skipped 数组），不带 --tags 时带 tags 候选一律跳过（宁漏勿错）；
    全跳过仍走 claim_idle_noop。tags 与 M1 校验链（--created-by/--of）正交，不参与 scope 校验；
    声明值随事件 args.tags 留档（未声明时 args 形状不变）。
  open-counts 反风暴查询（T9）：open-counts [owner] 按 owner 聚合 open 任务（draft/pending/ready/running，
    draft 计入、终态不计入）计数与清单；只读无锁快照（沿 budget T38-1 降锁先例 load(repair=False)），
    零写零事件——查询面绝不产生事件/视图写；--json data 为 {owner:{count,tasks:[id...]}}（owner 缺省
    聚合全部；无主任务归 '' 键）。R1 口径如实声明：owner 以板面自报为准，防误用不防伪造；写面超限
    执法不做（Q7）——编排者在 approve 代理草案/peer 互派前经本命令核查，超限不批准/不派转上报
    （协议纪律，上限建议值见 PM 计划 §5）。
  查询失败语义：任务板文件损坏/结构非法（含深层结构，如 tasks 条目非对象）时，除 boards（逐板标注损坏）外
    所有命令返回 {"error":"unrecoverable","unrecoverable":true,...}，绝不静默返回空列表、绝不裸 traceback。
  环检测：create --dep 与 set_dependencies 写入前做全图环检测，成环返回 {"error":"dependency_cycle","cycle":"A->B->A"} 且不落盘。
门禁执法平面（v2.6，默认关闭，显式开启——未 --install-hook 前任何命令不触碰 .git/hooks/）：
  --install-hook：向当前仓库 .git/hooks/commit-msg 写入零依赖 POSIX sh hook（内嵌 python3 调本工具 _hook-check 三查：
    ① 提交消息须可解析出任务 id（形如 T<数字>）；② 存在性校验：消息中解析出的全部任务 id 均须在板集任一板内存在
    （running 或终态 done/failed 等均合法，板外假 id 即拒——防夹带未核 id）；③ 各任务（含终态条目）声明 scope 时的
    并集内提交文件均须落在关联域内）。板集（v2.13.1 T1 多板运行时解析）：
    未固化 --board 时 hook 运行时以 git rev-parse --show-toplevel 取提交所在仓库根，扫描其 .expert-taskboards/ 下
    全部 *.json 板联合裁决（id 命中任一板即可，scope 并集跨板取）——worktree 私有板同样被读取，提交根与板路径解耦；
    --board 仍可把项目板路径固化进 hook（单板模式，行为与旧版一致）。已有同名 hook 时报错退出不覆盖
    （内容完全一致视为已安装幂等返回；内容含本插件指纹标记行视为旧版本插件 hook，允许原地升级覆盖）。
  --uninstall-hook：仅移除本插件安装的 hook——凭写入 hook 内的稳定指纹标记行辨认（标记行为固定注释前缀+协议版本，
    不随模板内容演进变化，模板任何一改旧 hook 仍可用工具卸载；旧版哈希形态的标记行同样被认得），无标记行则拒绝
    （不破坏用户自有 hook）。
  降级语义（fail-open，均 stderr 告警放行、不阻塞提交，与门禁辅助定位一致——板/环境不可用时拒绝会永久卡死所有提交）：
    ① hook 找不到门禁脚本（taskboard.py 被移动/卸载）；② python3 不可用（command -v 检测，hook 头部拦截，
    装回 python3 后门禁自动恢复）；③ 板集为空（未固化板时 <仓库根>/.expert-taskboards/ 目录缺失或无任何 *.json 板、
    含 archive 归档把板移走后——归档收口属预期流程，hook 不再阻塞提交，提示重新 --install-hook 或
    --uninstall-hook）。脚本在、python3 在、板集非空而三查不过则拒绝提交（fail closed）。
滑动无进展 watchdog + 孤儿 adopt（v2.7，WP-4b/S2）：
  heartbeat <id>：running 任务心跳——重臂窗口并清零 nudge 计数（长任务报活的最小信号，不产检查点）。
  watchdog：扫描 running 任务的滑动无进展窗口（activity=max(updated,heartbeat_at,nudged_at)；claim
    新代际/progress/heartbeat 重臂，健康的长任务永不因跑得久被杀）。窗口到期 nudge（计数+重臂一个
    窗口），连续 --max-nudges（默认 2）次无响应升级：先在落盘信箱（coordinator 收件箱、_archive 归档、
    _outbox/<owner> 发件箱）检索本任务本 attempt 本 owner 的完成报告（subject/body 含任务 id+「完成」
    +交付词汇，多条取 ts 最新）——有证据 adopt 为 done（汇报内容入 summary，工作比它的 agent 活得久），
    无证据 reclaim（撤销当前代际防迟到汇报、清 owner 回 ready）。nudge/reclaim/adopt 均落检查点轨迹
    （watchdog: 前缀）；所有变更走既有事件追加路径（watchdog/heartbeat 为写命令，单事件携带全部变更
    任务 after 快照），新字段 heartbeat_at/nudges/nudged_at 随快照折叠只增不减，既有命令输出零变化。
    （v2.14.2 升级信封收口：stdout 三条升级线 nudge/adopt/reclaim 改走【升级｜时间窗｜…】信封格式
    （SKILL.md §3），检查点落盘轨迹与 telemetry/汇总行维持 v2.7 字面不变。）
per-(任务,专家) 工具调用硬预算（v2.8 M8-2，#16，T27；默认关闭 opt-in）：
  DSH_EXPERT_TOOL_BUDGET 显式开启后，执行面写命令（claim/progress/heartbeat/done/fail/own/vote）派发前做
  事件溯源计数——计数唯一事实源是事件流（验收 a：模型自报不入境，bus 消息/检查点文本/任何叙述性内容
  都不进计数输入）；seed/budget 系统事件与编排面命令（create/approve/reject/retry/recover/reassign/
  set_dependencies/verify/watchdog）永不计入，budget 事件不计入同时封死「记录档位→计数增长→再记录」的
  自激回路。三档语义固定、阈值可配（DSH_EXPERT_TOOL_BUDGET_ALARM/_WRAPUP/_INTERRUPT，默认 200/250/300，
  须 alarm ≤ wrap-up ≤ interrupt，非法配置 fail-open 整体不启用并 stderr 告警）：告警档 alarm 非阻断
  （stderr 开销提示+档位章随本命令事件落账）；收尾档 wrap-up 非阻断（收敛指令+章）；中断档 interrupt
  当场拒绝推进类调用（claim/claim_idle/progress/heartbeat/own）——首次拒绝落 type='budget' 系统事件（interrupt 章+
  refused 标记+检查点，revision+1）保证档位行为事件可见（验收 b），后续拒绝幂等零事件防刷屏；交付出口
  done/fail/vote 永不拒绝（中断=强迫交付而非堵死交付）。fail-safe：拒绝发生在任何命令变更之前（命令
  自身零写），预算事件只追加簿记（不动 status/owner/代际），任务板状态不受损。计数只读绝不写事件流
  （防计数自激）；计数失败 fail-open 放行（预算是成本护栏非正确性屏障）。budget <id> 只读盘点（--json
  data.budget 携带 enabled/thresholds/epoch/stamped/budgets，零写零事件）；budget <id> --reset 编排者
  显式重置计数纪元（跨代累计语义下的唯一放行出口，事件+检查点留痕）。计数 per-(任务,专家) 跨 attempt/
  跨 reclaim 累计——#20 自动续领复用 claim 路径即自动同受预算约束（reclaim 不清计数）；与 watchdog
  互补不冲突：watchdog 管时间窗无进展（activity 重臂），预算管调用量发散（事件计数）——interrupt 档
  拒绝 heartbeat/progress 使窗口自然到期、watchdog nudge→reclaim 接管，二者串联闭环；档位章不触碰
  updated（档位章不是活动信号，不重臂 watchdog 窗口）。
 budget 只读盘点降锁（v2.9 M1/T3，T38-1）：budget（无 --reset）不持 board.lock 独占写锁——无锁
   快照读路径（load/read_events 的 repair=False 变体）：零写零 stderr（不重建视图、不自愈事件流——
   无锁进程绝不与持锁写命令竞争 os.replace/O_APPEND），输出=事件流某一完整前缀的折叠（链式 hash
   全量校验保证为真实已落账状态），并发写命令进行中时至多略滞后（快照级一致性语义）；错误面/
   信封/人类输出与锁内路径逐字节一致，盘点零写零事件防自激语义不动；--reset 与其余全部命令仍走
   锁内路径（flock 结构零改动）。
 空闲续领原子认领（v2.9 M1/T3，T39-① 收窄）：claim_idle <owner> <id...> 在 main 统一 board_lock
   单次持锁内完成「板上无 running 判定 + 认领」——消解 lib list 快照与 claim 之间的窄窗（并发
   sweep/人工 claim 双双入选，现恰好一个成功）；空闲闸 board_not_idle（零写零事件）、候选锁内
   复判（非 ready/已有 owner/不存在跳过，全跳过 claim_idle_noop）、逐候选预算门两段式章延后
   （interrupt 拒绝同 claim，#20 续领受 #16 预算约束零回归；alarm/wrap-up 升档章在全部门判定
   通过后统一落章随 claim 事件入账——拒绝时点全板除被拒任务零变更，跨档「前章后拒」拒绝
   事件保持折叠可复现，v2.9 T11）；事件 type='claim' 不建派工代际，lib idle-reclaim
   改调本命令（list 快照降级为 fail-open 预筛，auto-claim（WP-4a）路径不动）。
验证回执范围指纹（v2.6）：verify <id> <文件...> 对完成汇报附带文件清单逐文件记 SHA-256（整表 digest 存板）；
  verify <id>（无文件）与 show/done 均重算比对，文件一变回执即标 stale（旧验证/旧评审自动失效），done 时 stale 仅告警不阻塞。
机器可读结构化输出通道（v2.8 S1，T17）：全局 --json 开关——开启后 stdout 恰一行 JSON 信封、
  人类可读文本不再上 stdout（stderr 诊断/告警不受影响），退出码语义与缺省完全一致。信封形态：
  成功 {"ok":true,"cmd":<命令>,"data":<结构化载荷>,"revision":<板级 revision（archive/_hook-check 缺省不带，与人类面末行约定一致）>}；
  写命令（_WRITE_CMDS）另附 "event_seq"=本次落账后事件流末 seq（exposure-crypto-trust N2 对账锚点，与 replay data.event_seq 同源）；
  失败 {"ok":false,"error":<具名错误码或 command_failed>,...既有错误字段}（BoardError 字段原样保留，人读 sys.exit 类拒绝归一为
  command_failed+message）。data 载荷：任务中心命令给完整任务对象（含全部簿记字段——新增字段对机器消费方透明可见，这正是
  结构化通道的意义：不再依赖展示层文本行格式）、create 给创建后任务对象（N2 审计回显）、list 给 id 升序任务数组、boards 给逐板摘要数组、
  其余命令给空对象。
  缺省（不带 --json）人类可读面逐字节零变化；消费方契约升级路径：lib/tools.js auto-claim 已改走本通道（v2.8 S1）。
事件溯源化核心（v2.7）：
  状态权威：append-only JSONL 事件流 <板文件>.events.jsonl；JSON 板文件降级为「折叠视图」缓存（对外只增簿记字段
    event_seq/event_state_hash，既有字段零删改），list/status/show/deps 等命令输出结构不变。
  写路径：命令在 board_lock 锁内 load（折叠）-> CAS 校验 -> 变更 -> 追加一个事件（O_APPEND+fsync）-> os.replace
    原子重写视图；事件记录变更任务的全量快照（after）与命令意图（args），折叠=逐事件应用快照，重放与崩溃前
    逐字段一致；状态迁移逻辑只在命令函数一处，折叠层零业务规则。
  hash 防手改：事件链式 hash（每事件 hash=SHA-256(canonical(除 hash 外全字段))，prev 串前事件；中段断链/篡改
    -> unrecoverable），末事件另记 state_hash=SHA-256(canonical({tasks,seq,revision}))；加载时视图按同一
    state_hash 对账——视图缺失或落后（事件已追加、视图未及写的崩溃间隙）静默重放重建；视图被手改/损坏
    -> stderr 报警并按事件流权威重建覆盖（stdout 零污染，消费方解析不受扰）。
  崩溃恢复：事件流尾部残行/末事件校验失败（追加途中被杀）自动截断修复并 stderr 告警，后续追加 seq 连续衔接；
    末事件完整合法但缺行尾换行（fsync 后恰损换行的部分落盘）→ 读路径补写换行自愈并告警，后续追加不粘包、
    已落账事件不回滚；replay 命令可显式重放重建视图（幂等，崩溃演练/人工核对用）。
  旧板收编：无事件流的 v2.6 板首次写命令时以既有折叠状态为种子事件（seed）自动收编，数据零丢失，revision 延续；
    含 tasks/seq/revision+簿记之外未知顶层键的板当场 unrecoverable（收编早失败——放行则未知键被折叠模型
    静默丢弃，错一拍才暴露且无对账线索）。
  防洗白/防劫持（回炉加固）：事件流文件存在但为空而视图含簿记字段 → unrecoverable（簿记证明日志曾有事件，
    此刻为空必异常；拒绝按未校验视图直读或以其为种子重新收编。合法空日志仅出现在收编前——视图必无簿记字段，
    不误伤崩溃恢复）；archive 先迁事件流后迁板（两步间被杀顶层残留的是板而非孤儿日志，读命令可直读降级、
    写命令重新收编）；load 对「板文件缺失但事件流存在，且归档区有同名板的有簿记无日志残留」（旧序 archive
    崩溃窗口孤儿日志）拒绝复活旧板/续链（unrecoverable），同名 create 同拒。
  archive：事件流随板文件一并归档（<归档名>.events.jsonl），重放能力不因归档丢失。
  规模口径（T10 首轮 s2 事件流压实，T17 收口留档裁定不实施）：load 每次全量读日志折叠为 O(N) 扫描，
    预期任务量级千级以内成本可忽略；单板事件达万级前须先引入 seq 索引/快照事件再扩展，勿直接沿用
    本实现（压实会牺牲 append-only 链式 hash 的全历史重放能力，须与 state_hash 口径一并重新设计）。
  折叠语义不变量（当前命令集契约，扩展事件模型前必读；违背即重放与末事件 state_hash 失配 → 板 unrecoverable）：
    ① fold_events 只能逐事件覆盖 after 快照中的任务，无法表达任务删除——当前命令集不存在删除任务的命令；
       未来新增删除类命令须同步扩展折叠语义（如墓碑事件），否则重放结果多出已删任务，与崩溃前状态不一致。
    ② commit_event 落视图仅写 {tasks,seq,revision}+簿记（event_seq/event_state_hash），当前命令集不写板
       顶层其他键；未来新增板顶层键须同步纳入 seed/折叠/state_hash 口径，否则重放折叠缺该键、对账失配。
"""
import argparse, collections, contextlib, copy, datetime, decimal, glob, hashlib, json, os, re, subprocess, sys, time, uuid

try:
    # POSIX 标准库；Windows 等无 fcntl 平台降级（见 board_lock）
    import fcntl
except ImportError:
    fcntl = None


class BoardError(Exception):
    """具名错误：main 统一以 JSON（stdout）输出并退出码 1，机器可解析。"""

    def __init__(self, code, **fields):
        super().__init__(code)
        self.code = code
        self.fields = fields


# repair 重试上限（v2.7 WP-5/S2）：review 任务累计 needs_revision 次数超过该值即转 escalated
# 终态交回用户处置。预置默认 3，作用于 m=1 单评审员路径（done --verdict 单票）。
# m 票路径（quorum_m≥2）改用评审轮次上限 REVIEW_ROUND_LIMIT（见下）——两个上限分路径取用（m 票任务
# 恒用评审轮次上限：单方 needs_revision 被 vote_required 拒、fail 只能经投票生效，本上限不触发；
# 仅单票路径取用本值）；
# 轮次计数同源复用 repair_count（评审轮次=needs_revision 发生次数，同一事实不设第二计数器，杜绝双计数漂移）。
REPAIR_RETRY_LIMIT = 3

# m 票布尔共识参数（v2.7 WP-5/S3，用户裁决 Q3=3A）：
DEFAULT_REVIEW_QUORUM_M = 3  # create --kind review 裸声明 --quorum-m 时的默认陪审团规模（m=3）
REVIEW_ROUND_LIMIT = 2       # m 票评审轮次上限：fail 生效（=needs_revision 发生）超过 2 轮即 escalated

# --findings 长度上限（v2.7 T19 回炉，建议③）：码点数，超限硬拒（零事件零落盘）而非静默截断——
# 截断会丢评审要点且 repair desc 以 findings 为据；口径与断点恢复 prompt 预算（lib RESUME_PROMPT_MAX_CHARS）对齐。
FINDINGS_MAX_CHARS = 4000
# --by 声明长度上限（方向 4 审计面）：身份声明是名字不是文档，200 码点封顶；
# 超限硬拒（零事件零落盘）而非静默截断——截断会让审计面留半个签名（比没有更糟）。
APPROVAL_BY_MAX_CHARS = 200

# ── #16 per-(任务,专家) 工具调用硬预算（v2.8 M8-2 / WP-7 ①，T27）─────────────
# 事件溯源计数（验收 a）：计数唯一事实源=事件流 <板>.events.jsonl——模型自报（bus 消息/检查点
# 文本/任何叙述性内容）不入境；系统事件（seed/budget）与编排面命令（create/approve/reject/retry/
# recover/reassign/set_dependencies/verify/watchdog）永不计入，budget 事件不计入同时封死
# 「记录档位 → 计数增长 → 再记录」的自激回路。三档（验收 b，语义固定、阈值可配）：alarm 告警
# （非阻断提示+档位章）/ wrap-up 收尾（非阻断收敛指令+章）/ interrupt 中断（推进类调用当场拒绝、
# 首次拒绝落 budget 事件、交付出口 done/fail/vote 永不拒绝）。默认关闭（DSH_EXPERT_TOOL_BUDGET
# 显式开启，与 DSH_EXPERT_CWD_LOCK opt-in 同哲学）：未开启时写路径零变化（不读事件流、不加章、
# 不拒绝）。_BUDGET_EVAL 为 cmd_budget → _structured_data 的 --json data 载荷进程内暂存（_EVT_CTX 同款）。
BUDGET_TIER_RANK = {'alarm': 1, 'wrap-up': 2, 'interrupt': 3}
BUDGET_COUNTED_TYPES = frozenset(('claim', 'progress', 'heartbeat', 'done', 'fail', 'own', 'vote'))
# 推进类（interrupt 档当场拒绝）；done/fail/vote=交付出口永不拒。claim_idle 属推进类
# （认领即开工，v2.9 T3/T39-①）——#20 空闲续领与 claim 同受 interrupt 闸约束（T28 (d) 语义）。
BUDGET_REFUSABLE_TYPES = frozenset(('claim', 'claim_idle', 'progress', 'heartbeat', 'own'))
DEFAULT_BUDGET_THRESHOLDS = {'alarm': 200, 'wrap-up': 250, 'interrupt': 300}
_BUDGET_EVAL = {'payload': None}
# _CLAIM_IDLE_EVAL 为 cmd_claim_idle → _structured_data 的 --json data 载荷进程内暂存
# （_BUDGET_EVAL 同款惯例）：claimed/skipped 与人类面逐任务块同源。
_CLAIM_IDLE_EVAL = {'claimed': [], 'skipped': []}



def _mvote_active(t):
    """任务是否处于 m 票多评审员模式：quorum_m≥2 显式声明才启用；未声明或 m=1 一律单评审员路径
    （done --verdict 单票，行为与 T19 完全一致——m=1 向后兼容锚点）。"""
    m = t.get('quorum_m')
    return isinstance(m, int) and not isinstance(m, bool) and m >= 2


def _vote_tally(t):
    """当前轮票箱统计（唯一口径来源）：恰 1 记 pass 票、恰 0 记 fail 票、(0,1) 中间值记弃权
    （弃权不计入同向计数，也不构成反向票）。返回 (pass, fail, abstain)。"""
    votes = t.get('votes') or []
    p = sum(1 for v in votes if v.get('score') == 1)
    f = sum(1 for v in votes if v.get('score') == 0)
    return p, f, len(votes) - p - f


def _mvote_reset_ballot(t):
    """回 ready 重新评审前清空 m 票票箱（quorum_m≥2 任务）：清空 votes、重置 vote_round。
    全部「回 ready 重新评审」路径（用户 retry 解除 escalated / failed 任务 retry / watchdog
    reclaim / recover，T20 回炉评审重要-1）共用这一处实现——评审轮次以回 ready 为界，旧票跨轮
    残留会让「≥m 同向且零反向」跨轮计票：旧同向票+新一轮少量同向票假 pass 生效，旧反向票假僵局
    （watchdog reclaim 为自动路径，无人操作即可触发）。本函数只改内存态，落盘由调用方既有 save
    执行（清空动作随所在命令的单事件 after 快照落事件流）。返回是否清空（供检查点措辞）。"""
    if not _mvote_active(t):
        return False
    t.pop('votes', None)
    t.pop('vote_round', None)
    return True


def _score_arg(s):
    """--score 解析（T20 回炉裁决③）：布尔票边界「恰 1/恰 0」按十进制字面量精确判定——
    21 个 9 的 0.999…9 经 float() 会坍缩成恰 1.0 而被误记 pass 票（对称地 0.000…1 坍缩成恰 0
    误记 fail 票），此类字面量在解析期具名拒绝；其余值转双精度存档（中间值只承载弃权语义，
    坍缩无实害不拒）。nan/inf 仍交 cmd_vote 既有区间校验具名拒绝（退出语义与旧版一致）。"""
    try:
        d = decimal.Decimal(s)
    except (decimal.InvalidOperation, ValueError):
        raise argparse.ArgumentTypeError(f'无效十进制数值 {s!r}')
    if not d.is_finite():
        return float(d)  # nan/inf：交 cmd_vote 既有 [0,1] 区间校验拒绝
    v = float(d)
    if (v == 1.0 and d != 1) or (v == 0.0 and d != 0):
        raise argparse.ArgumentTypeError(
            f"{s} 字面量并非恰 {'1' if v == 1.0 else '0'} 但双精度坍缩到恰值——布尔票边界按十进制"
            "字面量精确判定，请按字面精度给分（pass 票给 1、fail 票给 0）")
    return v


def now_ms():
    return int(time.time() * 1000)


class _NullBoardLock:
    """无 fcntl 平台（或 TASKBOARD_DISABLE_FLOCK=1）的降级锁：不提供进程间互斥。"""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FlockBoardLock:
    """fcntl.flock 独占锁：多进程写同一板时校验-写入串行化（内核保证进程死亡即释放）。"""

    def __init__(self, lock_path):
        self.lock_path = lock_path
        self.f = None

    def __enter__(self):
        self.f = open(self.lock_path, 'w')
        fcntl.flock(self.f.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        finally:
            self.f.close()
            self.f = None
        return False


def board_lock(path):
    """进程间互斥：main 中 load -> CAS 校验 -> 命令写入（save）必须整体在锁内完成（TOCTOU 防护）。
    - POSIX（有 fcntl）：fcntl.flock 独占锁 <board>.lock。
    - 无 fcntl（如 Windows）或设 TASKBOARD_DISABLE_FLOCK=1：降级为无锁——写入仍走唯一 tmp（pid+uuid
      后缀）+ os.replace 原子替换，不会互相截断板文件；但 CAS 校验与写入不再原子（强一致仅 POSIX 保证）。
    """
    if fcntl is None or os.environ.get('TASKBOARD_DISABLE_FLOCK'):
        return _NullBoardLock()
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    return _FlockBoardLock(path + '.lock')


def _unrecoverable(path, reason):
    return BoardError('unrecoverable', path=path, reason=reason)


def _validate_board(data, path):
    """深层结构校验：tasks 条目必须为对象且命令路径会访问的字段类型正确。
    违反即 unrecoverable（覆盖评审项：tasks 条目非 dict 等深层损坏，绝不裸 traceback）。"""
    tasks = data.get('tasks')
    if not isinstance(tasks, dict):
        raise _unrecoverable(path, '结构非法：缺少 tasks 对象')
    if not isinstance(data.get('seq'), int) or isinstance(data.get('seq'), bool):
        raise _unrecoverable(path, '结构非法：seq 必须是整数')
    for tid, t in tasks.items():
        if not isinstance(tid, str) or not (tid.startswith('T') and tid[1:].isdigit()):
            raise _unrecoverable(path, f'结构非法：任务 id {tid!r} 不是 T<数字> 形式')
        if not isinstance(t, dict):
            raise _unrecoverable(path, f'结构非法：任务 {tid} 条目不是对象')
        for k in ('id', 'title', 'status'):
            if not isinstance(t.get(k), str):
                raise _unrecoverable(path, f'结构非法：任务 {tid} 缺少或类型错误的字段 {k}')
        dep = t.get('dep')
        if not isinstance(dep, list) or not all(isinstance(d, str) for d in dep):
            raise _unrecoverable(path, f'结构非法：任务 {tid} 的 dep 必须是字符串列表')


# ── 事件溯源化核心（v2.7）：JSONL 事件流为状态权威，JSON 板文件降级为折叠视图缓存 ──
# 组织：事件流 <板文件>.events.jsonl（不以 .json 结尾，不干扰板定位的 *.json 枚举与 boards 列举）；
#   事件=变更任务的全量快照差分（after）+ 命令意图（args），折叠=逐事件应用快照——重放与崩溃前逐字段一致，
#   状态迁移逻辑只存在于命令函数一处（快照采集自真实落盘状态，折叠层零业务规则，不双写不分叉）。
# hash 方案：事件链式 hash——每事件 hash=SHA-256(canonical(除 hash 外全部字段))，prev 串前事件 hash；
#   末事件另记 state_hash=SHA-256(canonical({tasks,seq,revision}))；加载时视图按同一 state_hash 对账。
#   视图缺失/落后于事件流（「事件已追加、视图未及写」的崩溃间隙，含旧板收编的同类间隙）→ 静默重放
#   重建；视图被手改/损坏（state_hash 失配或 JSON 解析失败）→ stderr 报警并按事件流权威重建
#   （stdout 零污染，消费方解析不受扰）。
# 事件流尾部残行（末行不可解析的撕裂写）→ 自动截断修复并告警；可解析但链/hash 校验失败（含末事件）
#   与中段损坏/断链 → 一律 unrecoverable（截断已落账的末事件=静默回滚命令，篡改语义对称）。
# 旧板收编：无事件流的 v2.6 板首次写命令时以既有状态为种子事件（seed）自动收编，数据零丢失，revision 延续。
BOOKKEEPING_KEYS = ('event_seq', 'event_state_hash')


def events_path(path):
    """事件流文件路径：<板文件>.events.jsonl。"""
    return path + '.events.jsonl'


def _canonical(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _sha_hex(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def _state_hash(d):
    """折叠状态 hash：排除视图簿记字段后的 canonical JSON 整体 SHA-256（手改任意语义字段即失配）。"""
    return _sha_hex(_canonical({k: d[k] for k in d if k not in BOOKKEEPING_KEYS}))


def _event_hash(ev):
    return _sha_hex(_canonical({k: v for k, v in ev.items() if k != 'hash'}))


def _repair_events(ep, evs):
    """截断修复事件流：只保留验证通过的事件（唯一 tmp + os.replace 原子替换）。"""
    d = os.path.dirname(ep)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f'{ep}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for ev in evs:
            f.write(json.dumps(ev, ensure_ascii=False) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, ep)


def read_events(path, repair=True):
    """读取并校验事件流：逐行解析 + 链式 hash 验证，返回验证通过的事件列表。
    尾部残行（末行不可解析的结构性残缺——O_APPEND 单行撕裂写缺闭合括号）→ 截断修复并 stderr 告警
    （崩溃恢复语义）；可解析但 seq/prev/hash/type 校验失败（含末事件被篡改、次末行被删导致的断链）
    一律 unrecoverable，与中段篡改同语义——可解析事件是已 fsync 落账的完整命令，按残尾截断等于
    静默回滚一次已执行命令（数据丢失且篡改语义不对称）；中段不可解析 → unrecoverable（权威受损
    绝不静默）。末事件完整合法但缺行尾换行（fsync 后恰损换行的部分落盘）→ 补写换行自愈并告警，
    防止下次 O_APPEND 追加与末事件粘包后被误当残尾截断。
    repair=False（v2.9 T3/T38-1 budget 无锁只读快照专用）：读路径零写零 stderr——残尾容忍跳过
    （不截断不告警，evs 已按完整前缀截取，修复留给下一个持锁命令）、缺尾换行不补写（完整末行
    照常解析）；其余校验语义逐字节一致。无锁进程绝不自愈写：os.replace 换 inode / 补写字节与
    持锁写命令的 O_APPEND 追加竞争会丢事件（快照读只许读）。"""
    ep = events_path(path)
    if not os.path.exists(ep):
        return []
    with open(ep, encoding='utf-8', errors='replace') as f:
        raw = f.read()
    items = [(i + 1, s) for i, s in enumerate(raw.split('\n')) if s.strip()]
    evs, torn, bad = [], False, None
    for k, (ln, s) in enumerate(items):
        try:
            evs.append(json.loads(s))
        except Exception:
            bad = k
            break
    if bad is not None:
        # 解析失败行之后若还存在可解析行 → 中段损坏；否则视为崩溃残尾
        for _, s2 in items[bad:]:
            try:
                json.loads(s2)
            except Exception:
                continue
            raise _unrecoverable(path, f'事件流第 {items[bad][0]} 行损坏（中段不可解析）')
        torn = True
        evs = evs[:bad]
    prev_hash, prev_seq = '', 0
    for k, ev in enumerate(evs):
        ok = (isinstance(ev, dict) and ev.get('seq') == prev_seq + 1
              and ev.get('prev') == prev_hash and ev.get('hash') == _event_hash(ev)
              and isinstance(ev.get('type'), str))
        if not ok:
            # 可解析但链/hash 校验失败：无论位置一律 unrecoverable（含末事件——不按残尾截断，
            # 截断会静默回滚已落账命令的效果；撕裂写若只是丢了行尾换行（JSON 完整合法）由下方
            # 缺换行自愈分支处理，不会走到这里）
            raise _unrecoverable(path, f'事件流第 {k + 1} 个事件校验失败（链/hash 校验失败或被篡改）')
        prev_hash, prev_seq = ev['hash'], ev['seq']
    if torn:
        if repair:
            _repair_events(ep, evs)
            print(f'警告：事件流尾部存在未完成写入（疑似进程被杀），已截断修复至最后一个完整事件: {ep}', file=sys.stderr)
        # repair=False：残尾容忍（零写零 stderr）——evs 已是完整前缀，即崩溃前已落账状态
    elif raw and not raw.endswith('\n') and evs:
        if repair:
            # 丢尾随换行自愈（二轮评审重要-3）：fsync 后恰损行尾换行时末事件仍完整合法且链校验通过——
            # 若直接 O_APPEND 追加，会与末事件粘成一行不可解析，下次读取按撕裂残尾截断，把已落账命令
            # 一并回滚（实测 4→2）。读路径先补写换行（O_APPEND 单字节 + fsync），保证后续追加不粘包。
            with open(ep, 'a', encoding='utf-8') as f:
                f.write('\n')
                f.flush()
                os.fsync(f.fileno())
            print(f'警告：事件流末尾缺失换行符（疑似写入中断残留），已补写自愈: {ep}', file=sys.stderr)
        # repair=False：完整末行照常解析，不补写（无锁快照读零写）
    return evs


def _prev_of_log(path):
    """取事件流末事件的 (seq, hash)；空/缺失返回 (0, '')（收编判定与 prev 串链用）。"""
    ep = events_path(path)
    if not os.path.exists(ep):
        return 0, ''
    last = None
    with open(ep, encoding='utf-8', errors='replace') as f:
        for ln in f:
            s = ln.strip()
            if s:
                last = s
    if not last:
        return 0, ''
    try:
        ev = json.loads(last)
        return int(ev.get('seq', 0)), ev.get('hash') or ''
    except Exception:
        return 0, ''  # 残尾：load 已在锁内修复；此处防御性归零


def _append_event(path, ev):
    """追加一个事件（O_APPEND 单行写入 + fsync；锁内串行，残尾由 read_events 崩溃恢复语义兜底）。"""
    ep = events_path(path)
    d = os.path.dirname(ep)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(ep, 'a', encoding='utf-8') as f:
        f.write(json.dumps(ev, ensure_ascii=False) + '\n')
        f.flush()
        os.fsync(f.fileno())


def fold_events(evs):
    """事件折叠：状态 = 逐事件应用 after 快照（任务级全量快照差分，见文件头「事件溯源化核心」）。"""
    state = {'tasks': {}, 'seq': 0, 'revision': 0}
    for ev in evs:
        after = ev.get('after')
        if isinstance(after, dict):
            for tid, t in after.items():
                state['tasks'][tid] = t
        if isinstance(ev.get('board_seq'), int) and not isinstance(ev.get('board_seq'), bool):
            state['seq'] = ev['board_seq']
        if isinstance(ev.get('revision'), int) and not isinstance(ev.get('revision'), bool):
            state['revision'] = ev['revision']
    return state


# 写命令事件上下文：main 派发前武装（pre 快照供差分、并按需充当收编种子），save() 据此落事件。
_EVT_CTX = {'armed': False, 'type': None, 'args': {}, 'pre_tasks': None, 'pre_seq': 0, 'pre_rev': 0, 'ts': 0}


def _event_args(a):
    """事件 args 载荷：记录命令意图（审计用）；状态本体由 after 快照承载。"""
    c = a.cmd
    if c == 'create':
        args = {'title': a.title, 'owner': a.owner or '',
                'dep': [d.strip() for d in (a.dep or '').split(',') if d.strip()],
                'desc': a.desc or '', 'scope': a.scope or '', 'draft': bool(a.draft),
                'kind': getattr(a, 'kind', None)}
        if getattr(a, 'quorum_m', None) is not None:
            args['quorum_m'] = a.quorum_m  # m 票声明随事件留档（未声明=单评审员路径，args 形状与旧版一致）
        if getattr(a, 'created_by', None) is not None:
            # M1 代理 scoped 自建任务：事件流 type=create 携带 created_by（of 一并留档供审计回指）；
            # T6/B1：与入口归一同式 strip——留档值与任务落盘字段一致；lead 派发（不带新参数）
            # args 形状与旧版逐键一致（成功写事件仅产生于归一后非空值的代理创建）
            args['created_by'] = a.created_by.strip()
            args['of'] = (a.of or '').strip()
        if getattr(a, 'tags', None) is not None:
            args['tags'] = _parse_tags(a.tags)  # 能力标签随事件留档（T8；未声明时 args 形状不变）
        return args
    if c == 'claim':
        args = {'owner': a.owner, 'attempt': a.attempt}
        if getattr(a, 'tags', None) is not None:
            args['tags'] = _parse_tags(a.tags)  # claimant 能力声明随事件留档（T8；未声明时形状不变）
        return args
    if c == 'claim_idle':
        args = {'owner': a.owner, 'ids': list(a.ids)}  # 空闲续领原子认领（T39-①）：意图留档，事件 type 仍为 claim
        if getattr(a, 'tags', None) is not None:
            args['tags'] = _parse_tags(a.tags)  # claimant 能力声明随事件留档（T8；未声明时形状不变）
        if getattr(a, 'steal', False):
            args['steal'] = True  # T16：work-stealing 意图留档（previous_owner 由 cmd 携任务数据补挂）
        return args
    if c == 'vote':
        return {'by': a.by, 'score': a.score}
    if c == 'done':
        return {'summary': a.summary or '', 'rework': a.rework, 'switched': a.switched, 'by': a.by,
                'verdict': getattr(a, 'verdict', None), 'findings': getattr(a, 'findings', None),
                'repair_owner': getattr(a, 'repair_owner', None)}
    if c == 'fail':
        return {'reason': a.reason or ''}
    if c == 'progress':
        return {'note': a.note}
    if c == 'heartbeat':
        return {'attempt': a.attempt}
    if c == 'watchdog':
        return {'window_sec': a.window_sec, 'max_nudges': a.max_nudges, 'bus_root': a.bus_root or ''}
    if c == 'reassign':
        return {'attempt_id': a.attempt_id, 'owner': a.owner}
    if c == 'set_dependencies':
        return {'dep': a.dep}
    if c == 'verify':
        return {'files': list(a.files or [])}
    if c == 'own':
        return {'paths': list(a.paths or [])}
    if c == 'budget':
        return {'reset': bool(getattr(a, 'reset', False))}
    if c in ('approve', 'reject'):
        # 方向 4：批准人/否决人声明（--by，板面自报审计面）——仅声明时进入 args
        # （缺省 args 形状与旧版逐键一致 {}）。
        by = (getattr(a, 'by', None) or '').strip()
        return {'by': by} if by else {}
    return {}  # retry/recover 等无附加意图


# 写命令事件上下文：main 派发前武装（pre 快照供差分、并按需充当收编种子），save() 据此落事件。
# 写命令白名单：与 save() 调用方一一对应。读命令（list/show/status/deps/metrics）与
# boards/archive/replay/_hook-check 永不 save，不武装——免去每次读命令两次全量 tasks deepcopy。
_WRITE_CMDS = frozenset(('create', 'claim', 'claim_idle', 'done', 'fail', 'progress', 'recover', 'retry',
                         'reassign', 'set_dependencies', 'verify', 'heartbeat', 'watchdog', 'approve',
                         'reject', 'vote', 'own', 'budget'))


def _arm_event_ctx(a, data):
    """写命令派发前武装事件上下文（pre 快照供差分与按需收编种子），save() 据此落事件；
    白名单外的命令（读命令及 boards/archive/_hook-check/replay）不落事件，跳过武装。
    收编种子按需惰性组装（二轮评审建议3）：pre_tasks 快照本身即种子数据，事件流已有有效事件时
    commit_event 永不需要种子——不再为此对全量 tasks 做第二次深拷贝；日志存在但为空的收编前
    崩溃恢复仍能收编（判定在 commit_event 锁内按 prev_seq 而非文件存在性，无误伤）。"""
    if a.cmd not in _WRITE_CMDS:
        _EVT_CTX.update({'armed': False, 'type': None, 'args': {}, 'pre_tasks': None,
                         'pre_seq': 0, 'pre_rev': 0, 'ts': 0})
        return
    _EVT_CTX.update({
        'armed': True,
        # 事件类型映射：claim_idle 是认领类状态迁移（running），事件 type 沿 'claim'——
        # budget_counts 的事件类型过滤/BUDGET_COUNTED_TYPES 白名单与全部事件流消费方零改动
        # （#20 续领受 #16 预算计数归因不变）；命令意图仍由 args 形状区分（{owner, ids} vs
        # {owner, attempt}，T39-① 审计可辨）。T38-1 无锁 budget 分支不经过本函数（读路径）。
        'type': 'claim' if a.cmd == 'claim_idle' else a.cmd,
        'args': _event_args(a),
        'pre_tasks': copy.deepcopy(data['tasks']),
        'pre_seq': int(data.get('seq', 0)), 'pre_rev': int(data.get('revision', 0)),
        'ts': now_ms(),
    })


def save_view(path, data):
    """折叠视图原子落盘：唯一 tmp（pid+uuid 后缀）+ os.replace（同 v2.6 机制）。须在 board_lock 锁内调用。"""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f'{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def commit_event(path, data):
    """写路径落账：必要时先收编（pre 快照为种子）→ 追加本命令事件（fsync）→ 原子重写折叠视图。
    事件 after=与 pre 快照差分出的变更任务全量快照；revision 随每次写自增（与 v2.6 CAS 语义一致）。"""
    ctx = _EVT_CTX
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    prev_seq, prev_hash = _prev_of_log(path)
    if prev_seq == 0 and (ctx['pre_tasks'] or ctx['pre_seq'] or ctx['pre_rev']):
        # 旧板收编（含「日志文件存在但为空」的收编前崩溃恢复）：以既有折叠状态为种子事件
        #（revision 不自增，数据零丢失；pre_tasks 是武装时的隔离快照，种子与差分共用一份）
        seed = {'seq': 1, 'ts': ctx['ts'], 'type': 'seed',
                'args': {'reason': 'v2.6 旧板收编：以既有折叠状态为种子事件'},
                'after': ctx['pre_tasks'], 'board_seq': ctx['pre_seq'],
                'revision': ctx['pre_rev'], 'prev': ''}
        seed['state_hash'] = _sha_hex(_canonical({'tasks': ctx['pre_tasks'],
                                                  'seq': ctx['pre_seq'],
                                                  'revision': ctx['pre_rev']}))
        seed['hash'] = _event_hash(seed)
        _append_event(path, seed)
        prev_seq, prev_hash = 1, seed['hash']
    new_rev = int(data.get('revision', 0)) + 1
    data['revision'] = new_rev
    pre = ctx.get('pre_tasks') or {}
    after = {tid: t for tid, t in data['tasks'].items() if tid not in pre or pre[tid] != t}
    ev = {'seq': prev_seq + 1, 'ts': ctx['ts'], 'type': ctx['type'], 'args': ctx['args'],
          'after': after, 'board_seq': int(data.get('seq', 0)), 'revision': new_rev, 'prev': prev_hash}
    ev['state_hash'] = _state_hash(data)  # 先算状态 hash，事件 hash 覆盖含 state_hash 的全部其余字段
    ev['hash'] = _event_hash(ev)
    _append_event(path, ev)
    # 簿记同步进内存折叠态（与下方视图文件同源）：--json 信封（_emit）据此读「本次落账后」的
    # event_seq/state_hash——此前仅落视图、内存 data 滞后一写（N2 对账锚点取值修正）。
    data['event_seq'] = ev['seq']
    data['event_state_hash'] = ev['state_hash']
    save_view(path, {'tasks': data['tasks'], 'seq': int(data.get('seq', 0)), 'revision': new_rev,
                     'event_seq': ev['seq'], 'event_state_hash': ev['state_hash']})


def _orphan_log_of_archived(path):
    """旧序 archive 崩溃窗口签名（二轮评审重要-2）：归档区存在与本板同名的归档板文件，其视图含
    事件簿记字段（曾是事件流板）但对应 .events.jsonl 不在归档区——即「板已迁、日志未迁完」的残留
    形态，顶层的孤儿事件日志正是其未迁完的日志；此时板已被收口，孤儿日志不得复活旧板或被续链。
    归档区落点与 cmd_archive 一致（cwd 相对 .expert-taskboards/archive）；无簿记字段的 v2.6 旧归档板
    本就无日志，不算窗口残留（避免误伤「升级前归档 + 活动板视图丢失」的正常崩溃恢复）。
    B4（T10 三轮评审建议-b，T17 收口实施）：归档板 JSON 损坏时原实现 fail-open（continue），孤儿日志
    会按权威静默复活旧板（实测 rc=0）——降级为原文包含 'event_seq' 字面判定（簿记字段名子串；损坏
    JSON 给不出比 json.load 更强的否定证据，宁可误判「有簿记」fail-closed 提示人工核查，也不放行
    跨板劫持）；彻底不可读（权限/IO）才维持原 fail-open（无证据可依，签名本就是纵深防御）。
    匹配面同时覆盖 S4 唯一后缀归档名（<ts>-<板名>.<pid>.<hex>，同秒碰撞归档），其孤儿日志同样不得复活。"""
    arch = os.path.join('.expert-taskboards', 'archive')
    if not os.path.isdir(arch):
        return False
    suffix = '-' + os.path.basename(path)
    try:
        names = os.listdir(arch)
    except OSError:
        return False
    for n in sorted(names):
        if n.endswith('.jsonl') or not (n.endswith(suffix) or (suffix + '.') in n):
            continue
        ap = os.path.join(arch, n)
        if os.path.exists(ap + '.events.jsonl'):
            continue  # 归档板与日志成对在档：正常归档形态，非崩溃窗口
        try:
            with open(ap, encoding='utf-8') as f:
                if 'event_seq' in json.load(f):
                    return True
        except Exception:
            try:
                with open(ap, encoding='utf-8') as f:
                    if 'event_seq' in f.read():
                        return True
            except Exception:
                continue  # 彻底不可读：无证据可依，维持 fail-open（纵深防御的既定极限）
    return False


def load(path, repair=True):
    """加载任务板状态：有事件流 → 折叠（权威）+ 视图对账；无事件流 → v2.6 旧板直读（首次写时收编）。
    视图对账：缺失/落后 → 静默重放重建（崩溃恢复）；手改/损坏 → stderr 报警并按事件流权威重建。
    直读分支两道防线：事件流被清空但视图含簿记 → unrecoverable（防清空日志洗白）；含未知顶层键 →
    unrecoverable（收编早失败）。
    repair=False（v2.9 T3/T38-1 budget 无锁只读快照专用）：读路径零写零 stderr——残尾不修复
    （read_events 同参）、视图缺失/落后/损坏不重建，一律按事件流权威折叠状态返回（stale 容忍：
    并发写命令进行中时，结果=事件流某一完整前缀的折叠，恰为该前缀末事件落账时刻的板状态——
    快照级一致性，至多略滞后，绝无半写状态：事件追加 O_APPEND 单行原子 + 视图 os.replace 原子）。
    错误面（各 unrecoverable 分支）与 repair=True 逐字节一致；缺省 repair=True 行为与旧版一致。"""
    evs = read_events(path, repair=repair)
    if not evs:
        if not os.path.exists(path):
            return {'tasks': {}, 'seq': 0, 'revision': 0}
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            raise _unrecoverable(path, f'JSON 解析失败: {e}')
        if not isinstance(data, dict):
            raise _unrecoverable(path, '结构非法：板文件顶层不是对象')
        if os.path.exists(events_path(path)) and any(k in data for k in BOOKKEEPING_KEYS):
            # 事件流清空即洗白防御（二轮评审重要-1）：簿记字段证明事件流曾有事件，此刻为空只能是被
            # 清空/截断——按旧板直读会对手改视图零告警放行，下次写命令还会以其为种子重新收编（手改
            # 洗白）。合法空日志只出现在收编前（视图必无簿记字段），不误伤崩溃恢复。
            raise _unrecoverable(path, '事件流文件存在但为空，而视图含事件簿记字段 '
                                       f'{list(BOOKKEEPING_KEYS)}——事件流疑似被清空或截断（曾有事件，'
                                       '此时为空必异常）；拒绝按未校验视图直读或重新收编，请从备份恢复事件流')
        unknown = [k for k in data if k != 'tasks' and k != 'seq' and k != 'revision'
                   and k not in BOOKKEEPING_KEYS]
        if unknown:
            # 收编早失败（二轮评审采纳）：未知顶层键放行收编会被折叠模型静默丢弃，错一拍才暴露；
            # 当场具名拒绝并给可读原因（与直读路径的结构校验同位，读命令同样早暴露）。
            raise _unrecoverable(path, f'板文件含未知顶层键 {unknown}（收编前旧板仅允许 '
                                       'tasks/seq/revision+事件簿记字段）；拒绝收编——未知键无法纳入'
                                       '事件折叠与 state_hash 口径，请先人工确认并移除该键')
        data.setdefault('revision', 0)  # 旧板无 revision 字段兼容
        _validate_board(data, path)
        return data
    state = fold_events(evs)
    _validate_board(state, path)
    last = evs[-1]
    actual = _state_hash(state)
    if last.get('state_hash') != actual:
        raise _unrecoverable(path, '事件流折叠校验失败：末事件 state_hash 与重放结果不一致')
    state['event_seq'] = int(last.get('seq', 0))
    state['event_state_hash'] = last.get('state_hash')
    v, v_exists = None, os.path.exists(path)
    if v_exists:
        try:
            with open(path, encoding='utf-8') as f:
                v = json.load(f)
        except Exception:
            v = None
    if v is None:
        if v_exists:  # 视图在但解析失败（外部损坏；崩溃不会产生半写视图——os.replace 原子）
            if repair:
                print(f'警告：任务板状态文件损坏（JSON 解析失败），已按事件流（权威）重放重建折叠状态: {path}',
                      file=sys.stderr)
        elif _orphan_log_of_archived(path):
            # archive 崩溃窗口防御（二轮评审重要-2）：板文件缺失而事件流在，且归档区有同名板的
            # 「有簿记、无日志」残留——顶层事件流是归档迁移未完成的孤儿日志，板已被收口；放行则
            # 读命令按孤儿日志静默复活旧板、同名 create 续链（跨板劫持）。拒绝并提示人工核查。
            # （视图意外丢失的正常崩溃恢复无此归档签名，仍走下方静默重建，不误伤。）
            raise _unrecoverable(path, '板文件缺失但事件流存在，且归档区存在同名归档板的孤儿日志残留'
                                       '（疑似 archive 迁移中断的崩溃窗口终态）；拒绝按孤儿事件流复活'
                                       '旧板或续链，请人工核查归档区与事件流后再处理')
        if repair:
            save_view(path, state)  # 视图整体丢失属崩溃恢复，静默重建
        return state
    vseq = v.get('event_seq')
    if isinstance(vseq, int) and not isinstance(vseq, bool) and vseq > state['event_seq']:
        # A3（T10 三轮评审建议-a，T17 收口升格 unrecoverable）：视图自称 event_seq 大于事件流末 seq
        # ——尾部事件丢失的强证据。写路径先追加日志（fsync）后写视图，崩溃只产生「视图落后」，绝不
        # 产生「视图超前」；超前只能来自事件流被外部截断/丢失。原实现落入通用手改分支仅 stderr 告警
        # 并按截短日志回滚重建（fail-loud 但已落账命令被静默回滚）——与空日志防御（i1 洗白封死）对齐
        # 升格为 unrecoverable，迫使人工介入从备份恢复，绝不静默回滚到更早状态。
        raise _unrecoverable(path, f'视图 event_seq={vseq} 大于事件流末 seq={state["event_seq"]}——'
                                   '事件流尾部疑似被外部截断或丢失（崩溃间隙只可能视图落后，不可能视图超前）；'
                                   '拒绝按截短事件流回滚重建（已落账命令不得静默回滚），请从备份恢复事件流后人工核对')
    if _state_hash(v) == actual and vseq == state['event_seq']:
        return state  # 干净快路径：视图与事件流一致
    if isinstance(vseq, int) and not isinstance(vseq, bool) and vseq < state['event_seq']:
        # 崩溃间隙：事件已追加、视图未及写——静默重放（不报警）。诊断补充（二轮评审建议2）：
        # 视图自称 event_seq=vseq，其内容 hash 应与第 vseq 个事件的 state_hash 一致；失配说明视图
        # 内容曾被外部改动（而非单纯落后），stderr 补一条提示——重建行为不变，只补可观测性。
        ref = evs[vseq - 1].get('state_hash') if 0 < vseq <= len(evs) else None
        if repair:
            if ref is not None and _state_hash(v) != ref:
                print(f'提示：任务板视图落后于事件流且内容校验失配（疑似视图曾被外部改动），已按事件流重放重建: {path}',
                      file=sys.stderr)
            save_view(path, state)  # 崩溃间隙：事件已追加、视图未及写——静默重放（不报警）
        return state
    if not any(k in v for k in BOOKKEEPING_KEYS) and _state_hash(v) == actual:
        # 旧板收编崩溃间隙：种子事件已追加、视图未及写，仍是收编前的 v2.6 原生板（无簿记字段）。
        # 内容与折叠权威逐字段一致 → 与上一分支同语义，静默重建（不报警）；缺簿记但内容不一致
        # 的真实手改不豁免，仍落入下方报警分支。
        if repair:
            save_view(path, state)
        return state
    if repair:
        print(f'警告：任务板状态文件校验不一致（疑似手改或外部修改），已按事件流（权威）重放重建折叠状态: {path}',
              file=sys.stderr)
        save_view(path, state)
    return state


def save(path, data):
    """命令写路径（须在 board_lock 锁内调用）：armed 时落成事件（追加事件流 + 原子重写视图）；
    未武装的防御路径退化为 v2.6 直写（revision 自增 + 原子替换）。"""
    if _EVT_CTX.get('armed'):
        commit_event(path, data)
        return
    data['revision'] = int(data.get('revision', 0)) + 1
    save_view(path, data)


def check_revision(a, data):
    """CAS 乐观锁：写命令带 --expected-revision 时校验；不符则具名拒绝，不落盘。"""
    er = getattr(a, 'expected_revision', None)
    cur = int(data.get('revision', 0))
    if er is not None and er != cur:
        raise BoardError('stale_revision', expected=er, current=cur,
                         hint='任务板已被并发写入；重新读取（读命令末行 revision=N）后携带最新 revision 重试')


_UNSET = object()  # T14：显式「未传 caller」标记（区别于显式传 None=调用方无身份可核）


def check_attempt(a, t, caller=_UNSET):
    """attempt 代际校验（带 --attempt 的 fail-closed 门，供各写命令单点复用）：
    不带 --attempt 不校验（向后兼容，行为与旧版一致）；带 --attempt 时 fail closed——
    任务无开放代际 → no_attempt；attempt 已撤销 → stale_attempt（revoked）；非当前代际 → stale_attempt。
    T14 代际 owner 绑定（env DSH_EXPERT_ATTEMPT_BIND_OWNER 缺省关闭）：字段 attempt_owner 存在且
    调用方声明身份不符 → attempt_owner_mismatch。绑定校验的有效覆盖=done --by/vote --by/reassign
    持证明通道（这些路径有身份可核）；fail/progress/own/heartbeat 解析器无身份参数（caller 恒
    None）→ 绑定校验对这些命令恒 no-op——未声明身份不可核不拒（R1），非「自动获得执法」。
    claim --attempt 是合法接管面：绑定随落定 owner 翻新并在事件 args 显式留痕 attempt_owner_prev
    （T20🟡1 对称化），与汇报面 mismatch 拒的区别是接管语义而非绕过。"""
    att = getattr(a, 'attempt', None)
    if att is None:
        return
    cur = t.get('attempt_id')
    revoked = t.get('attempt_revoked') or []
    if att in revoked:
        raise BoardError('stale_attempt', attempt=att, current=cur, revoked=revoked,
                         hint='该 attempt 已被撤销，不能用于汇报；向编排者确认最新 attempt_id')
    if not cur:
        raise BoardError('no_attempt', attempt=att,
                         hint='该任务没有开放的派工代际；先由编排者 claim --attempt / reassign 建立代际，或省略 --attempt（与旧版一致）')
    if att != cur:
        raise BoardError('stale_attempt', attempt=att, current=cur,
                         revoked=revoked,
                         hint='该任务已转派到新代际；向编排者确认最新 attempt_id，或重新领取')
    # ── T14 代际 owner 绑定校验（Q2）：env 开启且任务落有 attempt_owner 字段（旧板无字段
    # 自动回退旧行为）时，调用方声明身份与代际绑定不符 → 具名拒 attempt_owner_mismatch。
    # 判定先于任何变更与 save（零写零事件）；未声明身份不可核不拒；绑定与申报均为板面自报，
    # R1 板内一致性校验防误用非防伪造。
    bound = t.get('attempt_owner')
    if bound and _attempt_bind_enforced():
        if caller is _UNSET:
            caller = getattr(a, 'by', None) or getattr(a, 'owner', None)
        if caller and caller != bound:
            raise BoardError('attempt_owner_mismatch', attempt=att, attempt_owner=bound,
                             declared=caller,
                             hint='该代际绑定 owner 与申报身份不符；向编排者确认身份或最新代际'
                                  '（探针：show --json 的 attempt_owner 字段）')


def find_cycle(graph):
    """graph: id -> dep 列表（id 依赖 dep）；返回环路径如 ['A','B','C','A']，无环返回 None。"""
    color = {u: 0 for u in graph}  # 0=未访 1=在栈 2=完成

    def dfs(u, stack):
        color[u] = 1
        stack.append(u)
        for v in graph[u]:
            if v not in graph:
                continue
            if color[v] == 1:
                return stack[stack.index(v):] + [v]
            if color[v] == 0:
                c = dfs(v, stack)
                if c:
                    return c
        stack.pop()
        color[u] = 2
        return None

    for u in graph:
        if color[u] == 0:
            c = dfs(u, [])
            if c:
                return c
    return None


def ensure_acyclic(tasks, extra_id, extra_deps):
    """依赖写入前全图环检测：extra_id/extra_deps 为拟写入的边。"""
    graph = {tid: list(t['dep']) for tid, t in tasks.items()}
    graph[extra_id] = list(extra_deps)
    cycle = find_cycle(graph)
    if cycle:
        raise BoardError('dependency_cycle', cycle='->'.join(cycle),
                         hint=f'拒绝写入：{extra_id} 的新依赖构成环；先调整依赖再写入')


def deps_state(task, tasks):
    missing = [d for d in task['dep'] if d not in tasks]
    if missing:
        return False, '缺失依赖: ' + ','.join(missing)
    un = [d for d in task['dep'] if tasks[d]['status'] != 'done']
    return (not un), ('等待: ' + ','.join(un) if un else '')


def refresh(data):
    promoted = []
    for t in data['tasks'].values():
        if t['status'] == 'pending':
            ok, _ = deps_state(t, data['tasks'])
            if ok:
                t['status'] = 'ready'
                t['updated'] = now_ms()
                promoted.append(t['id'])
    return promoted


def get_task(data, tid):
    t = data['tasks'].get(tid)
    if not t:
        sys.exit(f"错误：任务 {tid} 不存在")
    return t


# ── 验证回执范围指纹（v2.6）：逐文件 SHA-256 整表 hash 存板，文件一变回执即 stale ──
TASK_ID_RE = re.compile(r'(?<![A-Za-z0-9_/.-])T(\d+)(?![0-9])')  # 独立 token 形态，排除路径片段（build/T3）与更长数字


def parse_task_ids(text):
    """从文本解析独立 token 形态的任务 id（去重保序）；路径形态与更长数字不解析。"""
    seen, out = set(), []
    for m in TASK_ID_RE.finditer(text):
        tid = 'T' + (m.group(1).lstrip('0') or '0')
        if tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out


def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def _verify_digest(files):
    """整表 digest：排序后逐行 'path  sha256' 再整体 SHA-256（与文件集合顺序无关，确定可复算）。"""
    lines = ''.join(f'{p}  {h}\n' for p, h in sorted(files.items()))
    return hashlib.sha256(lines.encode('utf-8')).hexdigest()


def verify_status(t, cwd=None):
    """重算验证回执：返回 (state, changed, missing)。state ∈ 'none'|'fresh'|'stale'。"""
    rec = t.get('verify')
    if not rec:
        return 'none', [], []
    cwd = cwd or os.getcwd()
    cur, missing = {}, []
    for p in rec.get('files', {}):
        full = p if os.path.isabs(p) else os.path.join(cwd, p)
        if os.path.isfile(full):
            cur[p] = _sha256_file(full)
        else:
            missing.append(p)
    changed = sorted(p for p, h in cur.items() if rec['files'].get(p) != h) + [f'{p}（缺失）' for p in missing]
    state = 'fresh' if not changed else 'stale'
    return state, changed, missing


def cmd_verify(a, data, path):
    """verify <id> <文件...>：记录验证回执指纹；verify <id>：重算并输出 fresh/stale。"""
    t = get_task(data, a.id)
    if a.files and t['status'] in ('draft', 'rejected', 'escalated'):
        # 建议①（T19 回炉）：草案/终态/升级待处置无验证交付面——写回执路径与 progress/reassign 守卫
        # 对齐（escalated 面不再有可写残余）；读路径（重算 fresh/stale）不受影响，供处置时诊断。
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，不可写验证回执")
    if a.files:
        rels = []
        for f in a.files:
            full = f if os.path.isabs(f) else os.path.join(os.getcwd(), f)
            if not os.path.isfile(full):
                sys.exit(f'错误：文件不存在或不是普通文件：{f}')
            rels.append(os.path.relpath(full, os.getcwd()))
        files = {p: _sha256_file(p if os.path.isabs(p) else os.path.join(os.getcwd(), p)) for p in rels}
        t['verify'] = {'files': files, 'digest': _verify_digest(files), 'time': now_ms()}
        t['updated'] = now_ms()
        save(path, data)
        print(f"{a.id} 验证回执已记录（{len(files)} 文件，digest={t['verify']['digest'][:16]}）")
        print(f"  状态: fresh")
        return
    if not t.get('verify'):
        sys.exit(f'错误：{a.id} 没有验证回执；先用 verify {a.id} <文件...> 记录文件清单指纹')
    state, changed, _ = verify_status(t)
    print(f"{a.id} 验证回执: {state}")
    if state == 'stale':
        print(f'  文件已变更: {", ".join(changed)}')
        print('  旧验证/旧评审自动失效；重新 verify 后再交付')



def show(t):
    dep = (' dep=' + ','.join(t['dep'])) if t['dep'] else ''
    owner = (f" owner={t['owner']}") if t['owner'] else ''
    scope = (' scope=' + ','.join(t['scope'])) if t.get('scope') else ''
    kind = (f" kind={t['kind']}") if t.get('kind') else ''  # 缺省任务不带 kind 字段（行为不变）
    cby = (f" created_by={t['created_by']}") if t.get('created_by') else ''  # M1：仅代理自建任务携带
    tags = (f" tags={','.join(t['tags'])}") if t.get('tags') else ''  # T8：仅带 tags 字段的任务携带（缺省输出零变化）
    print(f"{t['id']} [{t['status']}] {t['title']}{owner}{dep}{scope}{kind}{cby}{tags}")
    if t.get('artifacts'):
        print(f"  工件归属: {', '.join(t['artifacts'])}")


# 终态集合（工件归属让位判定用）：终态任务的旧归属不再阻止新任务登记同一工件
# ——返工/repair 重开同一工件是正常路径（expert-team「创建放行」语义在任务级投影）。
TERMINAL_STATUSES = ('done', 'failed', 'rejected', 'escalated')


def cmd_own(a, data, path):
    """own <id> <path>...：工件归属门禁（#22，T26）——任务级工件归属台账 + 冲突拒绝。
    判据对齐 expert-team artifact-ownership（调研 C-expert-team-swarm R1：「创建放行 /
    覆写非负责人工件当场 deny」在任务级投影）：路径未被其他**开放**任务持有 → 记归属
    放行；已被其他开放任务（pending/ready/running）持有 → 具名拒绝 artifact_owned
    （零事件零落盘），报错含持有者任务与状态；终态任务（TERMINAL_STATUSES）的旧归属
    自动让位；本任务重复 own 同一路径幂等（重入放行）。路径为声明意图（文件/目录均可，
    不要求已存在——「创建放行」），不做存在性查询。TASKBOARD_DISABLE_OWNERSHIP 显式
    关闭冲突拒绝（stderr 告警放行只记录——逃生口，与 TASKBOARD_DISABLE_FLOCK 同惯例）。
    --attempt 走既有代际校验（不带不校验，与 progress 同口径）；--expected-revision CAS
    照常共存。"""
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] in ('draft', 'rejected', 'escalated', 'done', 'failed'):
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，工件归属登记仅接受 pending/ready/running")
    paths = []
    for p in a.paths:
        p = p.strip()
        if p and p not in paths:
            paths.append(p)
    if not paths:
        sys.exit('错误：至少需要一个工件路径')
    owned = {}
    for other_id, other in data['tasks'].items():
        if other_id == a.id or other['status'] in TERMINAL_STATUSES:
            continue
        for p in (other.get('artifacts') or []):
            owned.setdefault(p, []).append(other_id)
    conflicts = {p: owned[p] for p in paths if p in owned}
    if conflicts:
        if os.environ.get('TASKBOARD_DISABLE_OWNERSHIP'):
            print('工件归属门禁告警：TASKBOARD_DISABLE_OWNERSHIP 已关闭冲突拒绝，本次仅登记不校验（恢复口，用后请移除）',
                  file=sys.stderr)
        else:
            detail = '；'.join(f"{p} ← 已被 {','.join(ids)} 登记" for p, ids in sorted(conflicts.items()))
            raise BoardError('artifact_owned', task=a.id, conflicts=detail,
                             hint='工件已被其他开放任务登记归属：等其收口后重登记，或把该工件划入在持任务处理')
    arts = t.get('artifacts') or []
    t['artifacts'] = arts + [p for p in paths if p not in arts]
    t['updated'] = now_ms()
    save(path, data)
    show(t)


def _parse_tags(raw):
    """--tags 逗号分隔解析（T8）：raw=None（未声明）→ None；逐项 strip、去空、保序去重。
    显式给参但解析为空（空串/纯逗号/纯空白）→ sys.exit 拒绝（宁拒勿错：空声明与未声明
    语义不同，前者是「声明了自己没有任何能力」，静默归一成未声明会掩盖调用方笔误）。
    该函数也被 _event_args 复用（事件留档值与落盘字段同一实现，杜绝双解析漂移）。"""
    if raw is None:
        return None
    tags = []
    for s in raw.split(','):
        s = s.strip()
        if s and s not in tags:
            tags.append(s)
    if not tags:
        sys.exit('错误：--tags 须为至少一个非空标签（逗号分隔，如 "a,b"）；空串/纯逗号视同无效参数')
    return tags


# _CREATE_EVAL 为 cmd_create → _structured_data 的 --json data 载荷进程内暂存（_WATCHDOG_EVAL/
# _BUDGET_EVAL 同模式）：create 无 id 参数，--json 载荷此前为空对象——暴露面审计（exposure-
# crypto-trust 报告 N2）要求写面回执带创建后任务快照（含 refresh 提升后的最终状态），外部
# 调用方（MCP/A2A 写面）据此回显审计行。拒绝路径（任一门禁 sys.exit/BoardError）先于暂存
# 发生，载荷保持空对象=「零写零事件」如实反映。
_CREATE_EVAL = {'task': None}


def cmd_create(a, data, path):
    if a.kind and a.kind != 'review':
        sys.exit(f"错误：--kind 仅支持 review（得到 {a.kind!r}）；m 票共识等其余 kind 由后续版本提供")
    if getattr(a, 'quorum_m', None) is not None:
        if a.kind != 'review':
            sys.exit('错误：--quorum-m 仅支持 review kind 任务（m 票布尔共识陪审团规模）')
        if a.quorum_m < 1:
            sys.exit('错误：--quorum-m 须为 ≥1 的整数（裸声明即默认陪审团 m=3；m=1 单评审员路径无需声明）')
    tags = _parse_tags(getattr(a, 'tags', None))  # T8 能力标签：空/无效声明在此具名拒绝（任何写发生之前）
    # ── 代理 scoped 自建任务（M1）：校验链按序执行，任一不过具名拒绝零事件零落盘 ──
    # T6/B1：入口归一——--created-by 与 --of 同式 strip()，空串/纯空白视作缺参（None）；
    # 成对性校验在归一后进行：只给其一、或给空串/空白，一律同一具名成对错误拒绝（杜绝
    # --created-by "" 以 ''=='' 恒过无主父任务认领核实、且空串经 UI 归一伪装 lead 草稿）。
    created_by = getattr(a, 'created_by', None)
    of_id = getattr(a, 'of', None)
    raw_provided = created_by is not None or of_id is not None
    created_by = created_by.strip() or None if created_by is not None else None
    of_id = of_id.strip() or None if of_id is not None else None
    if raw_provided and (created_by is None or of_id is None):
        raise BoardError('created_by_of_pair_required',
                         hint='--created-by 与 --of 必须成对出现且均为非空白值（代理 scoped 自建任务）；'
                              '空串/纯空白视同缺参；lead 派发两者均不携带，行为不变')
    agent_create = created_by is not None
    # T15：--auto-ready 仅支持代理自建路径（lead 派发缺省创建本就 pending/依赖满足即 ready，
    # 无审批面可跳过）；与 --draft 互斥（前者免审直达 ready，后者进待批面，语义相反）。
    auto_ready = bool(getattr(a, 'auto_ready', False))
    if auto_ready and not agent_create:
        sys.exit('错误：--auto-ready 仅支持代理自建路径（须成对携带 --created-by/--of）；'
                 'lead 派发创建缺省即 pending/自动提升 ready，无审批面可跳过')
    if auto_ready and a.draft:
        sys.exit('错误：--draft 与 --auto-ready 互斥（前者进入待批面，后者免审直达 ready）')
    if agent_create:
        # ① 认领关系核实：--of 任务须存在于本板且其 owner == --created-by
        parent = data['tasks'].get(of_id)
        if parent is None or parent.get('owner') != created_by:
            raise BoardError('not_task_owner', of=of_id,
                             owner=parent.get('owner') if parent else None,
                             created_by=created_by,
                             hint='--of 指向任务须存在于本板且其 owner == --created-by（认领关系核实）')
        # ② scope 越权：新任务 scope 逐项 ⊆ --of 任务 scope（复用 _scope_match 语义）
        parent_scope = parent.get('scope') or []
        agent_scope = [s.strip().rstrip('/') for s in (a.scope or '').split(',') if s.strip()]
        if not agent_scope:
            # T6/I1：拒绝空/缺 scope——无 scope 任务 approve 后被 commit 引用时门禁第三查对范围
            # fail-open（跳过范围检查），「无 scope」比越权 scope 更宽；不继承父 scope，保持显式性
            raise BoardError('agent_create_requires_scope', of=of_id,
                             hint='代理创建必须显式携带非空 --scope（逗号分隔，逐项须落在 --of 任务 scope 内；'
                                  '不继承父 scope）')
        out_of = [s for s in agent_scope if not _scope_match(s, parent_scope)]
        if out_of:
            raise BoardError('scope_out_of_violation', of=of_id, scope=out_of,
                             parent_scope=parent_scope,
                             hint='代理创建任务的 write_scopes 逐项须落在 --of 任务的 scope 内')
        # ③ 代理创建强制 draft：不接受 --draft 之外的显式状态（缺 --draft 即非 draft 意图，拒绝）；
        # T15：--auto-ready 显式声明免审意图（⑥⑦⑧ 前置全过后直达 ready）时豁免本条——
        # 免审面本身即显式声明，仍缺 scope/挂错父任务等 ①②④⑤ 不豁免
        if not a.draft and not auto_ready:
            raise BoardError('agent_create_requires_draft',
                             hint='代理创建强制 status=draft：须携带 --draft 进入待批面（approve/reject 既有语义）')
        # ④ kind 允许面=缺省 kind（follow-up 语义）：--kind 与代理创建同传具名拒绝（Q5 裁决）
        if a.kind:
            raise BoardError('agent_create_kind_rejected', kind=a.kind,
                             hint='代理创建仅允许缺省 kind（follow-up 语义）；--kind review 与代理创建互斥')
        # ⑤ owner 一致性（T6/I2）：代理创建强制自建自领——显式 --owner 必须等于 --created-by，
        # 杜绝预派他人任务绕过认领竞争语义；--owner 缺省/空串不落 owner（claim 时再定，行为不变）
        if a.owner and a.owner != created_by:
            raise BoardError('agent_owner_mismatch', owner=a.owner, created_by=created_by,
                             hint='代理创建强制 owner == created-by（自建自领）；给他人派任务请走 lead 派发路径')
    deps = [d.strip() for d in (a.dep or '').split(',') if d.strip()]
    for d in deps:
        if d not in data['tasks']:
            sys.exit(f"错误：依赖任务 {d} 不存在")
    # ── T15 受限免审批创建（--auto-ready，Q2 显式参数裁决）：⑥⑦⑧ 前置全过 → 直达 ready；
    # 任一不过具名拒（零写零事件），hint 指路去掉 --auto-ready 回 draft 待批旧路径。
    # Q3 裁决：⑥ open 上限前置恒生效，不依赖 T13 执法开关 DSH_EXPERT_ANTISTORM_ENFORCE
    # （阈值仍读 DSH_EXPERT_PEER_OPEN_CAP，缺省 2；非法值宁拒勿猜不回落）。
    # 判定先于任何变更与 save：本块在 tid 分配/任务写入/事件落账之前执行，拒绝路径全板零变更。
    auto_ready_ev = None
    if agent_create and auto_ready:
        # ⑥ created_by open 计数 < cap（open-counts 同口径 _OPEN_STATUSES；本任务创建后即归属
        # created_by 名下 open，故按 pre+1 与上限比较）
        cap = _env_positive_int(_PEER_OPEN_CAP_ENV, _OPEN_CAP_DEFAULT)
        open_pre = len(_count_open_tasks(data, created_by))
        if open_pre + 1 > cap:
            raise BoardError('agent_create_open_cap', created_by=created_by,
                             open_count=open_pre, cap=cap,
                             hint='created_by 名下 open 任务数+本次创建将超过上限（探针：taskboard.py '
                                  'open-counts <created_by> 核查）；先收口在途任务，或去掉 --auto-ready '
                                  '回 draft 待批路径（approve 面另有 T13 执法兜底）')
        # ⑦ --of 父任务须 open（draft/pending/ready/running）：终态=完成面，免审链不可挂靠
        parent_status = parent.get('status')
        if parent_status not in _OPEN_STATUSES:
            raise BoardError('agent_create_parent_closed', of=of_id, parent_status=parent_status,
                             hint='--of 父任务已终态，免审批链不可挂靠终态父任务；去掉 --auto-ready '
                                  '回 draft 待批路径，由 lead 审批后另行规划')
        # ⑧ dep 全部为本人名下任务：跨 owner 依赖=借他人任务做闸门，涉及他人任务面，须走审批面裁决
        cross = [d for d in deps if (data['tasks'][d].get('owner') or '') != created_by]
        if cross:
            raise BoardError('agent_create_dep_cross_owner', created_by=created_by, dep=cross,
                             hint='--auto-ready 要求全部依赖任务为 created_by 本人名下（跨 owner 依赖'
                                  '涉及他人任务闸门，须走 draft 审批面裁决）；去掉 --auto-ready 回 draft '
                                  '待批路径')
        # ⑧'（T22 修复裁定①：⑧ 加严为 dep 全部本人名下且全部 done）——「ready 蕴含依赖已满足」
        # 不变量在 deps_state/refresh（:926-944）与 claim 门（:1332）被主动维持，--auto-ready
        # 直达 ready 不得绕过；否则产出「ready 但依赖未满足」任务可被第三方认领。任一 dep 非
        # done 具名拒 agent_create_dep_open，不静默降级 draft（行为可预期优先）。
        open_dep = [d for d in deps if data['tasks'][d].get('status') != 'done']
        if open_dep:
            raise BoardError('agent_create_dep_open', created_by=created_by, dep=open_dep,
                             dep_status={d: data['tasks'][d].get('status') for d in open_dep},
                             hint='--auto-ready 要求全部依赖任务已 done（ready 蕴含依赖已满足，'
                                  '未完成依赖不可免审直达 ready）；先完成依赖任务，或去掉 --auto-ready '
                                  '回 draft 待批路径')
        auto_ready_ev = {'open_pre': open_pre, 'cap': cap, 'parent_status': parent_status}
    scope = [s.strip().rstrip('/') for s in (a.scope or '').split(',') if s.strip()]
    tid = f"T{data['seq'] + 1}"
    ensure_acyclic(data['tasks'], tid, deps)  # 全图环检测（写入前）
    data['seq'] += 1
    data['tasks'][tid] = {
        'id': tid, 'title': a.title, 'owner': a.owner or '', 'dep': deps,
        'desc': a.desc or '',
        'status': 'ready' if auto_ready_ev else ('draft' if a.draft else 'pending'),
        'created': now_ms(),
        'updated': now_ms(), 'summary': '', 'fail': '',
    }
    if scope:
        data['tasks'][tid]['scope'] = scope
    if a.kind:
        data['tasks'][tid]['kind'] = a.kind  # review kind：完成走 --verdict 分叉（缺省不带该字段）
    if getattr(a, 'quorum_m', None) is not None:
        data['tasks'][tid]['quorum_m'] = a.quorum_m  # m 票陪审团规模（缺省不带该字段=单评审员路径）
    if agent_create:
        data['tasks'][tid]['created_by'] = created_by  # M1：单键字符串字段（lead 派发不落此字段）
    if tags:
        data['tasks'][tid]['tags'] = tags  # T8 能力标签（缺省不落 tags 字段=输出逐字节不变）
    if auto_ready_ev:
        # T15：免审证据 checkpoint 注记可审计（注记非契约，如实声明口径）
        data['tasks'][tid].setdefault('checkpoints', []).append({
            'time': now_ms(),
            'note': f"免审批创建（--auto-ready）：M1 链①-⑤+⑥⑦⑧全过；created_by={created_by} "
                    f"open_count={auto_ready_ev['open_pre']}（创建后 {auto_ready_ev['open_pre'] + 1} ≤ "
                    f"cap={auto_ready_ev['cap']}）；父 {of_id} 状态 {auto_ready_ev['parent_status']}；"
                    f"dep 全部本人名下且已 done（{' '.join(deps) if deps else '无依赖'}）——免审证据可审计",
        })
        if _EVT_CTX.get('armed'):
            # T15：单事件 type=create 不变，args 增免审证据（open_count=前置判定时 pre 计数）
            _EVT_CTX['args']['auto_ready'] = True
            _EVT_CTX['args']['open_count'] = auto_ready_ev['open_pre']
    promoted = refresh(data)
    save(path, data)
    _CREATE_EVAL['task'] = data['tasks'][tid]  # --json 载荷暂存（save 后取最终态：pending 已提升则记 ready）
    show(data['tasks'][tid])
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


def cmd_list(a, data, _):
    if not data['tasks']:
        print('（任务板为空）')
        return
    for tid in sorted(data['tasks'], key=lambda x: int(x[1:])):
        show(data['tasks'][tid])


def last_checkpoint(t):
    """取最新检查点；旧板条目无 checkpoints 字段时返回 None。"""
    cps = t.get('checkpoints') or []
    return cps[-1] if cps else None


def cmd_show(a, data, _):
    t = get_task(data, a.id)
    show(t)
    if t.get('attempt_id'):  # T7：代际回显供抄入下游任务书；无代际任务输出零变化（show(t) 八命令共用展示不加行，保逐字节兼容）
        print(f"  当前代际: {t['attempt_id']}")
    if t['desc']:
        print(f"  完成标准: {t['desc']}")
    if t.get('kind'):
        extra = f"（repair_of={t['repair_of']}）" if t.get('repair_of') else ''
        print(f"  kind: {t['kind']}{extra}")
    if _mvote_active(t):
        p, f, ab = _vote_tally(t)
        detail = '；'.join(f"{v.get('by')}:{v.get('score'):g}" for v in (t.get('votes') or []))
        print(f"  m 票评审: m={t['quorum_m']}，第 {t.get('vote_round') or 1} 轮；"
              f"票箱 pass {p}/fail {f}/弃权 {ab}" + (f"（{detail}）" if detail else '（空）'))
    if t.get('verdict'):
        if t['verdict'] == 'pass' and t.get('findings'):
            # 建议②（T19 回炉）：pass 后不再显示旧 findings（消除「通过却挂着发现」的矛盾展示）；
            # 数据与事件流不动——findings 永存事件流可追溯，仅展示层修正。
            print('  评审结论: pass（已通过，历史 findings 归档）')
        else:
            line = f"  评审结论: {t['verdict']}"
            if t.get('findings'):
                line += f"；findings: {t['findings']}"
            print(line)
    if t.get('repair_count'):
        if _mvote_active(t):
            print(f"  评审轮次: {t['repair_count']}/{REVIEW_ROUND_LIMIT}")  # m 票路径轮次上限标签
        else:
            print(f"  repair 重试: {t['repair_count']}/{REPAIR_RETRY_LIMIT}")
    if t['summary']:
        print(f"  结果: {t['summary']}")
    if t['fail']:
        print(f"  失败原因: {t['fail']}")
    cp = last_checkpoint(t)
    if cp:
        n = len(t.get('checkpoints') or [])
        print(f"  最新检查点({n}): [{cp['time']}] {cp['note']}")
    rework = t.get('rework') or 0
    switched = t.get('switched') or False
    if rework or switched:
        print(f"  返工 {rework} 次" + ('，已换人' if switched else ''))
    exs = t.get('executors') or []
    if exs:
        print('  实际执行者: ' + ', '.join(f"{e['name']}[{e['time']}]" for e in exs))
    if t.get('verify'):
        state, changed, _ = verify_status(t)
        n = len(t['verify'].get('files') or {})
        print(f"  验证回执: {state}（{n} 文件，digest={t['verify']['digest'][:16]}）")
        if state == 'stale':
            print(f'    文件已变更（旧验证/评审失效）: {", ".join(changed)}')
    ok, why = deps_state(t, data['tasks'])
    if t['dep'] and not ok:
        print(f"  依赖未满足（{why}）")


def cmd_claim(a, data, path):
    t = get_task(data, a.id)
    if t['status'] == 'draft':
        # WP-5/S1 批准前零 spawn 工具级执法：draft 未批准不进派工面（拒绝零事件零落盘——
        # sys.exit 发生在任何变更与 save 之前）。
        sys.exit(f"错误：{a.id} 为 PM 规划草案（draft），未经 approve 批准不可认领")
    if t['status'] == 'escalated':
        # WP-5/S2 escalated 终态：交回用户处置，不可认领（用户显式 retry 是唯一工具内出口）
        sys.exit(f"错误：{a.id} 已升级（escalated），等待用户处置，不可认领；用户显式 retry 可解除升级")
    if t['status'] != 'ready':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 ready 可认领")
    # ── T8 能力标签门：任务带 tags 须与 claimant 声明有交集才可认领（宁拒勿猜 Q3）──
    # 任务带 tags 而声明缺失 → 拒（不猜 claimant 能力面）；无交集 → 拒；任务无 tags → 任何
    # 认领不受影响（向后兼容）。拒绝发生在任何变更与 save 之前（零写零事件）。
    # 与 M1 校验链（--created-by/--of，作用于 create 面）正交，tags 不参与 scope 校验。
    ttags = t.get('tags') or []
    if ttags:
        ct = _parse_tags(getattr(a, 'tags', None))
        if ct is None or not (set(ct) & set(ttags)):
            raise BoardError('tag_mismatch', task_tags=ttags, claimant_tags=ct,
                             hint='任务带能力标签，claimant 须用 --tags 声明至少一个交集标签才可认领'
                                  '（宁拒勿猜：不声明即拒）；任务无 tags 时任何认领不受影响')
    # ── T13 反风暴 open 上限执法（Q7）：认领方（--owner 自报身份，R1 防误用非防伪造）名下
    # open 任务总数在本次认领完成后不得超过 DSH_EXPERT_PEER_OPEN_CAP（缺省 2）；超限具名拒
    # open_cap_exceeded，判定先于任何变更与 save（零写零事件）。不带 --owner 无认领方身份
    # 可核，不执法；缺省关闭零行为变化。
    # T20🟢4：claim 入口 owner strip（与 claim_idle/cmd_open_counts 探针同口径），纯空白视为
    # 未声明——同一身份带空格写法不再在执法计数与落档间分裂出两个身份。
    owner = (a.owner or '').strip() or None
    if owner:
        _check_open_cap(owner, data, acquiring_task_id=a.id)
    prev_bound = t.get('attempt_owner')  # T20🟡1：旧绑定捕获（判定先于任何变更，纯读）
    if a.attempt:
        if a.attempt in (t.get('attempt_revoked') or []):
            raise BoardError('stale_attempt', attempt=a.attempt, current=t.get('attempt_id'),
                             revoked=t.get('attempt_revoked') or [],
                             hint='该 attempt 已被撤销，不能重新启用；请使用编排者下发的新 attempt_id')
        old = t.get('attempt_id')
        if old and old != a.attempt:
            t.setdefault('attempt_revoked', []).append(old)  # 转派即撤销旧代际
        t['attempt_id'] = a.attempt
        _reset_nudges(t)  # 新代际=新起点：旧代积攒的未响应 nudge 不带入（watchdog 从头计窗）
        t.pop('heartbeat_at', None)
    t['status'] = 'running'
    if owner:
        t['owner'] = owner
    # ── T14 代际 owner 绑定（Q2）：claim --attempt 建/续代际时落 attempt_owner=落定 owner，
    # 并随事件 args 留痕；env DSH_EXPERT_ATTEMPT_BIND_OWNER 关闭不落字段不写 args（逐字节一致）。
    # T20🟡1 对称化：绑定已存在且本次翻新为新 owner 时非静默——事件 args 显式落
    # attempt_owner_prev（旧绑定）留痕 + 人类面输出重绑提示行；claim 仍是合法接管面
    # （判定与变更语义不动），与汇报面 attempt_owner_mismatch 拒的区别在接管语义而非绕过。
    rebind_from = None
    if a.attempt and _attempt_bind_enforced():
        if prev_bound and owner and prev_bound != owner:
            rebind_from = prev_bound
        t['attempt_owner'] = t['owner']
        if _EVT_CTX.get('armed'):
            _EVT_CTX['args']['attempt_owner'] = t['owner']
            if rebind_from:
                _EVT_CTX['args']['attempt_owner_prev'] = rebind_from
    t['updated'] = now_ms()
    save(path, data)
    show(t)
    if rebind_from:
        print(f"（attempt_owner 重绑留痕：{rebind_from} → {t['attempt_owner']}；"
              f"claim --attempt 为合法接管面，代际绑定随落定 owner 翻新，事件 args 已落 attempt_owner_prev）")


class _ClaimIdleGateNS:
    """claim_idle 逐候选预算门的命令视图：budget_gate/_budget_refuse 只读 cmd/id/owner 三属性，
    复用 claim 的全套门语义（interrupt 拒绝、alarm/wrap-up 升档章随本命令事件落账）——不复制
    预算判定逻辑（#16 语义单一实现原则）。"""

    __slots__ = ('cmd', 'id', 'owner')

    def __init__(self, tid, owner):
        self.cmd, self.id, self.owner = 'claim_idle', tid, owner


def cmd_claim_idle(a, data, path):
    """claim_idle <owner> <id> [<id>...]：#20 空闲续领原子认领（v2.9 M1/T3，T39-① 收窄）。
    旧流程（lib list 快照判空闲 → 逐任务 show 复判 → claim）在快照与 claim 之间存在窄窗：
    并发 sweep/人工 claim 可双双入选（v2.8 T39 评审判「后果仅多认领一条 ready、无损坏面」；
    用户裁决仍做代码收窄）。本命令在 main 统一 board_lock 单次持锁内完成「板上无 running
    判定 + 认领」，判定与写入间隙为零：
    - 空闲闸：任一任务 status=running → BoardError board_not_idle（零写零事件，与 lib 侧
      「有开放执行整轮不动」同语义；快照滞后场景由锁内权威状态裁决——并发 sweep 竞争下
      恰好一个成功，后到者整轮不动）；
    - 候选复判（快照可滞后，fail-open）：非 ready / 已有 owner / 任务不存在 → 跳过；全部
      跳过 → BoardError claim_idle_noop（零写零事件）；
    - 逐候选预算门（复用 budget_gate，同 claim 语义；两段式章延后——v2.9 T11）：先全部候选
      判定、后统一落章随本命令事件入账；interrupt 档当场拒绝（首拒落 budget 事件、后续幂等
      零事件；拒绝发生在任何变更之前）——#20 续领受 #16 预算约束零回归；
      alarm/wrap-up 升档章随本命令自身事件落账；
    - 认领走既有 claim 变更语义：owner 落档、status=running、updated 重臂；不建派工代际
      （attempt_id 不触碰，lib 侧认领与 WP-4a 同代际语义）；事件 type='claim'（budget_counts
      归因不变），多候选单事件 after 携带全部变更任务快照（watchdog 单事件多任务先例）。
    拒绝面（除预算拒绝外零写零事件）：board_not_idle / claim_idle_noop /
    stale_revision（--expected-revision 既有 CAS）。人类面逐任务 show 块 + revision 尾行；
    --json data 携带 {claimed:[id...], skipped:[{id,reason}...]}（_CLAIM_IDLE_EVAL 同源）。
    T16 work-stealing（--steal 显式参数，Q4 裁决）：缺省不带=上述现有语义逐字节不变。带
    --steal 时认领面从「无主任务」扩到「他人 ready+owner 空闲任务」（ready+owner=X →
    running+owner=认领方，无中间态），空闲闸收窄为双侧——认领方本人名下无 running（他人
    在途不再整轮封锁）且被窃任务 owner 名下无 running（steal_owner_active 具名拒，判定先于
    任何变更，整轮零写零事件）；不带 --steal 的全板闸 board_not_idle 逐字节不变。让渡留痕：
    单事件 type=claim args 增 steal:true / previous_owner:{tid:上一手 owner}，任务 checkpoint
    注记让渡、stolen_from 字段落档（每次 steal 覆写为上一手 owner）。反回摆：不得认领上一手
    owner 为自己的任务（steal_ping_pong 具名拒，零写零事件）。约束共存：--tags 交集门逐候选
    跳过、T13 open-cap 对认领方逐候选生效、预算门两段式章延后照常；无主任务不在 --steal
    语义内（逐候选跳过）。"""
    owner = (a.owner or '').strip()
    if not owner:
        sys.exit('错误：claim_idle 需要非空 owner（认领方身份，空闲续领固定为编排者）')
    # T8 能力标签声明（宁漏勿错）：未声明 --tags 时带 tags 候选一律跳过——空闲续领由编排者
    # 发起，缺声明即无能力面证据，不猜；声明了则只放行有交集的候选。
    claimant_tags = _parse_tags(getattr(a, 'tags', None))
    # T13 反风暴 open 上限（Q7）：认领方 open 计数逐候选判——候选均无主，每接受一个候选认领方
    # 名下 open 总数 +1，超 DSH_EXPERT_PEER_OPEN_CAP（缺省 2）的候选跳过（reason=
    # open_cap_exceeded）；因超限致整轮无一可认领时具名拒 open_cap_exceeded（零写零事件）。
    # 缺省关闭不读 env 不计数，零行为变化。
    # T20🟢3：阈值 env 解析（_open_cap_state → _env_positive_int）惰性化并后移——board_not_idle
    # 与候选复判（不存在/状态/tags/owner）先行，env 解析推迟到首个真正需要 cap 判定的候选处，
    # 保持「先板面后环境」直觉（env 非法与板面拒绝并存时板面拒绝先出；全是非 cap 原因跳过时
    # claim_idle_noop 先出，env 非法不遮蔽板面结果）。计数为纯读，判定语义不变。
    running = sorted((tid for tid, t in data['tasks'].items() if t['status'] == 'running'),
                     key=lambda x: int(x[1:]))
    if a.steal:
        # T16（Q4 双侧空闲闸之 claimant 侧）：--steal 只要求认领方本人无 running——他人在途
        # 任务与本轮无涉，全板闸在此收窄（不带 --steal 的全板闸分支逐字节不变）；被窃任务
        # owner 名下无 running 在候选定后统一判定（steal_owner_active，判定先于任何变更）。
        own_running = sorted((tid for tid, t in data['tasks'].items()
                              if t['status'] == 'running' and (t.get('owner') or '') == owner),
                             key=lambda x: int(x[1:]))
        if own_running:
            raise BoardError('steal_owner_active', side='claimant', owner=owner, running=own_running,
                             hint='认领方本人名下存在在途任务（running），work-stealing 空闲闸拒绝：'
                                  '先收口本人名下在途任务再窃（探针：taskboard.py list 核查）；'
                                  '拒绝发生在任何变更与 save 之前（零写零事件）')
    elif running:
        raise BoardError('board_not_idle', running=running,
                         hint='板上存在开放执行（running 任务），空闲续领整轮不动；'
                              '本轮候选未做任何认领（零写零事件），下个空闲边沿重扫')
    cap_state = None

    def _cap_state():
        nonlocal cap_state
        if cap_state is None:
            cap_state = _open_cap_state(owner, data)
        return cap_state

    seen, candidates, skipped = set(), [], []
    for tid in a.ids:
        if tid in seen:
            continue
        seen.add(tid)
        t = data['tasks'].get(tid)
        if not isinstance(t, dict):
            skipped.append({'id': tid, 'reason': '任务不存在'})
        elif t['status'] != 'ready':
            skipped.append({'id': tid, 'reason': f'状态为 {t["status"]}'})
        elif t.get('tags') and (claimant_tags is None or not (set(claimant_tags) & set(t['tags']))):
            # T8：带 tags 候选与声明无交集（或未声明）→ 逐个跳过，不进 noop 汇总语义之外的分支
            skipped.append({'id': tid, 'reason': 'tag_mismatch'})
        elif a.steal and not t.get('owner'):
            # T16：无主任务不在 --steal 语义内（steal 只迁已有主空闲任务，无主走缺省路径）
            skipped.append({'id': tid, 'reason': '无主任务不在 --steal 语义内'})
        elif a.steal and t.get('owner') == owner:
            # T16：窃本人名下任务无意义，复用既有 owner 跳过口径
            skipped.append({'id': tid, 'reason': f'已有 owner={t["owner"]}'})
        elif t.get('owner') and not a.steal:
            skipped.append({'id': tid, 'reason': f'已有 owner={t["owner"]}'})
        else:
            cap_enforced, cap_limit, cap_pre = _cap_state()
            if cap_enforced and cap_pre + len(candidates) >= cap_limit:
                # T13：认领方 open 计数已达上限，再认领该候选将越限——逐候选跳过（判定先于任何变更）
                skipped.append({'id': tid, 'reason': 'open_cap_exceeded'})
            else:
                candidates.append(t)
    if not candidates:
        if any(s['reason'] == 'open_cap_exceeded' for s in skipped):
            # T20🟢3：仅在确有 cap 跳过时才解析阈值 env（cap 跳过只在执法开启时产生）——
            # 全为非 cap 原因跳过时 claim_idle_noop 先出，env 非法不遮蔽板面结果。
            cap_enforced, cap_limit, cap_pre = _cap_state()
            if cap_enforced:
                raise BoardError('open_cap_exceeded', owner=owner, open_count=cap_pre, cap=cap_limit,
                                 skipped=skipped,
                                 hint='认领方名下 open 任务已达上限，整轮无一可认领（探针：taskboard.py '
                                      'open-counts <owner> 核查；先收口/转派在途任务再续领）；'
                                      '拒绝发生在任何变更与 save 之前（零写零事件）')
        raise BoardError('claim_idle_noop', skipped=skipped,
                         hint='候选在锁内权威状态下无一可认领（快照滞后/负向条件命中）；零写零事件')
    if a.steal:
        # T16 反回摆 + 双侧空闲闸之 owner 侧（Q4）：判定先于任何变更（先于预算门，拒绝时不落
        # 任何章、不落任何事件，整轮零写零事件）。owner 侧：被窃任务 owner 名下有 running →
        # 具名拒；反回摆：候选 stolen_from==认领方（上一手 owner 为本人）→ 具名拒。
        ping = [t['id'] for t in candidates if (t.get('stolen_from') or '') == owner]
        if ping:
            raise BoardError('steal_ping_pong', owner=owner, tasks=ping,
                             hint='候选任务的上一手 owner 为认领方本人（stolen_from 反回摆保护），'
                                  '禁止窃回自己刚让渡的任务；拒绝发生在任何变更与 save 之前（零写零事件）')
        active = sorted({(t.get('owner') or '') for t in candidates
                         if any(x['status'] == 'running' and (x.get('owner') or '') == t['owner']
                                for x in data['tasks'].values())})
        if active:
            raise BoardError('steal_owner_active', side='owner', owner=owner, owners=active,
                             hint='被窃任务 owner 名下存在在途任务（running），双侧空闲闸拒绝：'
                                  '等其收口后再窃（探针：taskboard.py open-counts 核查）；'
                                  '拒绝发生在任何变更与 save 之前（零写零事件）')
    # 逐候选预算门，两段式章延后（v2.9 T11，T10 评审 🔴-1）：先全部候选判定、后统一落章——
    # 升档章暂存 stamps，全部门判定通过后才落快照、随本命令 claim 事件入账。此前「逐候选
    # 就地落章」在跨档组合下砖化：前候选章已就地改写 data 而未落账，后候选 interrupt 拒绝时
    # _append_budget_event 以含未落账章的 data 算末事件 state_hash 而 after 只携带被拒任务 →
    # 折叠对账失配，此后 list/replay 全命令 unrecoverable。章延后后，拒绝时点上全板除被拒
    # 任务自身（拒绝事件 after 携带、可复现）零变更，拒绝/放行两条路径均保持事件流可复现
    # 不变量。锁内计数读走既有 read_events（repair=True，自愈语义与其余写命令一致）。
    stamps = []
    for t in candidates:
        budget_gate(_ClaimIdleGateNS(t['id'], owner), data, path, stamp_sink=stamps)
    for t, tier, who, count, th in stamps:
        _budget_stamp(t, tier, who, count, th)  # 统一落章：随本命令 claim 事件落账（零额外事件）
    prev_owners = {}
    for t in candidates:
        if a.steal:
            prev_owners[t['id']] = t['owner']  # T16：上一手 owner（翻新前捕获）
        t['status'] = 'running'
        t['owner'] = owner
        t['updated'] = now_ms()
        if a.steal:
            # T16 让渡留痕：stolen_from 落档=上一手 owner（每次 steal 覆写，反回摆即取此字段）；
            # checkpoint 注记让渡（时间面证据，随任务快照落盘、随本命令事件 after 携带）。
            t['stolen_from'] = prev_owners[t['id']]
            t.setdefault('checkpoints', []).append({
                'time': now_ms(),
                'note': f"让渡：{t['id']} 由 {prev_owners[t['id']]} 让渡给 {owner}"
                        f"（claim_idle --steal work-stealing）",
            })
    if a.steal and _EVT_CTX.get('armed'):
        _EVT_CTX['args']['steal'] = True
        _EVT_CTX['args']['previous_owner'] = {tid: po for tid, po in sorted(prev_owners.items())}
    _CLAIM_IDLE_EVAL['claimed'] = [t['id'] for t in candidates]
    _CLAIM_IDLE_EVAL['skipped'] = skipped
    save(path, data)
    for t in candidates:
        show(t)


def cmd_approve(a, data, path):
    """approve <id>：PM 规划草案批准（v2.7，WP-5/S1）——draft -> ready，走既有事件追加路径
    （CAS --expected-revision 共存）。依赖未满足时不伪造成 ready：先回 pending，由既有依赖自动
    提升在依赖 done 时转 ready（保持「ready 蕴含依赖已满足」不变量）。批准是草案进入派工面的
    唯一出口；批准前 claim/auto-claim 均被拒（批准前零 spawn）。
    方向 4（身份与信任链）：可选 `--by <批准人>` 批准人声明（板面自报审计面，防误用不防伪造
    ——与 done --by 同信任级别）——落事件 args.by 与检查点注记，让板面能回答「这是谁批准的」；
    协议纪律（SKILL.md §2）：批准者不得是草案创建代理本人（职责分离），代理转达的批准不可信
    （用户批准只来自用户本人直接输入）。缺省不带 --by = 旧行为逐字节（零注记零 args 变化）。"""
    t = get_task(data, a.id)
    if t['status'] != 'draft':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 draft 可批准")
    # ── T13 反风暴 open 上限执法（Q7）：代理自建草案（M1 链落 created_by）批准前核查
    # created_by 名下 open 计数（自建草案 owner==created_by 时草案自身已计入 open-counts 口径；
    # 批准不改计数，本门语义=不把超限堆积放行进派工面）。lead 自建草案（无 created_by）
    # 不受约束。缺省关闭零行为变化；超限具名拒 open_cap_exceeded，判定先于任何变更与 save。
    cb = t.get('created_by')
    if cb:
        _check_open_cap(cb, data)
    by = (getattr(a, 'by', None) or '').strip()
    if len(by) > APPROVAL_BY_MAX_CHARS:
        sys.exit(f"错误：--by 长 {len(by)} 码点，超过上限 {APPROVAL_BY_MAX_CHARS}"
                 "（身份声明是名字不是文档）；超限硬拒不静默截断（零事件零落盘）")
    if by:
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('checkpoints', []).append(
            {'time': ts, 'note': f'批准人声明: {by}（板面自报审计面——协议纪律：批准者≠草案创建代理本人；代理转达的批准不可信）'})
    t['status'] = 'pending'  # 依赖已满足时由下方 refresh 自动转 ready（复用既有不变量维护）
    t['updated'] = now_ms()
    promoted = refresh(data)
    save(path, data)
    show(t)
    if by:
        print(f'批准人: {by}（自报，审计留痕）')
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


def _validate_done_verdict(a, t):
    """review kind 完成语义分叉校验（WP-5/S2）：在任何变更与 save 之前拒绝——零事件零落盘。
    review 任务：--verdict 必填且仅 pass|needs_revision；needs_revision 必须携带非空 --findings
    （验收断言 b）；pass 不接受 --findings/--repair-owner（评审通过无需修复，防发现清单被静默丢弃）。
    非 review 任务：不接受任何 review 语义参数（verdict/findings/repair_owner）。"""
    kind = t.get('kind')
    if kind == 'review':
        if not a.verdict:
            sys.exit(f"错误：{a.id} 为 review 任务，完成须显式给出结论 --verdict pass|needs_revision")
        if a.verdict not in ('pass', 'needs_revision'):
            sys.exit(f"错误：--verdict 仅接受 pass|needs_revision（得到 {a.verdict!r}）")
        if a.verdict == 'needs_revision' and not (a.findings or '').strip():
            sys.exit(f"错误：{a.id} 结论为 needs_revision 必须携带 --findings（评审发现清单，"
                     "供自动 repair 任务引用）；缺 findings 的 needs_revision 被拒绝（零事件零落盘）")
        if a.verdict == 'needs_revision' and len((a.findings or '').strip()) > FINDINGS_MAX_CHARS:
            sys.exit(f"错误：--findings 长 {len((a.findings or '').strip())} 码点，超过上限 "
                     f"{FINDINGS_MAX_CHARS}（与断点恢复 prompt 预算同口径）；超限硬拒不静默截断"
                     "（截断会丢评审要点），请压缩为要点清单后重试（零事件零落盘）")
        if a.verdict == 'pass' and ((a.findings or '').strip() or a.repair_owner):
            sys.exit(f"错误：--verdict pass 不接受 --findings/--repair-owner（评审通过无需修复）；"
                     "评审备注写入 summary")
        if _mvote_active(t):
            # m 票评审（WP-5/S3）：收口结论须与票箱一致——pass 生效（≥m 张 pass 票且零 fail 票）才可收口；
            # fail 不接受单方裁决（须经投票生效，防单方绕过陪审团）。校验发生在任何变更与 save 之前。
            p, f, ab = _vote_tally(t)
            if a.verdict == 'pass' and not (p >= t['quorum_m'] and f == 0):
                raise BoardError('quorum_not_met', task=a.id, quorum_m=t['quorum_m'],
                                 tally={'pass': p, 'fail': f, 'abstain': ab},
                                 hint='m 票评审 pass 生效需 ≥m 张 pass 票且零 fail 票（弃权不计同向不构成反向）；'
                                      '先由评审员 vote 落票，pass 生效后再收口')
            if a.verdict == 'needs_revision':
                raise BoardError('vote_required', task=a.id, quorum_m=t['quorum_m'],
                                 tally={'pass': p, 'fail': f, 'abstain': ab},
                                 hint='m 票评审的 fail 结论须经投票生效（vote 命令：fail 票 ≥m 且零 pass 票'
                                      '自动触发 repair 路径）；不接受单方 done --verdict needs_revision')
    elif a.verdict or (a.findings or '').strip() or a.repair_owner:
        sys.exit(f"错误：{a.id} 非 review 任务（kind={kind or '（缺省）'}），"
                 "不支持 --verdict/--findings/--repair-owner")


def _review_needs_revision(a, data, path, t, findings, limit, limit_label):
    """review 结论 needs_revision 共享机制（WP-5/S2 单票路径 + WP-5/S3 m 票 fail 生效路径共用）：
    原任务不完成——回 ready 待修复后复审；自动生成 repair 任务（引用原任务+findings，不经 draft
    直接 ready：来源是工具自动编排而非 PM 规划），原任务的全部下游依赖改挂 repair（DAG 重排）；
    全部变更经一次 save 落成单事件（多任务 after 快照，事件流可追溯）。计数超 limit 不再生成
    repair：任务转 escalated 终态交回用户处置（不可 claim/done，用户显式 retry 可解除升级）。
    两路径接线点：单票路径 a=done 命名空间，limit=REPAIR_RETRY_LIMIT（repair 重试上限 3）、
    findings 取 --findings、审计参数 --rework/--switched/--by 落档；m 票路径 a=None（无审计侧写、
    repair owner 缺省为空由编排者分配），limit=REVIEW_ROUND_LIMIT（评审轮次上限 2）、findings 由
    fail 生效票箱合成——轮次计数同源复用 repair_count（评审轮次=needs_revision 发生次数），不设
    第二计数器杜绝双计数漂移。
    多轮语义（T19 回炉，评审疑-1 编排者裁决「每轮都重排」）：每轮 needs_revision 都生成新 repair，
    依赖原任务或任一旧 repair 的下游一律改挂最新 repair——下游始终只等最新修复；已 ready 的下游
    随之回 pending（其依赖由已满足变为未满足，保持「ready 蕴含依赖已满足」不变量）；running/done
    下游不打断（在途工作与既成事实不动）。"""
    count = int(t.get('repair_count') or 0) + 1
    ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
    t['verdict'] = 'needs_revision'
    t['findings'] = findings
    t['repair_count'] = count
    # 建议④（回炉）：单票路径 --rework/--switched/--by 落档不丢弃（与普通 done 审计对齐）；m 票路径 a=None 跳过
    rework = getattr(a, 'rework', None) if a is not None else None
    switched = getattr(a, 'switched', False) if a is not None else False
    by = getattr(a, 'by', None) if a is not None else None
    repair_owner = getattr(a, 'repair_owner', None) if a is not None else None
    if rework is not None:
        t['rework'] = rework
    if switched:
        t['switched'] = True
    if by and by != t['owner']:
        t.setdefault('executors', []).append({'name': by, 'time': ts})
    # ── T13 escalation 上限执法（Q7）：env DSH_EXPERT_ANTISTORM_ENFORCE 显式开启且该任务
    # escalated 历史（escalation_count，retry 不清零）已达 DSH_EXPERT_ESCALATION_LIMIT
    # （缺省 1）→ 拒绝自动 repair 绕行：不再生成 repair，直升 escalated 强制上报用户处置
    # （bus 口径：第 2 次 escalated 前编排者必须上报用户裁决；retry 用户出口不动）。
    # 执法关闭时 esc_over 恒 False，本门零行为变化=现状逐字节。
    esc_enforced = _antistorm_enforced()
    esc_count = _escalation_history(t) if esc_enforced else 0
    esc_over = esc_enforced and esc_count >= _escalation_limit()
    if count > limit or esc_over:
        # 超上限：不再自动生成 repair——escalated 终态，处置权交回用户
        if esc_enforced:
            t['escalation_count'] = esc_count + 1  # T13：escalated 历史落档（执法开启时；retry 不清零）
        t['status'] = 'escalated'
        t['updated'] = now_ms()
        if esc_over and count <= limit:
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"review: 第 {count} 次结论 needs_revision；escalated 历史 "
                                     f"{esc_count} 次已达上限（DSH_EXPERT_ESCALATION_LIMIT）"
                                     "→ 拒绝自动 repair 绕行，escalated 交回用户处置"})
        else:
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"review: 第 {count} 次结论 needs_revision，超过 {limit_label} "
                                     f"{limit} → escalated（交回用户处置）"})
        save(path, data)
        show(t)
        if by and by != t['owner']:
            print(f"实际执行者 {by} 已记录（owner={t['owner']}）")
        if esc_over and count <= limit:
            print(f'  评审结论: needs_revision（第 {count} 次）；escalated 历史 {esc_count} 次已达上限 '
                  '→ 拒绝自动 repair 绕行，已升级 escalated')
        else:
            print(f'  评审结论: needs_revision（第 {count} 次，超过 {limit_label} {limit}）→ 已升级 escalated')
        print('  终态：不可 claim/done，仅用户显式指令（retry 解除升级并重置重试预算）可再动')
        return
    # 自动生成 repair 任务（等价 create 装配；无上游依赖——评审已发生，修复即可开工，refresh 后即 ready）
    tid = f"T{data['seq'] + 1}"
    data['seq'] += 1
    data['tasks'][tid] = {
        'id': tid, 'title': f"[repair] {t['title']}", 'owner': repair_owner or '', 'dep': [],
        'desc': f"评审失败修复（来源 {t['id']} 结论 needs_revision）：{findings}", 'status': 'pending',
        'created': now_ms(), 'updated': now_ms(), 'summary': '', 'fail': '',
        'repair_of': t['id'],
    }
    if t.get('scope'):
        data['tasks'][tid]['scope'] = list(t['scope'])  # 继承原任务 scope（hook 第三查覆盖修复提交）
    # DAG 重排（多轮语义，T19 回炉）：依赖原任务或任一旧 repair 的下游一律改挂本次新 repair
    # （首轮 gate 只有原任务，行为与旧版一致；后续轮旧 repair 也纳入改挂面）
    gate = {t['id']} | {x['id'] for x in data['tasks'].values()
                        if x.get('repair_of') == t['id'] and x['id'] != tid}
    repointed, demoted = [], []
    for x in data['tasks'].values():
        if x['id'] == tid or not (gate & set(x['dep'])):
            continue
        x['dep'] = [tid if d in gate else d for d in x['dep']]
        x['updated'] = now_ms()
        repointed.append(x['id'])
        if x['status'] == 'ready':  # 依赖由已满足变为未满足：回 pending，保持「ready 蕴含依赖已满足」
            x['status'] = 'pending'
            demoted.append(x['id'])
            x.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"review 第 {count} 轮 needs_revision：依赖改挂最新 repair {tid}，回 pending 等待"})
    cycle = find_cycle({x['id']: list(x['dep']) for x in data['tasks'].values()})  # 防御性全图环检测
    if cycle:
        raise BoardError('dependency_cycle', cycle='->'.join(cycle),
                         hint='下游依赖改挂 repair 后全图成环（不应发生）；拒绝写入，请人工核查依赖')
    t['status'] = 'ready'  # 回 ready：修复完成后由编排者安排复审（再 claim → done --verdict）
    t['updated'] = now_ms()
    t.setdefault('checkpoints', []).append(
        {'time': ts, 'note': f"review: 第 {count} 次结论 needs_revision → 生成 repair {tid}；"
                             f"下游 {','.join(repointed) or '（无）'} 依赖改挂最新 repair {tid}（每轮重排）"
                             + (f"，已 ready 的 {','.join(demoted)} 回 pending" if demoted else '')
                             + "，原任务回 ready 待复审"})
    promoted = refresh(data)
    save(path, data)
    show(t)
    show(data['tasks'][tid])
    if by and by != t['owner']:
        print(f"实际执行者 {by} 已记录（owner={t['owner']}）")
    if repointed:
        print(f"下游依赖已改挂 {tid}: " + ' '.join(repointed))
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


def cmd_reject(a, data, path):
    """reject <id>：PM 规划草案否决（v2.7，T19/S3①）——draft -> rejected 终态。
    被否决草案退出批准面、不再永久滞留（archive 不因 draft 滞留被迫 --force）；
    rejected 不可 claim/approve/progress/reassign；如需重启，按意见重新规划后新建草案条目。
    方向 4（身份与信任链）：可选 `--by <否决人>` 声明落审计面（同 approve --by 语义）；
    缺省不带 = 旧行为逐字节。"""
    t = get_task(data, a.id)
    if t['status'] != 'draft':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 draft 可否决")
    by = (getattr(a, 'by', None) or '').strip()
    if len(by) > APPROVAL_BY_MAX_CHARS:
        sys.exit(f"错误：--by 长 {len(by)} 码点，超过上限 {APPROVAL_BY_MAX_CHARS}"
                 "（身份声明是名字不是文档）；超限硬拒不静默截断（零事件零落盘）")
    if by:
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('checkpoints', []).append(
            {'time': ts, 'note': f'否决人声明: {by}（板面自报审计面——代理转达的否决同样不可信，终局裁决以用户直接输入为准）'})
    t['status'] = 'rejected'
    t['updated'] = now_ms()
    save(path, data)
    show(t)
    if by:
        print(f'否决人: {by}（自报，审计留痕）')
    print('已否决：rejected 为终态，不可 claim/approve；如需重启请按意见重新规划后新建草案')


def cmd_done(a, data, path):
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可完成")
    _validate_done_verdict(a, t)  # review kind 语义分叉：先校验后变更（拒绝零事件零落盘）
    if a.rework is not None and a.rework < 0:
        sys.exit('错误：--rework 不能为负数')
    if a.verdict == 'needs_revision':
        # 单票路径（m=1/未声明）：REPAIR_RETRY_LIMIT=3 计 repair 重试（m 票路径经 vote 由 REVIEW_ROUND_LIMIT 接管）
        _review_needs_revision(a, data, path, t, findings=(a.findings or '').strip(),
                               limit=REPAIR_RETRY_LIMIT, limit_label='repair 重试上限')
        return
    t['status'] = 'done'
    t.pop('fail_streak', None)  # 方向 3：成功完成=实质进展，连续失败循环计数清零（无字段时无副作用）
    closed_repairs = []
    if a.verdict == 'pass':
        t['verdict'] = 'pass'  # review 评审通过：结论留档（非 review 任务无该字段）
        # 重要-2（T19 回炉）：复审 pass 时自动收口名下开放 repair（ready/pending/failed，repair_of 指向本任务）
        # 为 rejected 终态（作废语义——rejected 承载草案否决与 repair 收口两类来源），防僵尸 repair
        # 永久阻塞下游；其下游依赖改挂回本任务（此刻已 done），随后由既有 refresh 提升自然解锁。
        # running 的 repair 不自动打断（在途工作由编排者人工处置）；done 的 repair 是既成事实不动；
        # failed 的 repair 随 pass 一并收口（二轮重要-1：pass 前已失败的 repair 不再僵尸阻塞下游）。
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        for x in data['tasks'].values():
            if x.get('repair_of') == t['id'] and x['status'] in ('ready', 'pending', 'failed'):
                x['status'] = 'rejected'
                x['updated'] = now_ms()
                x.setdefault('checkpoints', []).append(
                    {'time': ts, 'note': f"review {t['id']} 复审 pass：repair 自动收口为 rejected（作废，无需修复）"})
                closed_repairs.append(x['id'])
        if closed_repairs:  # 收口 repair 的下游改挂回评审任务（已 done → 依赖满足 → refresh 提升解锁）
            closed_set = set(closed_repairs)
            for x in data['tasks'].values():
                if closed_set & set(x['dep']):
                    x['dep'] = [t['id'] if d in closed_set else d for d in x['dep']]
                    x['updated'] = now_ms()
    t['summary'] = a.summary or ''
    if a.rework is not None:
        t['rework'] = a.rework
    if a.switched:
        t['switched'] = True
    if a.by and a.by != t['owner']:
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('executors', []).append({'name': a.by, 'time': ts})
    t['updated'] = now_ms()
    promoted = refresh(data)
    save(path, data)
    show(t)
    if t.get('verify'):  # done/deliver 前重算：代码一变旧验证回执自动失效（告警不阻塞）
        state, changed, _ = verify_status(t)
        if state == 'stale':
            print(f"警告：验证回执已 stale（文件已变更: {', '.join(changed)}）——旧验证/旧评审自动失效，建议重新 verify 后再交付")
    if a.by and a.by != t['owner']:
        print(f"实际执行者 {a.by} 已记录（owner={t['owner']}）")
    elif not a.by and t['owner'] in ('', '编排者'):
        print('提醒：owner 为空或编排者时建议用 --by <执行专家名> 记录实际执行者（多专家/门禁条目）')
    if closed_repairs:
        print('评审通过，repair 自动收口为 rejected（作废）: ' + ' '.join(closed_repairs))
    if promoted:
        print('依赖已满足，自动转 ready: ' + ' '.join(promoted))


# ── 方向 3 连续失败循环升级（dev/orchestration-economics-345，opt-in 执法）──────
# 循环失控四轴之一（另三轴：watchdog 时间窗 / #16 工具调用硬预算 / 振荡告警——各管
# 一个轴，互补不冲突）。口径：fail_streak 跨 retry 累计（普通 failed→retry 重派不清
# 零=循环检测的关键；done 成功清零=有实质进展；用户 retry 解除升级时重置=显式重给
# 一轮预算），达限的 fail 不落 failed 而自动转 escalated 待用户处置（mission-control
# 「循环失败 N 次升级给人」模式；唯一出口=用户 retry）。执法关闭（缺省）=旧路径逐字节
# （不读 env、不落 fail_streak 字段）。
def _failloop_enforced() -> bool:
    return bool(os.environ.get('DSH_EXPERT_FAILLOOP_ENFORCE', '').strip())


def _failloop_limit():
    """DSH_EXPERT_FAILLOOP_LIMIT（缺省 3）：非法值 fail-open（执法禁用+stderr 告警，
    沿 budget_thresholds 先例——护栏机制配置错误不静默硬拒，也绝不带着坏阈值执法）。"""
    raw = os.environ.get('DSH_EXPERT_FAILLOOP_LIMIT')
    if raw is None or raw == '':
        return 3
    try:
        n = int(raw)
    except ValueError:
        print('警告：DSH_EXPERT_FAILLOOP_LIMIT 非法（须为正整数），连续失败升级执法本次禁用', file=sys.stderr)
        return None
    if n < 1:
        print('警告：DSH_EXPERT_FAILLOOP_LIMIT 须 ≥1，连续失败升级执法本次禁用', file=sys.stderr)
        return None
    return n


def cmd_fail(a, data, path):
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可标记失败")
    # 方向 3 连续失败循环升级（opt-in 执法）：达限不落 failed 而自动转 escalated（事件
    # args 携 auto_escalated/fail_streak 留痕）；未达限落 failed 但累计 fail_streak 字段
    # （仅执法开启且限额合法时落字段——关闭期/限额非法=执法整体禁用，任务 JSON 形状
    # 逐字节不变，沿 budget_thresholds fail-open 先例）。
    if _failloop_enforced():
        limit = _failloop_limit()
        if limit is not None:
            streak = int(t.get('fail_streak') or 0) + 1
            if streak >= limit:
                t['status'] = 'escalated'
                t['fail'] = a.reason or ''
                t['fail_streak'] = streak
                t['updated'] = now_ms()
                ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
                t.setdefault('checkpoints', []).append(
                    {'time': ts, 'note': f'连续失败 {streak} 次（fail-loop 限额 {limit}）自动升级：待用户处置（retry 解除并重置计数）'})
                _EVT_CTX['args']['auto_escalated'] = True
                _EVT_CTX['args']['fail_streak'] = streak
                save(path, data)
                show(t)
                # 方向 3 收口 #4：升级行收口进统一信封格式（执行级——状态迁移已由本命令完成，
                # 故不带「本提示不阻断」尾行；格式规范见 SKILL.md §3 升级信封段）。
                print(f'【升级｜连续失败｜升级】现状：任务 {a.id} 连续失败 {streak}/{limit} 次（fail_streak 跨 retry 累计），已自动转 escalated。建议：唯一出口=用户显式 retry（重置 fail_streak）；上报用户须附升级报告三要素（现状/已尝试/建议选项）。')
                return
            t['fail_streak'] = streak
    t['status'] = 'failed'
    t['fail'] = a.reason or ''
    t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_retry(a, data, path):
    t = get_task(data, a.id)
    if t['status'] == 'escalated':
        # escalated 唯一工具内出口（WP-5/S2）：用户显式指令解除升级，回 ready 并重置 repair 重试预算
        # （用户决定再给一轮修复机会；旧 verdict/findings 留档不删，复审通过时被覆盖）。
        # m 票任务（WP-5/S3 接线点）：僵局/轮次升级解除时同步清空票箱、重置评审轮次（T20 回炉起与
        # failed retry / watchdog reclaim / recover 共用 _mvote_reset_ballot 一处实现）。
        # 方向 3：fail-loop 升级的任务在此同步重置连续失败计数（用户 retry=显式重给一轮预算）；
        # 无 fail_streak 字段的任务（评审升级路径/执法关闭期）pop 无副作用，落盘形状不变。
        had_streak = int(t.get('fail_streak') or 0)
        t['status'] = 'ready'
        t['fail'] = ''
        t['repair_count'] = 0
        t.pop('fail_streak', None)
        mvote = _mvote_reset_ballot(t)
        t['updated'] = now_ms()
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('checkpoints', []).append(
            {'time': ts, 'note': '用户显式 retry：解除 escalated，回 ready；repair 重试预算已重置'
                                 + (f'；fail-loop 连续失败计数已重置（原 {had_streak}）' if had_streak else '')
                                 + ('；m 票票箱已清空、评审轮次重置' if mvote else '')})
        save(path, data)
        show(t)
        print('已解除升级：任务回 ready，repair 重试预算重置；请在任务书注明用户处置决定'
              + ('（m 票任务：票箱已清空、评审轮次重置，重新投票）' if mvote else ''))
        return
    if t['status'] != 'failed':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 failed 可重试")
    t['status'] = 'ready'
    t['fail'] = ''
    # T20 回炉（评审重要-1）：failed→retry 同样是「回 ready 重新评审」——m 票任务清空票箱、重置轮次
    # （如评审员失联经 fail 处置后重派：旧票残留会让新一轮评审跨轮计票，假 pass 生效或假僵局）。
    mvote = _mvote_reset_ballot(t)
    t['updated'] = now_ms()
    if mvote:
        ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('checkpoints', []).append(
            {'time': ts, 'note': 'failed 重试：回 ready；m 票票箱已清空、评审轮次重置（重新投票）'})
    save(path, data)
    show(t)


def cmd_progress(a, data, path):
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] == 'draft':
        sys.exit(f"错误：{a.id} 为 PM 规划草案（draft），无执行进度可记；approve 批准后再开工")
    if t['status'] == 'rejected':
        sys.exit(f"错误：{a.id} 已否决（rejected 终态），不可记检查点")
    if t['status'] == 'escalated':
        sys.exit(f"错误：{a.id} 已升级（escalated），等待用户处置，不可记检查点")
    ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
    t.setdefault('checkpoints', []).append({'time': ts, 'note': a.note})
    t['updated'] = now_ms()
    _reset_nudges(t)  # 检查点=活着的证据：滑动无进展窗口重臂，连续未响应 nudge 计数清零
    save(path, data)
    show(t)
    print(f"  最新检查点({len(t['checkpoints'])}): [{ts}] {a.note}")


# ── m 票布尔共识投票（v2.7，WP-5/S3，用户裁决 Q3=3A）────────────────────────
# 口径与生效规则见 _vote_tally 与文件头。设计要点：评审员独立 summon、各自落票——投票写入点必须是
# 多代理可分别调用的独立命令（done 是收口语义不能复用），票箱为任务级 votes 字段（随任务快照折叠/
# 重放/hash 全链透明，零新顶层键）；并发写由 board_lock（flock）+ CAS --expected-revision 串行化，
# 聚合评估在锁内针对刚加载的落盘状态进行（只读快照语义，无 TOCTOU）；--attempt 走既有代际校验
# （fail closed，缺省不校验与旧版一致）。落款即身份（--by，与直改主板同信任级别——能写板文件即可
# 伪造落款，与 done --by / claim --owner 同口径；不建评审员身份系统为既定非目标，T20 回炉裁决②）。

def cmd_vote(a, data, path):
    """vote <id> --by <评审员名> --score <0..1>：m 票评审落票（quorum_m≥2 任务专用；任务须 running）。
    每票落账后按票箱即时评估生效规则：≥m 张同向布尔票且零反向票才生效——pass 生效仅置可收口状态
    （显式 done --verdict pass 收口，summary 等收口审计照常落档）；fail 生效当场走 _review_needs_revision
    共享机制（repair 生成+下游改挂+回 ready，轮次上限 REVIEW_ROUND_LIMIT），本轮票箱清空、vote_round
    进次轮；出现任一反向票即僵局（零反向约束使任一同向永不生效），当场 escalated 交回用户。
    未达生效线仅记票（每次落票单事件，args 记 by/score 供审计）。"""
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t.get('kind') != 'review':
        sys.exit(f"错误：{a.id} 非 review 任务（kind={t.get('kind') or '（缺省）'}），无投票面")
    if not _mvote_active(t):
        sys.exit(f"错误：{a.id} 未启用 m 票（quorum_m={t.get('quorum_m') or '未声明，按 m=1'}）——"
                 "单评审员路径直接 done --verdict 落结论，无需投票")
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可投票")
    if not (0.0 <= a.score <= 1.0):
        sys.exit(f"错误：--score 须为 [0,1] 区间数值（得到 {a.score!r}）：恰 1=pass 票、恰 0=fail 票、"
                 "(0,1) 中间值=弃权")
    by = (a.by or '').strip()
    if not by:
        sys.exit('错误：--by 必填（落款即身份：投票评审员名；同一评审员每轮一票）')
    votes = t.setdefault('votes', [])
    if any(v.get('by') == by for v in votes):
        raise BoardError('duplicate_vote', task=a.id, by=by,
                         hint='同一评审员本轮已投过票（票不可撤改）；如需重投由用户 retry 清空票箱后重新评审')
    p_prev, f_prev, _ = _vote_tally(t)  # 本票落账前快照：判定本票是否为生效跃迁票（弃权票落已生效票箱不重复触发生效）
    votes.append({'by': by, 'score': a.score, 'ts': now_ms()})
    t['updated'] = now_ms()
    m = t['quorum_m']
    p, f, ab = _vote_tally(t)
    tally = f'pass {p}/fail {f}/弃权 {ab}'
    detail = '；'.join(f"{v['by']}:{v['score']:g}" for v in votes)
    ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
    if p >= 1 and f >= 1:
        # 僵局：反向票一经出现，零反向约束使任一同向永不生效（票不可撤改，等待剩余票不改变结局）
        # ——当场 escalated 交回用户（验收 d：2 pass+1 fail → 不生效且交回用户）。
        t['status'] = 'escalated'
        if _antistorm_enforced():  # T13：escalated 历史落档（执法开启时；retry 不清零）
            t['escalation_count'] = _escalation_history(t) + 1
        t.setdefault('checkpoints', []).append(
            {'time': ts, 'note': f"m 票评审（m={m}）出现反向票，零反向约束使任一同向永不生效"
                                 f"（{tally}；{detail}）→ escalated 交回用户处置"})
        save(path, data)
        show(t)
        print(f'  僵局收口：有反向票即任一同向永不生效（{tally}）→ 已升级 escalated，交回用户处置')
        print('  终态：不可 claim/done/vote，仅用户显式指令（retry 解除升级并清空票箱）可再动')
        return
    if f >= m:  # pass==0 由僵局分支先行拦截：fail 生效必然零 pass 票
        # fail 生效 → needs_revision 共享机制（repair 生成+DAG 重排+回 ready；m 票轮次上限 2）
        rnd = int(t.get('vote_round') or 1)
        failers = '、'.join(v['by'] for v in votes if v['score'] == 0)
        findings = (f"m 票评审第 {rnd} 轮 fail 生效（{tally}；fail 票：{failers}）——"
                    "各评审员发现明细见其 bus 汇报")
        t['vote_round'] = rnd + 1
        t['votes'] = []  # 本轮票箱清空（事件流可追溯），进入下一轮复审
        print(f'  fail 生效（{tally}，零反向票）→ 按 needs_revision 路径处理（评审轮次上限 {REVIEW_ROUND_LIMIT}）')
        _review_needs_revision(None, data, path, t, findings=findings,
                               limit=REVIEW_ROUND_LIMIT, limit_label='评审轮次上限')
        return
    if p >= m:
        # pass 生效：不自动收口——done 携带 summary 等收口审计，由显式 done --verdict pass 完成
        if not (p_prev >= m and f_prev == 0):  # 本票为跃迁票（此前未生效）：落生效检查点，仅一次
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"m 票评审 pass 生效（m={m}，{tally}，零反向票）——可 done --verdict pass 收口"})
            save(path, data)
            show(t)
            print(f'  pass 生效（{tally}，零反向票）：done --verdict pass 收口')
            return
        save(path, data)
        show(t)
        print(f'  已记票（{tally}）——pass 已生效（m={m}，零反向票），可 done --verdict pass 收口')
        return
    save(path, data)
    show(t)
    direction = 'pass' if f == 0 else 'fail'
    need = (m - p) if f == 0 else (m - f)
    print(f'  已记票（{tally}；{detail}）——未达生效线：同向需 ≥{m} 张且零反向票（还差 {need} 张 {direction} 票）')


# ── 滑动无进展 watchdog + 孤儿 adopt（v2.7，WP-4b/S2）────────────────────────
# 语义（对齐 swarm watchdog 原型）：
#   滑动窗口而非固定超时——activity = max(updated, heartbeat_at, nudged_at)，claim/progress/heartbeat/
#   reassign 都会推进它；「健康的孩子永远不会因为跑得久被杀」。窗口到期先 nudge（记数 + 置 nudged_at
#   重臂一个窗口），连续 max_nudges 次 nudge 无响应才升级：升级时先在落盘信箱（收件箱/归档/发件箱）
#   里找本任务本 attempt 的完成报告——找到则 adopt（采纳为 done，工作比它的 agent 活得久），找不到才
#   reclaim（撤销代际、释放回 ready）。计数与状态判定以事件流折叠状态为准，所有变更走既有事件追加路径
#   （watchdog/heartbeat 均为写命令，一个事件携带全部变更任务的 after 快照），既有命令 stdout/stderr
#   零变化；新字段 heartbeat_at/nudges/nudged_at 随任务快照折叠，向后兼容只增不减。
WATCHDOG_ACTIVITY_FIELDS = ('heartbeat_at', 'nudged_at')
# _WATCHDOG_EVAL 为 cmd_watchdog → _structured_data 的 --json data 载荷进程内暂存
# （v2.9 T2，_BUDGET_EVAL 同款先例）：五计数在扫描循环内统计，载荷与人类面汇总行
# （watchdog: nudge=N adopt=N reclaim=N healthy=N）同源，无变更早退分支同样填充。
_WATCHDOG_EVAL = {'payload': None}


def _reset_nudges(t):
    """活着的证据（claim 新代际/progress/heartbeat）：清零连续未响应 nudge 计数。"""
    t['nudges'] = 0
    t.pop('nudged_at', None)


def cmd_heartbeat(a, data, path):
    """heartbeat <id>：running 任务的心跳——重臂滑动无进展窗口并清零 nudge 计数（长任务主动报活，
    代替「必须产出检查点」的最小信号）。带 --attempt 时按代际校验（与 progress 同语义）。"""
    t = get_task(data, a.id)
    check_attempt(a, t)
    if t['status'] != 'running':
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 running 可心跳")
    t['heartbeat_at'] = now_ms()
    _reset_nudges(t)
    t['updated'] = t['heartbeat_at']
    save(path, data)
    show(t)


def _completion_evidence(tid, t, bus_root):
    """孤儿 adopt 证据（S2 断言 d）：在落盘信箱里找本任务、本 attempt、本 owner 的完成报告。
    检查位置：收件箱 coordinator/、归档 _archive/coordinator/（过代过滤误杀/整轮未读的最终去向）、
    发件箱 _outbox/<owner>/（投递中断的挂起副本）——「落盘即算送达」是 adopt 的立足点。
    完成报告判定（T11 回炉 M1/M2，确定性启发，针对本工作区实际汇报约定）：
    - 硬约束（缺一不可）：task 与 attempt_id 均与当前任务一致（防跨代采纳）、from==owner；
    - 强证据：subject 以「[交付]」开头 → 直接构成采纳证据（协议级显式交付标记，协议文本由 T12 写入，
      本工具只负责识别；能伪造该标记即能直改主板，同信任级别，不再叠加词汇启发）；
    - 词汇启发（无强证据时）：① body 不含负向词汇「继续/进行中/下一步/开始/即将/计划/待」任一——
      协议检查点模板词汇（「已完成…；产物:路径」）类过程汇报的负向守卫，防中途汇报被误标 done；
      ② 「完成」须出现在 subject（过程汇报的「完成」多在 body 叙述）；③ subject+body 含交付词汇
      （产物/改动/交付/文件/路径）。任务 id 字面不再是必要条件（M2：合规完成报告 subject 可无任务
      id 字面——硬约束已按结构化字段精确匹配，字面冗余检查只会把合规报告误判 reclaim、让证据随
      代际作废）。多条命中取 ts 最新（最终报告晚于过程汇报）。返回 (msg, 位置标记) 或 (None, '')。"""
    if not t.get('owner') or not t.get('attempt_id'):
        return None, ''
    locations = [
        ('inbox', os.path.join(bus_root, 'coordinator')),
        ('archive', os.path.join(bus_root, '_archive', 'coordinator')),
        ('outbox', os.path.join(bus_root, '_outbox', t['owner'])),
    ]
    delivery_words = ('产物', '改动', '交付', '文件', '路径')
    negative_words = ('继续', '进行中', '下一步', '开始', '即将', '计划', '待')  # M1①：过程汇报负向守卫（只看 body，规格如此）
    delivery_mark = '[交付]'  # M1③：协议交付标记强证据（识别先行，协议文本 T12 落地）
    best, best_loc, best_ts = None, '', -1
    for loc, d in locations:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if not name.endswith('.json'):
                continue
            try:
                with open(os.path.join(d, name), encoding='utf-8') as f:
                    m = json.load(f)
            except Exception:
                continue  # 信箱残件不阻塞 watchdog（bus.py 侧有自己的损坏语义）
            if not isinstance(m, dict):
                continue
            if m.get('task') != tid or m.get('attempt_id') != t.get('attempt_id') or m.get('from') != t.get('owner'):
                continue
            subject, body = m.get('subject', '') or '', m.get('body', '') or ''
            if not subject.startswith(delivery_mark):  # 强证据路径：身份约束外免词汇启发（见 docstring 威胁模型）
                if any(w in body for w in negative_words):  # M1①：负向词汇守卫——body 含过程词汇不作完成证据
                    continue
                if '完成' not in subject:  # M1②：「完成」须在 subject（过程汇报的「完成」多在 body 叙述）
                    continue
                if not any(w in f'{subject} {body}' for w in delivery_words):
                    continue
            ts = m.get('ts') if isinstance(m.get('ts'), int) and not isinstance(m.get('ts'), bool) else 0
            if ts > best_ts:
                best, best_loc, best_ts = m, loc, ts
    return best, best_loc


def cmd_watchdog(a, data, path):
    """watchdog：扫描全部 running 任务的滑动无进展窗口；到期 nudge（重臂），连续 max_nudges 次无响应
    升级——先查落盘完成报告（任务板检查点轨迹已由 activity 覆盖：检查点即 progress，天然重臂窗口；
    完成报告落盘证据在 bus 收件箱/归档/发件箱），有证据 adopt 为 done，无证据 reclaim 回 ready 并撤销
    当前代际。review kind 任务例外（T19 回炉，重要-1）：评审结论必须经显式 done --verdict 落地，
    watchdog 永不代答——即使发现落盘报告也照常 reclaim（回 ready 重新评审），防 verdict 门禁被绕过。
    全部变更合入一个 watchdog 事件（after 快照差分），stdout 为新增命令自有契约——三条升级线
    （nudge/adopt/reclaim）按升级信封格式输出（exposure-crypto-trust 收口：nudge=提示级
    【升级｜时间窗｜告警】带「本提示不阻断」尾行，adopt/reclaim=执行级【升级｜时间窗｜执行】
    不带尾行；格式规范见 SKILL.md §3）；telemetry 头行/汇总行/无变更分支与检查点落盘轨迹维持
    v2.7 字面（数据面与遥测面不是升级提示行）。
    adopt 显式记录实际执行者（executors，对齐手工 done --by 审计），汇总行输出 healthy 计数。"""
    window_ms = max(0, a.window_sec) * 1000
    max_nudges = max(0, a.max_nudges)
    bus_root = a.bus_root or os.path.join(os.getcwd(), '.expert-bus')
    now = now_ms()
    adopted, reclaimed, nudged, changed = 0, 0, 0, 0
    healthy = 0
    lines = []
    for tid in sorted(data['tasks'], key=lambda x: int(x[1:])):
        t = data['tasks'][tid]
        if t['status'] != 'running':
            continue
        activity = max([t.get('updated', 0)] + [t.get(k, 0) or 0 for k in WATCHDOG_ACTIVITY_FIELDS])
        stale_s = max(0, now - activity) // 1000
        if now - activity <= window_ms:
            healthy += 1  # 健康：窗口内有过活着的证据，永不因跑得久被盯上
            continue
        nudges = t.get('nudges') or 0
        if nudges < max_nudges:
            t['nudges'] = nudges + 1
            t['nudged_at'] = now  # nudge 重臂一个窗口；连续无响应计数不清零（progress/heartbeat 才清）
            ts = datetime.datetime.fromtimestamp(now / 1000).strftime('%Y-%m-%d %H:%M:%S')
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"watchdog: nudge 第{t['nudges']}次（无进展 {stale_s}s，window={a.window_sec}s）"})
            t['updated'] = now
            nudged += 1
            changed += 1
            lines.append(f"【升级｜时间窗｜告警】现状：任务 {tid} [running] owner={t['owner'] or '（未分配）'} 无进展 {stale_s}s"
                         f"（nudge={t['nudges']}/{max_nudges}）——已 nudge（重臂 window={a.window_sec}s，等 heartbeat/progress 响应）。"
                         f"建议：立即 heartbeat 或 progress 报活；工作已完成则落 done 收口。本提示不阻断。")
            continue
        m, loc = _completion_evidence(tid, t, bus_root)
        att = t.get('attempt_id') or ''
        if m is not None and t.get('kind') != 'review':
            # 重要-1（T19 回炉）：review 任务不进 adopt——评审员崩溃后残留的落盘报告不构成 verdict，
            # 采纳为 done 即绕过 pass 门禁；一律走下方 reclaim 回 ready 重新评审，结论须经显式
            # done --verdict 落地。
            summary = f"{m.get('subject', '')}：{(m.get('body') or '')[:160]}"
            t['status'] = 'done'
            t['summary'] = f"[watchdog adopt] {summary}"
            ts = datetime.datetime.fromtimestamp(now / 1000).strftime('%Y-%m-%d %H:%M:%S')
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"watchdog: adopt（发现落盘完成报告 {m.get('id')}@{loc}，attempt={att}）→ done"})
            # 采纳建议②：对齐手工 done --by 的审计丰富度——adopt 是异常路径（专家进程已死、由 watchdog
            # 代收），显式落 executors（证据消息 from==owner 即实际执行者），show/metrics 事后可追溯。
            t.setdefault('executors', []).append({'name': m.get('from') or t.get('owner') or '未知', 'time': ts})
            t['updated'] = now
            adopted += 1
            changed += 1
            lines.append(f"【升级｜时间窗｜执行】现状：任务 {tid} [running] owner={t['owner'] or '（未分配）'} 无进展 {stale_s}s"
                         f"（nudge={nudges}/{max_nudges} 达上限），发现落盘完成报告 {m.get('id')}@{loc}"
                         f"——已采纳为 done（完成标准：{t.get('desc', '')[:60]}）。"
                         f"建议：核对采纳内容与完成标准一致；误采纳走 reassign/recover 处置。")
        else:
            orig_owner = t.get('owner') or '未分配'
            if m is not None:  # review 任务有落盘报告也不采纳（verdict 门禁不可被 watchdog 代答）
                why_note = (f"review 任务有落盘报告 {m.get('id')}@{loc} 亦不采纳——评审结论必须经"
                            "显式 done --verdict 落地，门禁不可代答")
                why_line = '落盘报告不代答 verdict（评审结论须经显式 done --verdict 落地）'
            else:
                why_note = f"{max_nudges} 次 nudge 无响应且无落盘完成证据"
                why_line = '无落盘完成证据'
            t['status'] = 'ready'
            if att:
                t.setdefault('attempt_revoked', []).append(att)  # 孤儿代际撤销：旧 attempt 的迟到汇报按 stale_attempt 拒
                t.pop('attempt_id', None)
            t['owner'] = ''
            t['nudges'] = 0
            t.pop('nudged_at', None)
            t.pop('heartbeat_at', None)
            # T20 回炉（评审重要-1）：reclaim 回 ready 重新评审——m 票任务清空票箱、重置轮次（自动路径
            # 无人操作即可触发，旧票跨轮残留的危害最大：假 pass 生效收口或假僵局）。
            mvote = _mvote_reset_ballot(t)
            ts = datetime.datetime.fromtimestamp(now / 1000).strftime('%Y-%m-%d %H:%M:%S')
            t.setdefault('checkpoints', []).append(
                {'time': ts, 'note': f"watchdog: reclaim（{why_note}）→ ready；attempt {att or '（无）'} 已撤销"
                                     + ('；m 票票箱已清空、评审轮次重置' if mvote else '')})
            t['updated'] = now
            reclaimed += 1
            changed += 1
            lines.append(f"【升级｜时间窗｜执行】现状：任务 {tid} [running] owner=（原 {orig_owner}）无进展 {stale_s}s"
                         f"（nudge={nudges}/{max_nudges} 达上限）——已 reclaim（{why_line}；attempt {att or '（无）'} 撤销，"
                         f"转 ready 待重新派工）。建议：重新派工（claim/reassign）或上报用户附升级报告三要素。")
    # --json data 载荷（v2.9 T2）：扫描一结束即暂存，无变更早退与有变更两分支同源覆盖
    #（adopted/reclaimed/nudged/healthy/changed 与人类面汇总行同口径，changed=本轮实际变更数）。
    _WATCHDOG_EVAL['payload'] = {'adopted': adopted, 'reclaimed': reclaimed,
                                 'nudged': nudged, 'healthy': healthy, 'changed': changed}
    if not lines:
        if healthy:
            print(f"watchdog: {healthy} 个 running 任务全部健康（window={a.window_sec}s 内均有活动证据，未做任何变更）")
        else:
            print(f"watchdog: 无 running 任务（window={a.window_sec}s max_nudges={max_nudges}）")
        return
    if changed:
        promoted = refresh(data)
        save(path, data)
        if promoted:
            lines.append('依赖已满足，自动转 ready: ' + ' '.join(promoted))
    else:
        lines.append('（本轮无变更）')
    print(f"watchdog: window={a.window_sec}s max_nudges={max_nudges} bus_root={bus_root}")
    for ln in lines:
        print(ln)
    # 采纳建议③：有变更轮次也输出 healthy 计数（健康任务不因同轮有变更而不可见；无变更轮次的
    # 「全部健康」分支本就带计数，两分支口径一致）。
    print(f"watchdog: nudge={nudged} adopt={adopted} reclaim={reclaimed} healthy={healthy}")


# ── #16 per-(任务,专家) 工具调用硬预算（v2.8 M8-2 / WP-7 ①，T27）─────────────
# 执法面唯一落点（专家经 bash 直呼 taskboard.py，JS lib 拦不到也不该拦）；lib/budget.js 只做
# budget --json 信封的 summon 消费面（#20 自动续领亦复用 claim 路径即自动受预算约束）。


def budget_enabled(env=None):
    """预算总开关（T27 裁定：默认关闭，显式开启——与 DSH_EXPERT_CWD_LOCK 同款 opt-in 语义）：
    DSH_EXPERT_TOOL_BUDGET 置 '0'/''/未设置 = 关（写路径零变化：不读事件流、不加章、不拒绝），
    置任何其他值 = 开。预算门含阻断型档位（interrupt 拒绝调用），破坏性默认不由工具单方面
    引入；排障可临时置 '0'（须在专家派发环境生效——专家进程继承派发时环境）。"""
    env = os.environ if env is None else env
    flag = env.get('DSH_EXPERT_TOOL_BUDGET')
    return not (flag is None or flag == '' or flag == '0')


def budget_thresholds(env=None):
    """三档阈值解析：DSH_EXPERT_TOOL_BUDGET_ALARM / _WRAPUP / _INTERRUPT 各为十进制整数 ≥1；
    未设置回默认（200/250/300——即使显式开启，缺省阈值也高到不干扰正常任务，二档保守原则）。
    非法（非整数 / <1 / 违背 alarm ≤ wrap-up ≤ interrupt）返回 None：预算按未启用处理并 stderr
    告警——配置错误 fail-open，绝不因配置笔误炸掉执行面（对齐 hook 降级语义）。"""
    env = os.environ if env is None else env
    th = {}
    for tier, key in (('alarm', 'DSH_EXPERT_TOOL_BUDGET_ALARM'),
                      ('wrap-up', 'DSH_EXPERT_TOOL_BUDGET_WRAPUP'),
                      ('interrupt', 'DSH_EXPERT_TOOL_BUDGET_INTERRUPT')):
        raw = env.get(key)
        if raw is None or raw == '':
            th[tier] = DEFAULT_BUDGET_THRESHOLDS[tier]
            continue
        try:
            v = int(str(raw).strip(), 10)
        except ValueError:
            print(f'警告：预算阈值配置非法（{key}={raw!r} 非十进制整数）——预算按未启用处理（fail-open）', file=sys.stderr)
            return None
        if v < 1:
            print(f'警告：预算阈值配置非法（{key}={raw!r} 须 ≥1）——预算按未启用处理（fail-open）', file=sys.stderr)
            return None
        th[tier] = v
    if not (th['alarm'] <= th['wrap-up'] <= th['interrupt']):
        print(f"警告：预算阈值须 alarm ≤ wrap-up ≤ interrupt（当前 alarm={th['alarm']} "
              f"wrap-up={th['wrap-up']} interrupt={th['interrupt']}）——预算按未启用处理（fail-open）", file=sys.stderr)
        return None
    return th


def budget_tier(count, th):
    """档位判定（语义固定、阈值可配）：计数达到 interrupt 阈值=中断档、达到 wrap-up=收尾档、
    达到 alarm=告警档（thresholds 已保证 alarm ≤ wrap-up ≤ interrupt，高档优先）。"""
    if not th:
        return None
    if count >= th['interrupt']:
        return 'interrupt'
    if count >= th['wrap-up']:
        return 'wrap-up'
    if count >= th['alarm']:
        return 'alarm'
    return None


def budget_counts(events, task_id, epoch=0):
    """事件溯源计数（验收 a 的唯一计数实现）：只认事件流中可归因到 (task_id, 专家) 的执行面
    写命令事件。归因规则：vote 以 args.by 落款（陪审员身份，非任务 owner）；其余类型取 after
    快照 owner（claim 后快照 owner 即认领方；done --by 仅审计不改归因——计数按调用方=owner）。
    状态护栏：只计任务处于执行/终态（running/done/failed）的触碰——done needs_revision 的原任务
    回 ready 与自动生成的 repair（pending）、下游改挂（pending/ready）天然不计入，防多任务 after
    快照的幽灵归因。模型自报不入境：计数输入只有事件流结构化字段，bus 消息/检查点文本永不解析。
    epoch（纪元）：只计 seq > epoch 的事件（budget --reset 推进，缺省 0=全史累计）。"""
    counts = {}
    for ev in events:
        if not isinstance(ev, dict):
            continue
        seq = ev.get('seq')
        if isinstance(seq, int) and not isinstance(seq, bool) and seq <= epoch:
            continue
        typ = ev.get('type')
        if typ not in BUDGET_COUNTED_TYPES:
            continue
        after = ev.get('after')
        if not isinstance(after, dict):
            continue
        args = ev.get('args') if isinstance(ev.get('args'), dict) else {}
        for tid, snap in after.items():
            if tid != task_id or not isinstance(snap, dict):
                continue
            expert = args.get('by') if typ == 'vote' else snap.get('owner')
            if not isinstance(expert, str) or not expert:
                continue
            status = snap.get('status')
            if status == 'running' or (typ == 'done' and status == 'done') or (typ == 'fail' and status == 'failed'):
                counts[expert] = counts.get(expert, 0) + 1
    return counts


def _budget_epoch_of(t):
    """任务快照中的计数纪元（budget --reset 写入，缺省 0=全史累计）。"""
    b = (t or {}).get('budget') or {}
    e = b.get('epoch')
    return e if isinstance(e, int) and not isinstance(e, bool) and e >= 0 else 0


def budget_owner_of(a, t):
    """预算门的调用方身份：vote 以 --by 落款（陪审员）；claim 取显式 --owner 或既有 owner
    （gate 时点认领尚未发生，快照 owner 是认领前状态）；claim_idle 取认领方 owner（候选在
    gate 时点尚无 owner，归因即认领请求方——#20 空闲续领受 #16 预算约束的接线点）；其余
    类型取任务 owner。空串=不可归因（ownerless 任务/无落款投票——预算门跳过，交由命令自身
    语义处置）。"""
    if a.cmd == 'vote':
        return a.by or ''
    if a.cmd == 'claim':
        return a.owner or (t.get('owner') or '')
    if a.cmd == 'claim_idle':
        return a.owner or ''
    return t.get('owner') or ''


def _budget_stamp(t, tier, owner, count, th):
    """档位章（升档时写入任务快照，随所在命令自身事件落账——不加事件、不触 updated：
    档位章不是活动信号，不重臂 watchdog 窗口，时间面与调用量面互补不串扰）。"""
    ts = now_ms()
    t['budget'] = {'tier': tier, 'who': owner, 'count': count, 'at': ts,
                   **({'epoch': t['budget']['epoch']} if isinstance((t.get('budget') or {}).get('epoch'), int) else {})}
    stamp = datetime.datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M:%S')
    action = ('推进类调用此后将被拒绝，交付出口 done/fail 保留' if tier == 'interrupt'
              else '请收敛：尽快交付 done/fail，勿再展开新阶段' if tier == 'wrap-up'
              else '注意调用开销')
    t.setdefault('checkpoints', []).append(
        {'time': stamp, 'note': f"budget: {tier}（{owner} 执行面调用计数 {count} 达阈值 {th[tier]}）——{action}"})


def _append_budget_event(path, data, a, owner, count, th, ts):
    """追加 type='budget' 系统事件（interrupt 首拒留账）：链式 hash/revision 语义与 commit_event
    一致（revision+1=一次板写；after 只携带预算簿记快照），视图原子重写。防御：事件流为空时
    放弃留账——「计数>0 且事件流为空」互斥（计数源自事件流），该形态只可能来自手工损坏，
    保折叠不变量（首事件必须能作收编种子）优先于留账；拒绝本身照常生效。"""
    prev_seq, prev_hash = _prev_of_log(path)
    if prev_seq == 0:
        print('警告：预算拒绝留账跳过（事件流为空，与计数>0 互斥——疑似手工损坏；拒绝仍生效）', file=sys.stderr)
        return
    new_rev = int(data.get('revision', 0)) + 1
    data['revision'] = new_rev
    ev = {'seq': prev_seq + 1, 'ts': ts, 'type': 'budget',
          'args': {'action': 'refuse', 'cmd': a.cmd, 'task': a.id, 'owner': owner,
                   'count': count, 'tier': 'interrupt', 'thresholds': dict(th)},
          'after': {a.id: data['tasks'][a.id]},
          'board_seq': int(data.get('seq', 0)), 'revision': new_rev, 'prev': prev_hash}
    ev['state_hash'] = _state_hash(data)  # 先算状态 hash，事件 hash 覆盖含 state_hash 的全部其余字段
    ev['hash'] = _event_hash(ev)
    _append_event(path, ev)
    save_view(path, {'tasks': data['tasks'], 'seq': int(data.get('seq', 0)), 'revision': new_rev,
                     'event_seq': ev['seq'], 'event_state_hash': ev['state_hash']})


def _budget_refuse(a, data, path, t, owner, count, th):
    """interrupt 档拒绝（验收 b 中断档行为面）：推进类调用当场拒绝。首次拒绝落一条
    type='budget' 系统事件（interrupt 章+refused 标记+检查点）保证「达阈值触发对应档位行为
    且事件可见」，后续拒绝读快照 refused 标记幂等跳过——拒绝绝不刷事件。fail-safe：拒绝发生
    在任何命令变更之前（命令自身零写、零事件），预算事件只追加簿记（不动 status/owner/代际/
    updated——拒绝不重臂 watchdog 窗口，预算卡死的任务交 watchdog 时间面接管）。"""
    b = t.get('budget') or {}
    ts = now_ms()
    if not b.get('refused'):
        t['budget'] = {**({'epoch': b['epoch']} if isinstance(b.get('epoch'), int) else {}),
                       'tier': 'interrupt', 'who': owner, 'count': count, 'at': ts,
                       'refused': True, 'refused_cmd': a.cmd}
        stamp = datetime.datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('checkpoints', []).append(
            {'time': stamp,
             'note': f"budget: interrupt（{owner} 执行面调用计数 {count} 达硬预算 {th['interrupt']}，拒绝 {a.cmd}）——"
                     '交付出口 done/fail 保留；推进类调用已停，续作交编排者处置（换人/--reset 重置/收口）'})
        _append_budget_event(path, data, a, owner, count, th, ts)
    raise BoardError('budget_interrupted', task=a.id, owner=owner, count=count, tier='interrupt',
                     refused_cmd=a.cmd, threshold=th['interrupt'],
                     hint='执行面调用已达硬预算（事件流计数），本次调用被拒且未落账；交付出口（done/fail）不受影响'
                          '——请立即收敛交付，或 fail 交回编排者处置（编排者可 budget --reset 显式重置或改派他人）')


def budget_gate(a, data, path, stamp_sink=None):
    """#16 预算门（写命令派发前，main 派发点调用）：执行面命令（BUDGET_COUNTED_TYPES）按
    「本次调用前已完成的事件流计数」定档——计数只读（绝不写事件流，防自激）；alarm/wrap-up
    非阻断（升档章随本命令自身事件落账 + stderr 提示）；interrupt 拒推进类调用（首拒落
    budget 事件），交付出口 done/fail/vote 永不拒绝。计数/评估内部错误 fail-open（stderr
    告警放行）——预算是成本护栏非正确性屏障；BoardError（板损坏 unrecoverable）原样上抛
    不吞。任务不存在/不可归因（ownerless）→ 交由命令自身语义处置，预算门不越位。
    stamp_sink（v2.9 T11 章延后，缺省 None=行为不变）：传入 list 时升档章不就地落快照，改以
    (任务, tier, owner, count, th) 元组追加到 sink，由调用方在全部候选门判定通过后统一落章、
    随其自身事件入账——供单命令多候选门（claim_idle）隔离「门判定」与「章应用」：拒绝事件
    以发生时点的 data 算 state_hash 且 after 只携带被拒任务，任何「已就地改写而未落账」的
    其他任务都会使折叠对账失配（T10 评审 🔴-1 砖化）。"""
    if not budget_enabled():
        return
    th = budget_thresholds()
    if th is None:
        return  # 阈值非法：budget_thresholds 已 stderr 告警，按未启用处理（fail-open）
    tid = getattr(a, 'id', None)
    t = data['tasks'].get(tid) if isinstance(tid, str) else None
    if not isinstance(t, dict):
        return
    owner = budget_owner_of(a, t)
    if not owner:
        return
    try:
        count = budget_counts(read_events(path), tid, _budget_epoch_of(t)).get(owner, 0)
    except BoardError:
        raise  # 板损坏按全局 unrecoverable 语义上抛，绝不吞
    except Exception as e:
        print(f'警告：预算计数失败（本次放行，fail-open）：{e}', file=sys.stderr)
        return
    tier = budget_tier(count, th)
    if tier == 'interrupt' and a.cmd in BUDGET_REFUSABLE_TYPES:
        _budget_refuse(a, data, path, t, owner, count, th)  # 内部 raise BoardError('budget_interrupted')
        return
    if tier:
        announced = BUDGET_TIER_RANK.get((t.get('budget') or {}).get('tier'), 0)
        if BUDGET_TIER_RANK[tier] > announced:
            if stamp_sink is not None:
                stamp_sink.append((t, tier, owner, count, th))  # 章延后：调用方在全部候选门通过后统一落章
            else:
                _budget_stamp(t, tier, owner, count, th)  # 升档章随本命令自身事件落账（零额外事件）
        if tier == 'interrupt':
            print(f"[budget] 硬预算已到（计数 {count}/{th['interrupt']}）：本调用为交付出口（done/fail），"
                  '请立即完成交付或 fail 交回编排者', file=sys.stderr)
        elif tier == 'wrap-up':
            print(f"[budget] 收尾档（计数 {count}/{th['wrap-up']}）：请立即收敛——尽快交付 done/fail，"
                  '勿再展开新阶段', file=sys.stderr)
        else:
            print(f"[budget] 告警档（计数 {count}/{th['alarm']}）：注意执行面调用开销，保持收敛", file=sys.stderr)


def budget_evaluate(data, path, tid, repair=True):
    """只读预算评估（验收 a 的机器消费面，cmd_budget 用）：per-(任务,专家) 事件流计数+档位。
    本函数绝不写事件流/视图——计数读与写隔离，封死「计数动作自身产生事件」的自激回路。
    repair=False（v2.9 T3/T38-1 无锁快照盘点）：计数读走 read_events 快照变体（残尾容忍、
    零自愈写），语义与其余读路径一致。"""
    t = data['tasks'].get(tid)
    th = budget_thresholds() if budget_enabled() else None
    counts = {}
    if th is not None:
        try:
            counts = budget_counts(read_events(path, repair=repair), tid, _budget_epoch_of(t))
        except BoardError:
            raise
        except Exception as e:
            print(f'警告：预算计数读取失败（按 0 计，fail-open）：{e}', file=sys.stderr)
    budgets = [{'owner': owner, 'count': counts[owner], 'tier': budget_tier(counts[owner], th)}
               for owner in sorted(counts)]
    return {'enabled': th is not None, 'thresholds': th, 'epoch': _budget_epoch_of(t),
            'stamped': (t.get('budget') or None) if isinstance(t, dict) else None,
            'budgets': budgets}


def cmd_budget(a, data, path):
    """budget <id>（#16，T27）：per-(任务,专家) 工具调用硬预算盘点/重置。缺省（无 --reset）为
    只读评估——零写零事件（计数以事件流为唯一事实源，读路径绝不产生事件，验收 (a) 反自激）；
    --json 信封 data.budget 携带 {enabled,thresholds,epoch,stamped,budgets:[{owner,count,tier}]}
    （v2.8 S1 机器消费面契约，报告型命令 data 恒非空）。--reset 为编排者显式重置：计数纪元
    推进到当前事件 seq（此前历史计数不再计入——per-(任务,专家) 跨代累计语义下的唯一放行出口，
    事件+检查点留痕），档位章与拒绝标记一并清除。budget 自身是编排面命令，不计入任何专家
    预算、也不受预算门约束。"""
    t = get_task(data, a.id)
    # 无锁快照盘点标记（v2.9 T3/T38-1）：main 对 budget（无 --reset）走无锁分支时置位——
    # 计数读随之走 read_events(repair=False) 快照变体（零自愈写）。--reset 恒走锁内写路径。
    snapshot_read = bool(getattr(a, 'tb_snapshot_read', False))
    if a.reset:
        ts = now_ms()
        epoch = int(data.get('event_seq', 0) or 0)
        t['budget'] = {'epoch': epoch, 'reset_at': ts}
        t['updated'] = ts
        stamp = datetime.datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M:%S')
        t.setdefault('checkpoints', []).append(
            {'time': stamp,
             'note': f'budget: reset（编排者显式重置计数纪元 → 事件 seq≥{epoch} 重新计数；档位章与拒绝标记已清除）'})
        save(path, data)
        show(t)
        print(f'预算纪元已重置: {a.id}（事件 seq≥{epoch} 重新计数）')
    payload = budget_evaluate(data, path, a.id, repair=not snapshot_read)
    _BUDGET_EVAL['payload'] = payload
    th = payload.get('thresholds') or {}
    if payload.get('enabled'):
        print(f"budget {a.id}: 开关=开（alarm={th.get('alarm')} wrap-up={th.get('wrap-up')} "
              f"interrupt={th.get('interrupt')}）纪元=seq≥{payload.get('epoch', 0)}")
    else:
        print(f'budget {a.id}: 开关=关（DSH_EXPERT_TOOL_BUDGET 未开启，计数与档位不生效；'
              '开启后执行面命令按事件流计数）')
    if payload.get('stamped'):
        s = payload['stamped']
        print(f"  档位章: {s.get('tier')} by {s.get('who')} @计数{s.get('count')}"
              + ('（已发生 interrupt 拒绝）' if s.get('refused') else ''))
    for row in payload.get('budgets') or []:
        print(f"  {row['owner']}: 已计 {row['count']} 次 → 档位 {row['tier'] or '（未达档）'}")
    if not (payload.get('budgets') or []):
        print('  （无归因计数——仅执行面命令 claim/progress/heartbeat/done/fail/own/vote 计入，'
              '编排面与系统事件不计）')


def cmd_recover(a, data, path):
    """recover：全部 running 任务回 ready（会话中断后的兜底恢复）。m 票任务（T20 回炉，评审重要-1）：
    回 ready 即重新评审——清空票箱、重置轮次，防旧票跨轮残留跨入新轮计票（假 pass 生效或假僵局）；
    全部清空随本次 save 的单事件 after 快照落事件流。"""
    ts = datetime.datetime.fromtimestamp(now_ms() / 1000).strftime('%Y-%m-%d %H:%M:%S')
    n = 0
    for t in data['tasks'].values():
        if t['status'] == 'running':
            t['status'] = 'ready'
            t['updated'] = now_ms()
            if _mvote_reset_ballot(t):
                t.setdefault('checkpoints', []).append(
                    {'time': ts, 'note': 'recover：回 ready；m 票票箱已清空、评审轮次重置（重新投票）'})
            n += 1
    save(path, data)
    print(f'已恢复 {n} 个 running 任务为 ready')


def cmd_reassign(a, data, path):
    """转派：先拒绝复活任何已撤销代际，再撤销旧 attempt（记入 attempt_revoked），建立新代际；
    旧代际的 done/fail/progress 随后被拒。draft/rejected/escalated 不可转派（草案未进派工面、
    终态不可再动——escalated 须用户显式 retry 解除升级后重新走 claim/reassign）。
    代际能力化（T7）：新 attempt_id 传保留字 'auto' 时由工具生成不可猜 token（at-<16hex>）；
    --attempt <当前代际> 为 peer 互派持有证明——按 check_attempt 口径校验当前开放代际，且限任务
    当前 owner==自己（R1 投影：token 只随任务书下发给当前 owner，持当前开放代际即视作 owner 本人；
    CLI 无鉴权，防误用非防伪造）；持有证明与自报新 attempt_id 混用拒绝（attempt_source_conflict，
    peer 通道新 token 必须工具生成——宁拒勿错）。不带 --attempt 且不自报 'auto' 时与旧版逐字节一致。"""
    t = get_task(data, a.id)
    if t['status'] == 'draft':
        sys.exit(f"错误：{a.id} 为 PM 规划草案（draft），未经 approve 批准不可转派")
    if t['status'] == 'rejected':
        sys.exit(f"错误：{a.id} 已否决（rejected 终态），不可转派")
    if t['status'] == 'escalated':
        sys.exit(f"错误：{a.id} 已升级（escalated），等待用户处置，不可转派；用户显式 retry 可解除升级")
    # ── T13 escalation 上限执法（Q7）：env DSH_EXPERT_ANTISTORM_ENFORCE 显式开启且该任务
    # escalated 历史（escalation_count，用户 retry 不清零）已达 DSH_EXPERT_ESCALATION_LIMIT
    # （缺省 1）→ reassign 双通道（peer 持证明/编排者自报）均具名拒 escalation_limit_exceeded
    # ——编排者不得经自动重派绕行（bus 口径：达到限额后处置权归用户，用户显式 retry 解除
    # 升级后仍须交用户裁决后续，不可自动再派）。判定先于任何变更与 save（零写零事件）；
    # 缺省关闭零行为变化。
    if _antistorm_enforced() and _escalation_history(t) >= _escalation_limit():
        raise BoardError('escalation_limit_exceeded', task=a.id,
                         escalation_count=_escalation_history(t), limit=_escalation_limit(),
                         hint='该任务 escalated 历史已达上限（探针：show 检查点轨迹中 escalated '
                              '记录次数 + status 的「已升级待用户处置」行）；编排者不得自动重派，'
                              '上报用户裁决后由用户显式指令决定后续')
    proof = getattr(a, 'attempt', None)
    generated = a.attempt_id == 'auto'  # 保留触发词：工具生成不可猜 token（T7）
    if proof is not None and not generated:
        raise BoardError('attempt_source_conflict', attempt=proof, proposed=a.attempt_id,
                         hint='peer 互派须用工具生成的新 token：reassign <id> auto --attempt <当前代际>；'
                              '自报新 attempt_id 只属于编排者通道（不带 --attempt）')
    if proof is not None:
        # 持有证明：当前开放代际校验（no_attempt/stale_attempt 具名拒绝、零写零事件）。
        # T14：caller 显式传当前 owner（持有证明即 owner 本人，R1 投影）；--owner 是新 owner
        # 非调用方身份，不作为绑定校验的申报（显式传参绕开 --by/--owner 通用推断）。
        check_attempt(a, t, caller=t.get('owner'))
        if not t.get('owner'):
            raise BoardError('not_task_owner', owner=t.get('owner'),
                             hint='peer 互派通道要求任务当前有 owner（owner==自己的板面投影：持有证明即 owner 身份，'
                                  'R1 防误用非防伪造）；无主任务的派发权在编排者通道（不带 --attempt）')
        # ── T13 反风暴 open 上限执法（Q7）：peer 通道核查新 owner（--owner 指定或保持当前
        # owner）在本次转派完成后名下 open 计数不超 DSH_EXPERT_PEER_OPEN_CAP（缺省 2）；
        # 缺省关闭零行为变化；判定先于任何变更与 save（零写零事件）。
        _check_open_cap(a.owner or t['owner'], data, acquiring_task_id=a.id)
    old = t.get('attempt_id')
    revoked = t.get('attempt_revoked') or []
    if generated:
        token = 'at-' + uuid.uuid4().hex[:16]  # at-<16hex>：不可猜（T7 任务书口径）
        while token in revoked or token == old:  # token 不可猜，绝不撞已撤销代际/当前代际
            token = 'at-' + uuid.uuid4().hex[:16]  # T12 评审🟢2：重试分支同为 at-<16hex>，防撞口径不变
        new_id = token
        if _EVT_CTX.get('armed'):  # 事件 args 留痕生成方式（仅生成模式改写，旧通道 args 形状不变）
            _EVT_CTX['args']['attempt_id'] = new_id
            _EVT_CTX['args']['generated'] = True
            if proof is not None:
                _EVT_CTX['args']['proof_attempt'] = proof
    else:
        if a.attempt_id in revoked:
            raise BoardError('stale_attempt', attempt=a.attempt_id, current=old,
                             revoked=revoked,
                             hint='该 attempt 已被撤销，不能经 reassign 复活；请使用全新的 attempt_id')
        new_id = a.attempt_id
    if old and old != new_id:
        t.setdefault('attempt_revoked', []).append(old)
    t['attempt_id'] = new_id
    _reset_nudges(t)  # 新代际=新起点：旧代积攒的未响应 nudge 不带入
    t.pop('heartbeat_at', None)
    if a.owner:
        t['owner'] = a.owner
    # ── T14 代际 owner 绑定（Q2）：reassign 双通道建代际时落 attempt_owner=落定 owner
    # （编排者通道 --owner 指定 / peer 通道保持当前 owner），事件 args 留痕同 claim；
    # env DSH_EXPERT_ATTEMPT_BIND_OWNER 关闭不落字段不写 args（逐字节一致）。
    if _attempt_bind_enforced():
        t['attempt_owner'] = a.owner or t['owner']
        if _EVT_CTX.get('armed'):
            _EVT_CTX['args']['attempt_owner'] = t['attempt_owner']
    t['updated'] = now_ms()
    save(path, data)
    show(t)
    print(f"旧 attempt {old or '（无）'} 已撤销，当前代际 {new_id}")


def cmd_set_dependencies(a, data, path):
    """改依赖：写入前全图环检测；仅 pending/ready 可改，满足/不满足时在 pending<->ready 间自动流转。"""
    t = get_task(data, a.id)
    if t['status'] not in ('pending', 'ready'):
        sys.exit(f"错误：{a.id} 状态为 {t['status']}，只有 pending/ready 可改依赖")
    deps = [d.strip() for d in (a.dep or '').split(',') if d.strip()]
    for d in deps:
        if d not in data['tasks']:
            sys.exit(f"错误：依赖任务 {d} 不存在")
    ensure_acyclic(data['tasks'], a.id, deps)
    t['dep'] = deps
    ok, _ = deps_state(t, data['tasks'])
    if t['status'] == 'pending' and ok:
        t['status'] = 'ready'
        t['updated'] = now_ms()
    elif t['status'] == 'ready' and not ok:
        t['status'] = 'pending'
        t['updated'] = now_ms()
    save(path, data)
    show(t)


def cmd_deps(a, data, _):
    t = get_task(data, a.id)

    def walk(task, depth, seen):
        print('  ' * depth + f"{task['id']} [{task['status']}] {task['title']}")
        for d in task['dep']:
            if d in seen:
                print('  ' * (depth + 1) + f"{d}（循环引用，已跳过）")
                continue
            seen.add(d)
            walk(data['tasks'][d], depth + 1, seen)

    walk(t, 0, {a.id})


def cmd_status(a, data, _):
    counts = {}
    for t in data['tasks'].values():
        counts[t['status']] = counts.get(t['status'], 0) + 1
    print('状态统计: ' + (' '.join(f"{k}={v}" for k, v in sorted(counts.items())) or '空'))
    ready = [t for t in data['tasks'].values() if t['status'] == 'ready']
    failed = [t for t in data['tasks'].values() if t['status'] == 'failed']
    running = [t for t in data['tasks'].values() if t['status'] == 'running']
    if ready:
        print('可认领: ' + ' '.join(t['id'] for t in ready))
    if running:
        print('进行中: ' + ' '.join(t['id'] for t in running))
    if failed:
        print('失败待重试: ' + ' '.join(t['id'] for t in failed))
    draft = [t for t in data['tasks'].values() if t['status'] == 'draft']
    if draft:
        print('待批准草案: ' + ' '.join(t['id'] for t in draft))  # 批准面盘点入口（无 draft 时零输出）
    escalated = [t for t in data['tasks'].values() if t['status'] == 'escalated']
    if escalated:
        print('已升级待用户处置: ' + ' '.join(t['id'] for t in escalated))  # escalated 盘点入口（无则零输出）
    for t in running + failed:
        cp = last_checkpoint(t)
        if cp:
            print(f"  {t['id']} 最新检查点: [{cp['time']}] {cp['note']}")


def cmd_metrics(a, data, _):
    if not data['tasks']:
        print('（任务板为空，无数据可聚合）')
        return
    agg = {}
    for t in data['tasks'].values():
        if t['status'] in ('draft', 'rejected'):
            continue  # 未开工条目不计入 owner 工作量指标（draft 草案未批准、rejected 已否决）
        o = t['owner'] or '（未分配）'
        s = agg.setdefault(o, [0, 0, 0])
        s[0] += 1
        s[1] += t.get('rework') or 0
        if t.get('switched'):
            s[2] += 1
    for o, (n, rw, sw) in sorted(agg.items(), key=lambda kv: (-kv[1][0], kv[0])):
        print(f"{o} | 任务数 {n} | 累计返工 {rw} | 换人 {sw}")


# ── open-counts 反风暴只读查询（T9，阶段二-T3）────────────────────────────────
_OPEN_COUNTS_EVAL = {'payload': None}  # cmd_open_counts 暂存 --json 专用载荷（_structured_data 取用，watchdog 同模式）
_OPEN_STATUSES = ('draft', 'pending', 'ready', 'running')  # open 口径：draft 计入（待批准草案占人）、终态一律不计入


def cmd_open_counts(a, data, _):
    """按 owner 聚合 open 任务计数与清单。零写零事件；main 派发走无锁快照（budget T38-1 先例，
    load(repair=False)），结果=事件流某一完整前缀的折叠（快照级一致性）。R1 口径如实声明：
    owner 以板面自报为准，防误用不防伪造；Q7 裁决的写面超限执法已在 T13 经显式 env 开关
    （DSH_EXPERT_ANTISTORM_ENFORCE，缺省关闭）落地（见下方反风暴写面执法 helper 面），本命令
    仍是编排者核查探针（协议纪律：超限不批准/不派转上报）。"""
    only = (getattr(a, 'owner', None) or '').strip()
    groups = {}
    for t in data['tasks'].values():
        if t['status'] not in _OPEN_STATUSES:
            continue
        groups.setdefault(t['owner'] or '', []).append(t['id'])
    for ids in groups.values():
        ids.sort()
    payload = {o: {'count': len(ids), 'tasks': ids} for o, ids in sorted(groups.items())}
    if only:
        payload = {only: payload.get(only, {'count': 0, 'tasks': []})}
    _OPEN_COUNTS_EVAL['payload'] = payload
    if all(g['count'] == 0 for g in payload.values()):
        print(f"{only}: 0 个开放任务" if only else '（无开放任务）')
        return
    for o, g in sorted(payload.items()):
        print(f"{o or '（无主）'}: {g['count']} 个开放任务: {' '.join(g['tasks'])}")


# ── 反风暴写面执法 helper（T13，Q7 兑现）────────────────────────────────────
# 总开关 DSH_EXPERT_ANTISTORM_ENFORCE 缺省关闭：关闭时下列 helper 一律立即返回/返回关态，
# 写路径零变化（不读阈值 env、不计数、不拒绝）=现状逐字节（双版本回归 selftest 钉死旧路径）；
# 显式开启（任意非空值）后：
# - open 上限（DSH_EXPERT_PEER_OPEN_CAP，缺省 2）：approve 代理自建草案（核查 created_by）、
#   reassign peer 通道（核查新 owner）、claim/claim_idle（核查认领方，claim_idle 逐候选判）
#   四写点按 open-counts 口径（_OPEN_STATUSES，main 统一 board_lock 锁内权威快照）执法，
#   超限具名拒 open_cap_exceeded——判定先于任何变更与 save（零写零事件，revision/事件流零
#   变化）；hint 统一指 taskboard.py open-counts <owner> 探针（T9 只读查询）。
# - escalation 上限（DSH_EXPERT_ESCALATION_LIMIT，缺省 1）：任务 escalated 历史
#   （escalation_count 字段，执法开启期间每次进入 escalated 落档、用户 retry 不清零——清零
#   会让上限永不触发）达限后：needs_revision 不再自动生成 repair（拒绝 repair 绕行，直升
#   escalated 强制上报用户处置）、reassign 双通道自动重派具名拒 escalation_limit_exceeded；
#   retry 用户出口既有执法不动。
# R1 口径如实声明：owner/created_by 以板面自报为准（CLI 无鉴权，防误用非防伪造）；
# escalation_count 仅覆盖执法开启期间的 escalated（关闭期/旧板历史按 0 计，不回溯注记文本
# ——注记非契约）。
_ANTISTORM_ENFORCE_ENV = 'DSH_EXPERT_ANTISTORM_ENFORCE'
_PEER_OPEN_CAP_ENV = 'DSH_EXPERT_PEER_OPEN_CAP'
_ESCALATION_LIMIT_ENV = 'DSH_EXPERT_ESCALATION_LIMIT'
_OPEN_CAP_DEFAULT = 2
_ESCALATION_LIMIT_DEFAULT = 1


def _antistorm_enforced():
    """Q7：反风暴执法总开关（DSH_EXPERT_ANTISTORM_ENFORCE），缺省关闭=现状逐字节。"""
    return bool((os.environ.get(_ANTISTORM_ENFORCE_ENV) or '').strip())


# ── T14 代际 owner 绑定（Q2 兑现；T20🟡2 表述修正为实际覆盖口径）────────────────
# 代际建立（claim --attempt / reassign 双通道）时落 attempt_owner=落定 owner，并在事件 args
# 留痕；check_attempt 单点校验：字段存在且调用方声明身份不符 → 具名拒 attempt_owner_mismatch。
# 有效覆盖=done --by/vote --by/reassign 持证明通道（有身份可核的路径）；fail/progress/own/
# heartbeat 解析器无身份参数（caller 恒 None）→ 绑定校验对这些命令恒 no-op——未声明身份
# 不可核不拒（R1），并非这些命令「自动获得执法」。
# env DSH_EXPERT_ATTEMPT_BIND_OWNER 缺省关闭：不落字段不校验（关闭=现状逐字节）；旧板无字段
# 自动回退旧行为（字段缺席=不校验双保险）。R1 口径随行如实声明：绑定与申报均为板面自报
# （CLI 无鉴权），板内一致性校验防误用非防伪造。
_ATTEMPT_BIND_ENV = 'DSH_EXPERT_ATTEMPT_BIND_OWNER'


def _attempt_bind_enforced():
    """T14：任意非空值=开启；缺省/空串=关闭（缺省关闭=旧行为逐字节，与 Q7 同形）。"""
    return bool((os.environ.get(_ATTEMPT_BIND_ENV) or '').strip())


def _env_positive_int(name, default):
    """执法开启路径的阈值 env 解析：缺省/空白→default；非整数或 <1 → sys.exit 拒（宁拒勿猜，
    不静默回落）；仅在执法开启路径调用（关闭时不读阈值 env，现状逐字节）。"""
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        sys.exit(f"错误：{name} 须为正整数（得到 {raw!r}）")
    if v < 1:
        sys.exit(f"错误：{name} 须为正整数（得到 {v}）")
    return v


def _count_open_tasks(data, owner):
    """owner 名下 open 任务 id 清单（_OPEN_STATUSES 口径，与 cmd_open_counts 聚合同源同序）。"""
    return sorted(tid for tid, t in data['tasks'].items()
                  if t['status'] in _OPEN_STATUSES and (t.get('owner') or '') == owner)


def _open_cap_state(owner, data):
    """open 上限执法入参三元组 (是否执法, cap, owner 名下 open 计数)：执法关闭时不读
    DSH_EXPERT_PEER_OPEN_CAP、不计数，返回 (False, None, None)。锁内权威快照：写命令由
    main 统一 board_lock 派发，调用点均在锁内折叠 data 上判定。"""
    if not _antistorm_enforced():
        return (False, None, None)
    return (True, _env_positive_int(_PEER_OPEN_CAP_ENV, _OPEN_CAP_DEFAULT),
            len(_count_open_tasks(data, owner)))


def _check_open_cap(owner, data, acquiring_task_id=None):
    """open 上限写面执法（approve/claim/reassign peer 三点共用）：执法开启时，本次写操作
    完成后 owner 名下 open 任务总数（open-counts 同口径）超过 cap 即具名拒 open_cap_exceeded。
    acquiring_task_id=本次写后将归属 owner 的任务：此前不在 owner 名下计数内则 post+1（认领/
    转入）；原已归属（自认领/owner 保持不变）则计数不变。判定先于任何变更与 save（零写零
    事件，revision/事件流零变化）。R1：owner 以板面自报为准，防误用非防伪造。"""
    enforced, cap, pre = _open_cap_state(owner, data)
    if not enforced:
        return
    post = pre
    if acquiring_task_id is not None:
        cur = data['tasks'].get(acquiring_task_id)
        if cur is not None and (cur.get('owner') or '') != owner:
            post += 1
    if post > cap:
        raise BoardError('open_cap_exceeded', owner=owner, open_count=pre, cap=cap, after=post,
                         hint='owner 名下 open 任务数将超过上限（探针：taskboard.py open-counts '
                              '<owner> 核查；先收口/转派在途任务，或经用户裁决调整 '
                              'DSH_EXPERT_PEER_OPEN_CAP）；拒绝发生在任何变更与 save 之前（零写零事件）')


def _escalation_history(t):
    """任务 escalated 历史次数：唯一事实源=任务字段 escalation_count（执法开启期间每次进入
    escalated 落档，用户 retry 不清零）；关闭期/旧板无字段按 0 计，不回溯注记文本（注记非
    契约，如实声明）。"""
    return int(t.get('escalation_count') or 0)


def _escalation_limit():
    return _env_positive_int(_ESCALATION_LIMIT_ENV, _ESCALATION_LIMIT_DEFAULT)



# ── 门禁执法平面（v2.6）：commit-msg hook 双平面执法，默认关闭、显式开启 ──────
# hook 本体选型：POSIX sh 薄壳（无 bash/第三方依赖），校验逻辑内嵌 python3 调本工具
# _hook-check——任务板解析/校验只此一处（与工具平面同一套裁决，taskboard.py 板格式
# 演进时 hook 不需重装），比把板解析复制进 shell 更稳。降级：脚本缺失放行并告警。
HOOK_TEMPLATE = '''#!/bin/sh
# dsh-expert-orchestrator commit-msg 门禁 hook（由 taskboard.py --install-hook 安装，零依赖：POSIX sh + python3 + git）
# {FPH}
# 三查（板集：--board 固化单板，或 <git rev-parse --show-toplevel 仓库根>/.expert-taskboards/ 下全部 *.json 板联合）：
#   ① 提交消息须可解析出任务 id（形如 T<数字>）；② 存在性校验：消息中解析出的全部任务 id 均须在任一板内存在
#     （running 或终态 done/failed 等均合法，板外假 id 即拒）；③ 各任务（含终态条目）scope 的并集内，提交文件均须落在关联域内。
# 解除：python3 "{TB}" --uninstall-hook（凭上方指纹标记行辨认本插件 hook，仅移除本插件安装的）
# 降级（fail-open，均告警放行不阻塞提交）：门禁脚本缺失 / python3 不可用 / 板集为空（无任何 *.json 板，含 archive 归档后）；
#       三查不过则拒绝提交（fail closed）。
TB="{TB}"
if [ ! -f "$TB" ]; then
  echo "expert-orchestrator 门禁：脚本缺失（$TB 不存在），本次提交放行；请重装插件后重新 --install-hook，或 --uninstall-hook 移除本 hook" >&2
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "expert-orchestrator 门禁：python3 不可用，本次提交放行（fail-open，门禁未执行）；安装 python3 后门禁自动恢复，或用 --uninstall-hook 移除本 hook" >&2
  exit 0
fi
python3 "$TB"{BOARD_ARG} _hook-check "$1"{ROOT_ARG}
status=$?
if [ $status -ne 0 ]; then
  echo "expert-orchestrator 门禁：提交被拒绝（原因见上方输出）；核对任务板状态/提交消息/文件范围，紧急情况可用 git commit --no-verify 跳过一次" >&2
  exit 1
fi
exit 0
'''
# 指纹标记行协议版本：稳定字符串，不随模板内容演进变化——卸载/重装凭标记行前缀辨认本插件 hook，
# 模板任何一改都不会把已装 hook 变成"无法用工具卸载"的死 hook（评审项 ①）。
# 旧版（模板整体哈希形态）标记行同样以该前缀开头，天然被认得——即旧版兼容回退。
_HOOK_PROTOCOL_VERSION = 'v2'
_HOOK_INSTALL_MARK = '# dsh-expert-orchestrator hook fingerprint:'


def _hook_content(board):
    # 多板运行时解析（v2.13.1 T1）：未固化 --board 时，hook 运行时以 git rev-parse --show-toplevel
    # 取提交所在仓库根（取不到降级 pwd），把 <仓库根>/.expert-taskboards 作为板目录传给 _hook-check
    # 联合扫描——worktree 与主仓共享 .git/hooks，固化的绝对板路径在 worktree 提交下永远指向主仓板，
    # 运行时按提交根解析才能读到 worktree 私有板（提交根与板路径解耦）。
    board_arg = f' --board "{os.path.abspath(board)}"' if board else ''
    root_arg = '' if board else ' "$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)/.expert-taskboards"'
    return HOOK_TEMPLATE.replace('{FPH}', _HOOK_INSTALL_MARK + ' ' + _HOOK_PROTOCOL_VERSION) \
                        .replace('{TB}', os.path.abspath(__file__)) \
                        .replace('{BOARD_ARG}', board_arg) \
                        .replace('{ROOT_ARG}', root_arg)


def find_git_dir():
    """从 cwd 向上找 .git（目录或 worktree 指针文件）；找不到则退出报错。"""
    d = os.getcwd()
    while True:
        g = os.path.join(d, '.git')
        if os.path.isdir(g):
            return g
        if os.path.isfile(g):
            try:
                first = open(g, encoding='utf-8').read().strip()
            except Exception:
                first = ''
            if first.startswith('gitdir:'):
                p = first[len('gitdir:'):].strip()
                return p if os.path.isabs(p) else os.path.join(d, p)
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit('错误：当前目录不在 git 仓库内（未找到 .git）；--install-hook/--uninstall-hook 需在仓库内执行')
        d = parent


def cmd_install_hook(a):
    """写入 .git/hooks/commit-msg：内容一致幂等返回；含本插件指纹标记行视为旧版插件 hook，允许原地升级覆盖；
    无标记行的外部 hook 报错退出不覆盖。"""
    target = os.path.join(find_git_dir(), 'hooks', 'commit-msg')
    content = _hook_content(a.board)
    if os.path.exists(target):
        with open(target, encoding='utf-8', errors='replace') as f:
            cur = f.read()
        if cur == content:
            print(f'expert-orchestrator 门禁 hook 已安装（{os.path.relpath(target)}），无需重复操作')
            return
        if _HOOK_INSTALL_MARK in cur:
            # 本插件旧版模板安装的 hook：模板演进后原地升级（卸载/重装不因模板内容变化被锁死，评审项 ① 同源）
            with open(target, 'w', encoding='utf-8') as f:
                f.write(content)
            os.chmod(target, 0o755)
            print(f'expert-orchestrator 门禁 hook 已升级覆盖（{os.path.relpath(target)}，检测到本插件指纹标记行）')
            return
        sys.exit(f'错误：{os.path.relpath(target)} 已存在且非当前插件 hook（内容不一致），拒绝覆盖；'
                 f'确认后先 --uninstall-hook（仅移除本插件安装的）或手工处理既有 hook')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'w', encoding='utf-8') as f:
        f.write(content)
    os.chmod(target, 0o755)
    print(f'expert-orchestrator 门禁 hook 已安装: {os.path.relpath(target)}')
    print('  三查：提交消息含任务 id（T<数字>）｜全部任务 id 在板集任一板内存在（running 或终态均可，防夹带板外假 id）｜提交文件落在各任务（含终态）scope 并集内（未声明 scope 跳过）')
    print('  板集：未固化 --board 时运行时按提交所在仓库根扫描 .expert-taskboards/ 全部 *.json 板（worktree 私有板同样生效）')
    print('  降级：门禁脚本缺失 / python3 不可用 / 任务板缺失（含 archive 后）均放行并告警；紧急情况 git commit --no-verify 可跳过一次')
    if a.board:
        print(f'  校验板已固化为: {os.path.abspath(a.board)}')


def cmd_uninstall_hook(a):
    """仅移除本插件安装的 hook：凭稳定指纹标记行辨认（不认全文/模板哈希，模板演进不影响卸载；
    旧版哈希形态标记行同被认得），无标记行则拒绝（不破坏用户自有 hook）。"""
    target = os.path.join(find_git_dir(), 'hooks', 'commit-msg')
    if not os.path.exists(target):
        print(f'未安装 expert-orchestrator 门禁 hook（{os.path.relpath(target)} 不存在）')
        return
    with open(target, encoding='utf-8', errors='replace') as f:
        cur = f.read()
    if _HOOK_INSTALL_MARK not in cur:
        sys.exit(f'错误：{os.path.relpath(target)} 存在但非本插件安装（指纹不匹配：未找到本插件指纹标记行 {_HOOK_INSTALL_MARK}），拒绝删除')
    os.remove(target)
    print(f'已移除 expert-orchestrator 门禁 hook: {os.path.relpath(target)}')


def _staged_files():
    """commit-msg 时点暂存区文件清单（unborn HEAD 下 git diff --cached 与空树比较，实测可用）；
    git 异常时返回 None（调用方跳过范围检查并注明，不误伤）。"""
    try:
        r = subprocess.run(['git', 'diff', '--cached', '--name-only', '-z'],
                           capture_output=True, timeout=10)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return [s.decode('utf-8', 'replace') for s in r.stdout.split(b'\x00') if s]


def _scope_match(fname, scope):
    return any(fname == s or fname.startswith(s + '/') for s in scope)


def _hook_three_checks(a, entries, board_desc):
    """commit-msg hook 三查核心（单板/多板共用一份裁决；entries: {tid: [(task, 板名), ...]}——
    任务 id 按板独立编号，跨板同 id 属常态，故按 id 聚合板内全部条目）。
    id 裁决（多板「任一板」语义）：② 存在性校验——id 在任一板内存在即通过（running 或终态 done/failed
    等均合法，不要求 running；板外假 id 即拒，防夹带）；③ scope 并集取全部命中条目（含终态）——
    终态任务 scope 仍可背书提交文件。exit 1 = 拒绝提交（fail closed）。
    board_desc 仅进拒绝消息用于定位。"""
    try:
        with open(a.msgfile, 'rb') as f:
            msg = f.read().decode('utf-8', 'replace')
    except Exception as e:
        sys.exit(f'expert-orchestrator 门禁拒绝：提交消息不可读（{e}）')
    ids = parse_task_ids(msg)
    if not ids:
        sys.exit('expert-orchestrator 门禁拒绝：提交消息未解析出任务 id（形如 T<数字>）；'
                 '在消息中注明任务 id（如 "feat: xxx T3"）')
    # ② 存在性校验（防夹带）：消息解析出的每个 id 都须在板集任一板内存在（running 或终态均可），板外假 id 即拒
    for tid in ids:
        if not (entries.get(tid) or []):
            sys.exit(f'expert-orchestrator 门禁拒绝：任务 {tid} 不在任务板内（板: {board_desc}）')
    # ③ scope 取全部引用任务（含终态条目——终态任务 scope 仍可背书提交文件）scope 的并集：
    #   多任务同 commit 时文件命中任一任务的 scope 即可
    scopes = []
    for tid in ids:
        for t, _b in entries[tid]:
            for s in (t.get('scope') or []):
                if s not in scopes:
                    scopes.append(s)
    if scopes:
        files = _staged_files()
        if files is None:
            print('expert-orchestrator 门禁提示：无法获取暂存区文件清单，本次跳过 scope 范围检查')
        else:
            bad = [f for f in files if not _scope_match(f, scopes)]
            if bad:
                sys.exit(f'expert-orchestrator 门禁拒绝：{len(bad)} 个提交文件超出任务 {",".join(ids)} scope '
                         f'（并集: {", ".join(scopes)}）: {", ".join(sorted(bad)[:5])}')
            print(f'expert-orchestrator 门禁通过: {",".join(ids)} id 均在板内，{len(files)} 个文件均在 scope 并集内')
            return
    print(f'expert-orchestrator 门禁通过: {",".join(ids)} id 均在板内' + ('' if scopes else '（任务未声明 scope，跳过范围检查）'))


def cmd_hook_check(a, data, path):
    """commit-msg hook 三查（cwd=仓库根，git 调用；exit 1 = 拒绝提交）。
    降级（fail-open）：任务板缺失（含 archive 归档把板移走——归档收口属预期流程，hook 不再阻塞提交）
    时 stderr 告警放行并提示 --install-hook/--uninstall-hook 逃生口；
    板在而三查不过（含消息含夹带的板外假 id）则 fail closed。"""
    if not os.path.exists(path):
        print(f'expert-orchestrator 门禁告警：任务板不存在（{path}），本次提交放行（fail-open）；'
              f'板已 archive 归档或移走属预期，若仍需门禁请重新 --install-hook，不再需要请 --uninstall-hook 移除本 hook',
              file=sys.stderr)
        return
    _hook_three_checks(a, {tid: [(t, os.path.basename(path))] for tid, t in data['tasks'].items()},
                       os.path.relpath(path))


def cmd_hook_check_multiboard(a, boards_dir):
    """commit-msg hook 多板三查（v2.13.1 T1）：hook 运行时按提交所在仓库根传板目录，扫描其下
    全部 *.json 板联合裁决——消息解析出的全部任务 id 均须在任一板内存在（running 或终态均可，
    存在性校验；同 id 跨板按「任一板存在即过、scope 并集取全部命中条目含终态」裁决，
    见 _hook_three_checks），scope 并集
    跨板取。降级（fail-open，stderr 告警放行）：板目录缺失、无任何 *.json 板（含 archive 归档后）、
    或全部板加载失败；有可加载板而三查不过则 fail closed。逐板加载用 repair=False 无锁只读快照
    （hook 是只读面，绝不与写命令竞争写回），单板损坏仅告警跳过该板（不因一块坏板放大成全板
    门禁失明之外的误伤）。"""
    if not os.path.isdir(boards_dir):
        print(f'expert-orchestrator 门禁告警：任务板目录不存在（{boards_dir}），本次提交放行（fail-open）；'
              f'板已 archive 归档或移走属预期，若仍需门禁请重新 --install-hook，不再需要请 --uninstall-hook 移除本 hook',
              file=sys.stderr)
        return
    board_files = sorted(f for f in os.listdir(boards_dir)
                         if f.endswith('.json') and not f.endswith('.lock'))
    entries = {}
    loaded = 0
    for bf in board_files:
        p = os.path.join(boards_dir, bf)
        try:
            bdata = load(p, repair=False)
        except Exception as e:
            print(f'expert-orchestrator 门禁告警：板 {bf} 无法加载（{type(e).__name__}: {e}），跳过该板',
                  file=sys.stderr)
            continue
        loaded += 1
        for tid, t in (bdata.get('tasks') or {}).items():
            entries.setdefault(tid, []).append((t, bf))
    if loaded == 0:
        print(f'expert-orchestrator 门禁告警：板目录内无任何可加载任务板（{boards_dir}），本次提交放行（fail-open）；'
              f'板已 archive 归档或移走属预期，若仍需门禁请重新 --install-hook，不再需要请 --uninstall-hook 移除本 hook',
              file=sys.stderr)
        return
    _hook_three_checks(a, entries, os.path.relpath(boards_dir))


def default_board():
    """无 --board 时：遗留 .expert-taskboard.json 优先，否则用 .expert-taskboards/default.json。"""
    legacy = os.path.join(os.getcwd(), '.expert-taskboard.json')
    if os.path.exists(legacy):
        return legacy
    return os.path.join(os.getcwd(), '.expert-taskboards', 'default.json')


class _JsonSink:
    """--json 模式下吞掉命令的人类可读 stdout（JSON 信封是唯一 stdout 载荷；stderr 不受影响）。"""

    def write(self, *_args):
        return

    def flush(self):
        pass


def _structured_data(a, data):
    """--json 信封的 data 载荷（v2.8 S1 机器消费方契约）：
    任务中心命令（args 带 id 且板上存在）给完整任务对象——取自折叠视图权威缓存，与事件流重放
    逐字段一致，含全部簿记字段（未来新增字段对机器消费方透明可见，这正是结构化通道的意义：
    不再依赖展示层文本行格式）；list 给 id 升序任务数组；watchdog 给五计数报告载荷、replay 给
    重放对账载荷（v2.9 T2 补齐报告型命令 data 消费面，字段名沿 snake_case 既有风格，消除
    「报告型命令 data={}」问题）；其余命令给空对象（cmd/revision 已在信封顶层）。
    boards 走专用载荷（main 内先行处理）；--json 仅支持任务板子命令面，
    install/uninstall-hook 不支持。"""
    if a.cmd == 'list':
        return {'tasks': [data['tasks'][k] for k in sorted(data['tasks'], key=lambda x: int(x[1:]))]}
    if a.cmd == 'watchdog':
        # v2.9 T2：cmd_watchdog 扫描后暂存的五计数（与人类面汇总行同源；fn 必经路径，
        # 防御性 None 检查仅在异常序下退回旧空对象形态，不新增失败面）。
        out = _WATCHDOG_EVAL.get('payload')
        return out if isinstance(out, dict) else {}
    if a.cmd == 'open-counts':
        # T9（阶段二-T3）：反风暴查询是报告型命令——data 恒携带 {owner:{count,tasks}} 聚合载荷
        # （与人类面逐 owner 行同源；空板/无匹配 owner 时 {owner:{count:0,tasks:[]}} 或 {}，均合法）。
        out = _OPEN_COUNTS_EVAL.get('payload')
        return out if isinstance(out, dict) else {}
    if a.cmd == 'replay':
        # v2.9 T2：重放对账载荷——四字段与人类面重放行同源同表达式（state_hash 给全值，
        # 16 字符截断是人类面显示约束；机器消费方拿全值可与事件流末事件 state_hash 直接对账；
        # 无事件流的旧板/空板 event_seq=0、state_hash=''，与人类面占位口径一致）。
        return {'event_seq': int(data.get('event_seq', 0)),
                'revision': int(data.get('revision', 0)),
                'task_count': len(data['tasks']),
                'state_hash': data.get('event_state_hash') or ''}
    if a.cmd == 'budget':
        # #16（T27）：预算盘点是报告型命令——data 恒携带 budget 载荷（enabled/thresholds/epoch/
        # stamped/budgets），不落「报告型命令 data={}」的机器消费面问题（前轮评审备忘(2)）。
        out = {}
        tid = getattr(a, 'id', None)
        if isinstance(tid, str) and tid in data.get('tasks', {}):
            out['task'] = data['tasks'][tid]
        if _BUDGET_EVAL.get('payload') is not None:
            out['budget'] = _BUDGET_EVAL['payload']
        return out
    if a.cmd == 'claim_idle':
        # v2.9 T3/T39-①：原子空闲认领的机器消费面——claimed/skipped 与人类面逐任务块同源
        # （报告型命令 data 恒非空惯例沿 T27 budget；失败面的 running/skipped 在错误信封字段）。
        return {'claimed': list(_CLAIM_IDLE_EVAL['claimed']),
                'skipped': [dict(s) for s in _CLAIM_IDLE_EVAL['skipped']]}
    if a.cmd == 'create':
        # 暴露面审计（exposure-crypto-trust 报告 N2）：create 的机器消费面给创建后任务全量
        # 快照（_CREATE_EVAL 暂存，save 后取最终态）——写面回执此前 data={}（无 id 参数），
        # 外部调用方拿不到新任务 id/owner/状态，无法回显审计行与对账事件流。
        out = _CREATE_EVAL.get('task')
        return {'task': out} if isinstance(out, dict) else {}
    tid = getattr(a, 'id', None)
    if isinstance(tid, str) and tid in data.get('tasks', {}):
        return {'task': data['tasks'][tid]}
    return {}


def all_boards():
    """当前目录下的全部任务板（含遗留文件与 .expert-taskboards/*.json）。"""
    found = []
    legacy = os.path.join(os.getcwd(), '.expert-taskboard.json')
    if os.path.exists(legacy):
        found.append(legacy)
    gdir = os.path.join(os.getcwd(), '.expert-taskboards')
    if os.path.isdir(gdir):
        found.extend(sorted(glob.glob(os.path.join(gdir, '*.json'))))
    return found


def _board_rows():
    """逐板摘要（cmd_boards 的人类行与 --json 信封共用一份数据源，两输出面永不漂移）。"""
    rows = []
    for p in all_boards():
        rel = os.path.relpath(p)
        try:
            data = json.load(open(p, encoding='utf-8'))
            tasks = data.get('tasks', {})
            st = collections.Counter(t['status'] for t in tasks.values())
            upd = max([t.get('updated', 0) for t in tasks.values()] or [0])
            ts = datetime.datetime.fromtimestamp(upd / 1000).strftime('%m-%d %H:%M') if upd else '-'
            dist = ' '.join(f'{k}={v}' for k, v in sorted(st.items())) or '空'
            rows.append((rel, f"{rel} | {len(tasks)} 任务 | {dist} | 最近更新 {ts}",
                         {'path': rel, 'tasks': len(tasks),
                          'status_dist': dict(sorted(st.items())), 'updated': upd, 'ok': True}))
        except Exception:
            # 解析失败或深层结构损坏都不裸 traceback
            rows.append((rel, f'{rel} （损坏）', {'path': rel, 'ok': False}))
    return rows


def cmd_boards(a, _data=None):
    rows = _board_rows()
    if not rows:
        print('（当前目录没有任务板）')
        return
    for _rel, line, _payload in rows:
        print(line)


def cmd_replay(a, data, path):
    """replay：显式从事件流重放折叠状态并重写视图文件（幂等）。
    崩溃恢复的常规路径是任意命令加载时自动重放；本命令用于人工核对与崩溃演练。"""
    save_view(path, data)
    print(f"已从事件流重放折叠状态: event_seq={data.get('event_seq', 0)} "
          f"revision={data.get('revision', 0)} 任务数={len(data['tasks'])} "
          f"state_hash={str(data.get('event_state_hash', ''))[:16]}")


def cmd_archive(a, data, path):
    open_tasks = [t for t in data['tasks'].values()
                  if t['status'] not in ('done', 'failed', 'rejected')]  # rejected 终态不算未收口（S3① 被否决草案不滞留）
    if open_tasks and not a.force:
        listing = ', '.join(f"{t['id']}[{t['status']}]" for t in open_tasks)
        sys.exit(f'拒绝归档：还有未收口任务 {listing}；先 done/fail，或确认放弃用 --force')
    os.makedirs('.expert-taskboards/archive', exist_ok=True)
    name = time.strftime('%Y%m%d-%H%M%S') + '-' + os.path.basename(path)
    target = os.path.join('.expert-taskboards', 'archive', name)
    ep = events_path(path)
    moved_log = os.path.exists(ep)
    if os.path.exists(target) or os.path.exists(events_path(target)):
        # S4（v2.6 遗留债，T17 收口修复，T10 首轮评审 s3）：同秒重名归档会经 os.replace 静默顶掉
        # 既有归档（同秒内「归档 → 同名新建 → 再归档」即触发；os.replace 对既有目标是覆盖语义，
        # 先前那份归档板与事件流一并丢失）。复用本文件既有「唯一名 + os.replace 原子落位」惯例
        # （save_view 同款 pid+uuid 后缀）：碰撞时追加唯一后缀再落位，既有归档零覆盖；无碰撞的
        # 正常路径归档名逐字节不变（既有调用方式与目录布局零变化）。归档在 board_lock 内执行，
        # 同板归档串行化，存在性检查无 TOCTOU 实害。
        name += f'.{os.getpid()}.{uuid.uuid4().hex[:8]}'
        target = os.path.join('.expert-taskboards', 'archive', name)
    if moved_log:
        # 先迁事件流后迁板（二轮评审重要-2）：两步间被杀时顶层残留的是板（折叠视图）而非孤儿事件流
        # ——视图仍可直读降级、下次写以视图重新收编，数据零丢失；反序则顶层孤儿日志会被读命令按权威
        # 静默复活旧板、被同名 create 续链（跨板劫持）。归档区孤儿日志无代码枚举消费，可接受。
        os.replace(ep, events_path(target))
    os.replace(path, target)
    print(f'已归档 {os.path.relpath(path)} -> .expert-taskboards/archive/{name}')
    if moved_log:  # 事件流（状态权威）随板一并归档，重放能力不因归档丢失
        print(f'事件日志已一并归档: .expert-taskboards/archive/{os.path.basename(events_path(target))}')


RECEIPT_INVALID = 'receipt_invalid'


def _receipt_check(payload, required, json_mode):
    """机器回执契约守卫（v2.13 T2 回执契约严格化）：任何 stdout 单行 JSON 回执（--json 信封与
    人读面错误 JSON 同规）发出前按**精确键名**校验必备字段——键大小写敏感、无别名（'OK'/'Error'
    等错大小写键不抵充必备字段）；必备字段齐备则原样 print 并返回 True，缺失则不发出本回执、
    改发具名 receipt_invalid 结构化错误 JSON（missing 列出缺失键名，机器可解析，绝不裸
    traceback）并抛带 receipt_emitted 标记的 SystemExit(1)（main 的 SystemExit 处理器见标记
    即原样重抛，不再叠加 command_failed 信封，保证 stdout 恰一行）。额外键对未来字段演进透明
    （不拒绝）。required 为空元组视为无需校验（恒通过）。"""
    missing = [k for k in required if k not in payload]
    if missing:
        bad = {'ok': False, 'error': RECEIPT_INVALID, 'missing': missing} if json_mode \
            else {'error': RECEIPT_INVALID, 'missing': missing}
        print(json.dumps(bad, ensure_ascii=False))
        se = SystemExit(1)
        se.receipt_emitted = True
        raise se
    print(json.dumps(payload, ensure_ascii=False))
    return True


def _emit(a, data, path, json_mode):
    """命令输出面（main 派发尾部，锁内/无锁两路共用一份实现）：--json 信封（_JsonSink 吞人类
    stdout，信封是唯一 stdout 载荷）或缺省人类面 + revision 尾行；archive/_hook-check 不带
    revision（与人类面末行既有约定一致）。--json 信封发出前经 _receipt_check 契约校验。"""
    if json_mode:
        # S1 结构化通道：人类可读 stdout 整体静默（_JsonSink 吞掉），信封是唯一 stdout 载荷；
        # stderr（视图重建告警/门禁告警等诊断面）不受影响，退出码语义与缺省完全一致。
        with contextlib.redirect_stdout(_JsonSink()):
            a.fn(a, data, path)
        envelope = {'ok': True, 'cmd': a.cmd, 'data': _structured_data(a, data)}
        required = ['ok', 'cmd', 'data']
        if a.cmd not in ('archive', '_hook-check'):  # 与人类面末行 revision 约定一致
            envelope['revision'] = int(data.get('revision', 0))
            required.append('revision')
        if a.cmd in _WRITE_CMDS:
            # 暴露面审计（exposure-crypto-trust 报告 N2）：写命令信封附 event_seq=本次落账后
            # 事件流末 seq（与 replay data.event_seq 同源）——外部调用方（MCP/A2A 写面）据此
            # 回显审计行并核对事件流。additive 键（_receipt_check 对额外键透明）；budget 只读
            # 盘点走同白名单，取值=快照对账锚点（快照级一致性语义见 T38-1 注释）。
            envelope['event_seq'] = int(data.get('event_seq', 0))
        _receipt_check(envelope, required, json_mode)
    else:
        a.fn(a, data, path)
        if a.cmd not in ('archive', '_hook-check'):
            print(f"revision={data.get('revision', 0)}")


def main():
    ap = argparse.ArgumentParser(description='expert-orchestrator 任务板')
    ap.add_argument('--board', help='状态文件路径，默认 <cwd>/.expert-taskboard.json；--install-hook 时可固化项目板进 hook')
    ap.add_argument('--json', action='store_true',
                    help='机器可读结构化输出通道（v2.8 S1）：stdout 恰一行 JSON 信封（成功 {"ok":true,cmd,data,revision}'
                         '[,event_seq 写命令对账锚点]；失败 {"ok":false,error,...}），人类可读文本不上 stdout，'
                         'stderr 与退出码语义不变；'
                         '缺省（不带本参数）人类可读面逐字节零变化。仅支持任务板子命令，不与 --install-hook/--uninstall-hook 同用')
    ap.add_argument('--install-hook', action='store_true',
                    help='门禁执法平面（默认关闭）：向当前仓库 .git/hooks/commit-msg 安装零依赖三查 hook；已有同名 hook 报错不覆盖')
    ap.add_argument('--uninstall-hook', action='store_true',
                    help='仅移除本插件安装的 commit-msg hook（凭稳定指纹标记行辨认，不破坏用户自有 hook）')
    sub = ap.add_subparsers(dest='cmd')

    def add_write_args(p):
        p.add_argument('--expected-revision', type=int, default=None,
                       help='CAS 乐观锁：期望的板级 revision，不符则拒绝写入（stale_revision）；缺省不校验（与旧版一致）')

    def add_attempt_arg(p):
        p.add_argument('--attempt', default=None,
                       help='派工代际 attempt_id；与任务当前代际不符则拒绝（stale_attempt）；缺省不校验（与旧版一致）')

    p = sub.add_parser('create')
    p.add_argument('title')
    p.add_argument('--owner')
    p.add_argument('--dep', help='逗号分隔的依赖任务ID')
    p.add_argument('--desc', help='完成标准')
    p.add_argument('--scope', help='关联域（逗号分隔路径前缀，如 src,docs）；hook 第三查与验证回执的依据')
    p.add_argument('--draft', action='store_true',
                   help='创建为 PM 规划草案（draft 状态：待批准、不可 claim、不参与依赖自动提升）；缺省行为不变')
    p.add_argument('--auto-ready', action='store_true',
                   help='T15 受限免审批创建（仅代理自建，须成对携带 --created-by/--of）：M1 链①-⑤+⑥⑦⑧⑧\''
                        '全过则直达 ready（单事件 type=create 不变，args 增 auto_ready+open_count 免审证据，'
                        'checkpoint 注记免审证据可审计）；⑥ created_by open 计数超上限（DSH_EXPERT_PEER_OPEN_CAP'
                        '，恒生效不依赖执法开关，agent_create_open_cap）⑦ --of 父任务非 open 态'
                        '（agent_create_parent_closed）⑧ dep 跨 owner（agent_create_dep_cross_owner）'
                        '⑧\' dep 未全 done（agent_create_dep_open），任一命中即具名拒'
                        '（零写零事件，hint 指路去掉本参回 draft 待批旧路径）；与 --draft 互斥；'
                        '--kind review 同传仍拒（review 永不免审）')
    p.add_argument('--kind', help='任务种类（缺省不带 kind 字段，行为不变）：review=评审任务，完成须显式 '
                                  '--verdict pass|needs_revision，失败自动生成 repair 并重排下游依赖')
    p.add_argument('--quorum-m', type=int, nargs='?', const=DEFAULT_REVIEW_QUORUM_M, default=None,
                   help='m 票布尔共识陪审团规模（仅 review kind；裸声明即默认 3，Q3=3A）；'
                        '未声明或 m=1 为单评审员路径，行为不变')
    p.add_argument('--tags', help='能力标签（T8，逗号分隔如 "a,b"，逐项 strip 去空保序去重；'
                                 '落任务 tags 字符串数组；缺省不落 tags 字段，行为逐字节不变）')
    p.add_argument('--created-by',
                   help='代理 scoped 自建任务（M1）：与 --of 必须成对出现——声明创建者专家名，须等于 '
                        '--of 任务 owner（认领关系核实）；任务 JSON 落单键字符串字段 created_by，'
                        'status 强制 draft（代理 draft 进入待批面）；lead 派发不带本参数，行为逐字节不变')
    p.add_argument('--of',
                   help='与 --created-by 必须成对出现：指向本板既有任务（其 owner == --created-by，'
                        '否则 not_task_owner）；新任务 scope 逐项须落在该任务 scope 内'
                        '（_scope_match 语义，否则 scope_out_of_violation）')
    add_write_args(p)
    p.set_defaults(fn=cmd_create)

    p = sub.add_parser('list')
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser('show'); p.add_argument('id'); p.set_defaults(fn=cmd_show)
    p = sub.add_parser('claim'); p.add_argument('id'); p.add_argument('owner', nargs='?')
    p.add_argument('--tags', help='claimant 能力声明（T8，逗号分隔）：任务带 tags 须与声明有交集才可认领；'
                                  '任务带 tags 而未声明，或无交集，均 tag_mismatch 拒绝（宁拒勿猜，零写零事件）；'
                                  '任务无 tags 时任何认领不受影响（缺省行为不变）')
    add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_claim)
    p = sub.add_parser('claim_idle', help='#20 空闲续领原子认领（v2.9 T3/T39-①）：单锁内「无 running 判定+认领」——'
                                          '并发 sweep/人工 claim 竞争下恰好一个成功（board_not_idle 整轮不动）；'
                                          '非 ready/已有 owner/不存在跳过（fail-open，全跳过 claim_idle_noop）；'
                                          '不建代际；事件仍为 claim 类型（#16 预算计数归因不变，interrupt 档照常拒绝）')
    p.add_argument('owner', help='认领方身份（空闲续领固定为编排者 IDLE_RECLAIM_OWNER）')
    p.add_argument('ids', nargs='+', help='候选任务 id 列表（一次持锁内批量认领；上限由调用方 sweep 策略控制）')
    p.add_argument('--tags', help='claimant 能力声明（T8，逗号分隔）：带 tags 候选须与声明有交集才可认领，'
                                  '不匹配候选逐个跳过（skipped.reason=tag_mismatch）；不带 --tags 时带 tags '
                                  '候选一律跳过（宁漏勿错）；无 tags 候选不受影响（缺省行为不变）')
    p.add_argument('--steal', action='store_true',
                   help='T16 work-stealing（显式参数，缺省不带=现有语义逐字节不变）：认领他人 ready+owner '
                        '空闲任务（→running+owner=认领方，无中间态）；空闲闸收窄双侧——认领方本人无 running '
                        '且被窃任务 owner 名下无 running（steal_owner_active 拒）；让渡留痕 stolen_from/'
                        'checkpoint/事件 args previous_owner；反回摆 steal_ping_pong 拒；无主候选不在本语义内')
    add_write_args(p)
    p.set_defaults(fn=cmd_claim_idle)
    p = sub.add_parser('approve'); p.add_argument('id'); p.add_argument('--by', help='批准人声明（方向 4 审计面，板面自报防误用不防伪造；上限 200 码点超限硬拒；协议纪律：批准者≠草案创建代理本人，代理转达的批准不可信）'); add_write_args(p)
    p.set_defaults(fn=cmd_approve,
                   help='PM 规划草案批准：draft -> ready（依赖未满足先回 pending 走自动提升）；批准前 claim 被拒')
    p = sub.add_parser('reject'); p.add_argument('id'); p.add_argument('--by', help='否决人声明（方向 4 审计面，同 approve --by 口径，上限 200 码点）'); add_write_args(p)
    p.set_defaults(fn=cmd_reject,
                   help='PM 规划草案否决：draft -> rejected 终态（退出批准面不滞留；不可 claim/approve）')
    p = sub.add_parser('done'); p.add_argument('id'); p.add_argument('summary', nargs='?'); p.add_argument('--rework', type=int, help='返工次数'); p.add_argument('--switched', action='store_true', help='中途换人'); p.add_argument('--by', help='实际执行专家名'); p.add_argument('--verdict', help='review 任务完成结论（review 任务必填）：pass=评审通过正常完成；needs_revision=须携带 --findings，自动生成 repair+下游 DAG 重排，原任务回 ready 待复审'); p.add_argument('--findings', help='评审发现清单（needs_revision 必填，供 repair 任务引用）'); p.add_argument('--repair-owner', help='自动生成 repair 任务的 owner（缺省为空，由编排者分配）'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_done)
    p = sub.add_parser('vote'); p.add_argument('id'); p.add_argument('--by', required=True, help='投票评审员名（落款即身份；同一评审员每轮一票，重投 duplicate_vote 拒绝）'); p.add_argument('--score', type=_score_arg, required=True, help='评审值 [0,1]：恰 1=pass 票、恰 0=fail 票、(0,1) 中间值=弃权；布尔票边界按十进制字面量精确判定（非恰 1/0 但双精度坍缩到边界的字面量，如 0.999…9 长 9 串，解析期拒绝）'); add_attempt_arg(p); add_write_args(p)
    p.set_defaults(fn=cmd_vote,
                   help='m 票评审投票（--quorum-m≥2 任务专用）：≥m 同向且零反向才生效——pass 生效后 done --verdict pass 收口；fail 生效当场自动 repair（票箱清空进次轮，超 2 轮 escalated）；反向票即僵局当场 escalated 交回用户')
    p = sub.add_parser('fail'); p.add_argument('id'); p.add_argument('reason', nargs='?'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_fail)
    p = sub.add_parser('retry'); p.add_argument('id'); add_write_args(p); p.set_defaults(fn=cmd_retry)
    p = sub.add_parser('progress'); p.add_argument('id'); p.add_argument('note'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_progress)
    p = sub.add_parser('heartbeat'); p.add_argument('id'); add_attempt_arg(p); add_write_args(p)
    p.set_defaults(fn=cmd_heartbeat,
                   help='running 任务心跳：重臂滑动无进展窗口并清零 nudge 计数（watchdog 用，长任务报活）')
    p = sub.add_parser('watchdog')
    p.add_argument('--window-sec', type=int, default=1800, help='滑动无进展窗口秒数（默认 1800；0=立即可判定，测试/演练用）')
    p.add_argument('--max-nudges', type=int, default=2, help='连续 nudge 无响应上限（默认 2；达到后升级 adopt/reclaim）')
    p.add_argument('--bus-root', help='完成报告落盘信箱根目录，默认 <cwd>/.expert-bus（收件箱/归档/发件箱均纳入检索）')
    add_write_args(p)
    p.set_defaults(fn=cmd_watchdog,
                   help='滑动无进展看门狗：到期 nudge 重臂，连续无响应先查落盘完成报告（有→adopt 为 done，无→reclaim 回 ready 并撤销代际）')
    p = sub.add_parser('metrics'); p.set_defaults(fn=cmd_metrics)

    p = sub.add_parser('recover'); add_write_args(p); p.set_defaults(fn=cmd_recover)
    p = sub.add_parser('deps'); p.add_argument('id'); p.set_defaults(fn=cmd_deps)
    p = sub.add_parser('status'); p.set_defaults(fn=cmd_status)
    p = sub.add_parser('open-counts', help='按 owner 聚合 open 任务计数与清单（draft 计入、终态不计入；只读无锁快照，零写零事件；反风暴核查面 R1：owner 以板面自报为准）')
    p.add_argument('owner', nargs='?', help='只统计该 owner（缺省聚合全部；无主任务归空键，人读面显示（无主））')
    p.set_defaults(fn=cmd_open_counts)
    p = sub.add_parser('boards'); p.set_defaults(fn=cmd_boards)
    p = sub.add_parser('archive'); p.add_argument('--force', action='store_true'); p.set_defaults(fn=cmd_archive)
    p = sub.add_parser('reassign', help='转派：撤销旧代际建立新代际；attempt_id 传保留字 auto 由工具生成不可猜 token（at-<16hex>）；peer 互派用 --attempt 携带持有证明')
    p.add_argument('id')
    p.add_argument('attempt_id', help='新派工代际 attempt_id（编排者生成）；保留字 auto=工具生成 token，show/--json 回显；与 --attempt 持有证明混用自报值将拒绝（attempt_source_conflict）')
    p.add_argument('--attempt', default=None,
                   help='peer 互派持有证明：须等于任务当前开放代际（no_attempt/stale_attempt 口径）且任务须有 owner（owner==自己）；与自报新 attempt_id 混用拒绝；缺省=编排者通道（与旧版一致）')
    p.add_argument('--owner'); add_write_args(p); p.set_defaults(fn=cmd_reassign)
    p = sub.add_parser('set_dependencies'); p.add_argument('id'); p.add_argument('--dep', required=True, help='逗号分隔的依赖任务ID（整体替换）'); add_write_args(p); p.set_defaults(fn=cmd_set_dependencies)
    p = sub.add_parser('verify'); p.add_argument('id'); p.add_argument('files', nargs='*', help='文件范围清单；缺省=重算既有回执输出 fresh/stale'); add_write_args(p); p.set_defaults(fn=cmd_verify)
    p = sub.add_parser('own', help='工件归属门禁（#22）：登记任务工件归属；与其他开放任务冲突时具名拒绝 artifact_owned')
    p.add_argument('id'); p.add_argument('paths', nargs='+', help='工件路径清单（文件/目录均可，声明意图不要求已存在）'); add_attempt_arg(p); add_write_args(p); p.set_defaults(fn=cmd_own)
    p = sub.add_parser('budget', help='#16 工具调用硬预算（默认关闭，DSH_EXPERT_TOOL_BUDGET 显式开启）：per-(任务,专家) '
                                      '事件流计数与三档档位盘点；--reset 编排者显式重置计数纪元（事件留痕）')
    p.add_argument('id'); p.add_argument('--reset', action='store_true', help='重置预算计数纪元（编排者裁决；写命令：清档位章与拒绝标记，事件+检查点留痕）'); add_write_args(p); p.set_defaults(fn=cmd_budget)
    p = sub.add_parser('replay'); p.set_defaults(fn=cmd_replay,
                                                 help='显式从事件流重放折叠状态并重写视图文件（幂等；崩溃演练/人工核对）')
    p = sub.add_parser('_hook-check', help=argparse.SUPPRESS)  # commit-msg hook 内部入口，非用户命令
    p.add_argument('msgfile')
    p.add_argument('boards_dir', nargs='?',
                   help=argparse.SUPPRESS)  # v2.13.1 T1 多板模式：hook 传入 <提交根>/.expert-taskboards，缺省走单板路径（向后兼容）
    p.set_defaults(fn=cmd_hook_check)

    a = ap.parse_args()
    if (a.install_hook or a.uninstall_hook) and a.cmd:
        ap.error('--install-hook/--uninstall-hook 不与任务板子命令同时使用')
    if getattr(a, 'json', False) and (a.install_hook or a.uninstall_hook):
        ap.error('--json 不与 --install-hook/--uninstall-hook 同时使用（结构化通道仅覆盖任务板子命令）')
    json_mode = getattr(a, 'json', False)
    if a.install_hook:
        cmd_install_hook(a)
        return
    if a.uninstall_hook:
        cmd_uninstall_hook(a)
        return
    if not a.cmd:
        ap.error('the following arguments are required: cmd（或 --install-hook / --uninstall-hook）')
    try:
        if a.cmd == 'boards':
            if json_mode:
                _receipt_check({'ok': True, 'cmd': 'boards',
                                'data': {'boards': [payload for _rel, _line, payload in _board_rows()]}},
                               ('ok', 'cmd', 'data'), json_mode)
            else:
                a.fn(a)
            return
        path = a.board or default_board()
        if a.cmd == '_hook-check' and getattr(a, 'boards_dir', None):
            # v2.13.1 T1 多板模式：hook 按提交根传板目录，联合扫描裁决。只读面（逐板 repair=False
            # 无锁快照），不进 board_lock；exit 1 由 _hook_three_checks 内 sys.exit 直接给出。
            cmd_hook_check_multiboard(a, a.boards_dir)
            return
        if a.cmd == 'budget' and not getattr(a, 'reset', False):
            # ── T38-1 降锁（v2.9 M1/T3）：只读盘点不持 board.lock 独占写锁 ──
            # budget 是机器高频消费面（lib summonBudgetHint 每次派工逐任务盘点），此前与全部
            # 命令互斥于独占 flock。改为无锁快照读：load(repair=False) 零写零 stderr（不重建
            # 视图、不自愈事件流——无锁进程绝不与持锁写命令竞争 os.replace/O_APPEND），结果=
            # 事件流某一完整前缀的折叠（链式 hash 全量校验保证为真实已落账状态），并发写进行
            # 中时至多略滞后（快照级一致性，语义声明见 load）。零写零事件语义保持（盘点不产生
            # 任何事件/视图写，计数自激封死不动）；--reset 与其余全部命令仍走下方锁内路径
            # （flock 结构零改动）；错误面与信封/人类输出形态与锁内路径逐字节一致。
            data = load(path, repair=False)
            check_revision(a, data)  # --expected-revision 仍校验（对快照 revision，无锁下仅作乐观提示）
            a.tb_snapshot_read = True  # cmd_budget 据此走 read_events(repair=False) 快照计数读
            _emit(a, data, path, json_mode)
            return
        if a.cmd == 'open-counts':
            # ── T9（阶段二-T3）反风暴只读查询：无锁快照（沿 budget T38-1 降锁先例）──
            # load(repair=False) 零写零 stderr（不重建视图、不自愈事件流——无锁进程绝不与持锁
            # 写命令竞争 os.replace/O_APPEND）；不武装事件、绝不 save——查询面零写零事件。
            # 结果=事件流某一完整前缀的折叠（快照级一致性）。T12 评审🟢3：open-counts parser
            # 未注册 --expected-revision（只读查询面无 add_write_args，与 metrics/status 读命令同口径），
            # 下方 check_revision 经 getattr 缺省 None 透传为不校验；budget 路径有该参数故校验生效。
            # 人读/--json 形态与锁内路径一致。
            data = load(path, repair=False)
            check_revision(a, data)
            _emit(a, data, path, json_mode)
            return
        with board_lock(path):  # 进程互斥：load -> CAS 校验 -> 写入整体原子（TOCTOU 防护）
            data = load(path)
            check_revision(a, data)  # 写命令的 CAS 校验，锁内针对最新落盘状态（读命令无该参数，透传为不校验）
            _arm_event_ctx(a, data)  # 事件溯源：写命令派发前武装事件上下文（pre 快照/收编种子）
            if a.cmd in BUDGET_COUNTED_TYPES:
                # #16 预算门（T27）：升档章随本命令自身事件落账；interrupt 档在此当场拒绝
                # （首拒落 budget 系统事件）——拒绝发生在命令体之前，命令自身零写零事件。
                budget_gate(a, data, path)
            _emit(a, data, path, json_mode)
    except BoardError as e:
        payload = {'error': e.code}
        payload.update(e.fields)
        if e.code == 'unrecoverable':
            payload['unrecoverable'] = True
        if json_mode:
            payload = {'ok': False, **payload}  # 信封错误面：具名错误码与既有错误字段原样保留
        _receipt_check(payload, ('ok', 'error') if json_mode else ('error',), json_mode)
        sys.exit(1)
    except SystemExit as e:
        # 人读 sys.exit('错误：…') 类拒绝把消息打到 stderr 并以退出码 1 结束；--json 模式下 stdout
        # 仍须恰一行 JSON——归一为 {"ok":false,"error":"command_failed","message":…} 信封（退出码不变）。
        # argparse 用法错误（exit 2）与正常退出（0/None）不在信封化范围。回执契约守卫
        # （_receipt_check）改发的 receipt_invalid 已是恰一行具名 JSON，见标记原样重抛不叠加。
        if getattr(e, 'receipt_emitted', False):
            raise
        if json_mode and e.code not in (None, 0):
            _receipt_check({'ok': False, 'error': 'command_failed',
                            'message': e.code if isinstance(e.code, str) else f'exit {e.code}'},
                           ('ok', 'error', 'message'), json_mode)
            sys.exit(1)
        raise
    except Exception as e:  # 兜底：深层结构异常等绝不裸 traceback，统一具名 unrecoverable JSON
        payload = {'error': 'unrecoverable', 'unrecoverable': True,
                   'reason': f'命令执行异常: {type(e).__name__}: {e}'}
        if json_mode:
            payload = {'ok': False, **payload}
        _receipt_check(payload,
                       ('ok', 'error', 'unrecoverable', 'reason') if json_mode
                       else ('error', 'unrecoverable', 'reason'),
                       json_mode)
        sys.exit(1)


if __name__ == '__main__':
    main()
