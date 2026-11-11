# 循环检测与人工升级研究：多专家编排的失控兜底

> 研究专题：dsh-expert-orchestrator（lead + 召唤专家，任务板 + 消息总线）的「循环检测与人工升级」（loop detection & human escalation）
> 调研性质：纯外部文献/产品调研（web only），未改动任何实现。日期：2026-11-12。
> 证据强度标注：**[论文实测]** = 论文受控实验/生产实证；**[论文主张]** = 论文声称但覆盖面有限；**[博客主张]** = 第三方/社区文章或 issue 报告；**[产品宣称]** = 官方文档/README 宣称。
> 命名勘误：委派任务所引「clawputer-labs/mission-control」经核实为 [MeisnerDan/mission-control](https://github.com/MeisnerDan/mission-control) 的 fork（[clawputer-labs org](https://github.com/clawputer-labs) 确实存在且只有这一个仓库，112 forks）；循环检测设计以**上游 MeisnerDan 仓库**为准，本文引文均出自上游 README。

---

## 0. 结论速览

1. 循环不是一种现象而是**多条正交的轴**：时间轴无进展、调用量发散、同签名重复失败、策略乒乓振荡（A↔B）。OpenHands 用一个 StuckDetector 同时查五种模式；本插件已覆盖其中三条轴的近似物，**缺的恰是「同签名连续失败」这条最经典的轴**。
2. 纯检测不改变策略：DeLoop 实测即使阻断重复调用，模型仍会继续提出已执行过的调用（71.3% 任务）——检测的产出必须是**控制权转移**（停自动重试、交人裁决），不是给模型的一句提醒。
3. 升级的收口形态在三个独立来源中完全一致：**终态 + 人工是唯一解锁出口**（mission-control 的 decisions queue、LangGraph 的 interrupt 等待 resume、本插件 review 的 escalated+retry）。
4. 升级报告必须是结构化信封（状态 + 失败签名 + 选项清单），否则会落入「错误信号永远到不了人手上」的静默失败元模式（生产运行时 22 起事故中复现 ≥28 次）。

---

## 1. 问题定义

**什么是 agent loop。** 文献与产品中共出现五种可操作定义（OpenHands StuckDetector 的分类最完整，[docs.openhands.dev](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)，[产品宣称]）：

1. **同一动作-同一观测重复**：DeLoop 给出最严格的定义——canonical 化后的工具调用 + **字节级相同**的观测，且重试未带来任何新信息；它特意区分「informative repeat」（重检自己改过的状态，有新信息，不算环）[arXiv:2610.19376](https://arxiv.org/html/2610.19376v1) [论文实测]。
2. **同一动作-同一错误重复**（OpenHands：3+ 次）[产品宣称]。
3. **乒乓振荡**：两组动作-观测对交替出现（A↔B，OpenHands：6+ 周期）；对应本插件的 A→B→A 委派振荡。
4. **独白/自说自话**：连续多条无用户输入、无实质进展的消息（3+）[产品宣称]。
5. **静默失败型「伪推进」**：错误被 LLM 转写成流畅、貌似合理的叙事交付出去（"fail-plausible"），表面在推进实则在漂移——生产运行时纵向研究五类静默失败中的 D 类 [arXiv:2606.14589](https://arxiv.org/html/2606.14589v1) [论文实测，单案例 n=22 事故复盘]。

**为什么无界重试危险。**

- **Token 烧毁与失败强相关**：DeLoop 在 7 个环境实测，含环运行的平均失败率 59.5%，无环运行 33.4%；且上下文压缩会**加剧**循环（Qwen3-8B 循环率 29.0%→57.3%）——烧掉的 token 大概率买不到成功 [论文实测]。
- **误差复利**：Anthropic 多代理研究系统：「The compound nature of errors in agentic systems means that minor issues for traditional software can derail agents entirely」「One step failing can cause agents to explore entirely different trajectories」——一步走偏即整体偏航，重试是在放大概率而不是消除它 [https://www.anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system) [博客主张，含生产实测数字]。
- **静默发散**：Anthropic 复盘早期症状「users would report agents 'not finding obvious information', but we couldn't see why」「scouring the web endlessly for nonexistent sources」；AWS Bedrock 社区亦有失控循环烧出大额账单的案例记录（["Woke Up to a $10,000 AWS Bill?"](https://builder.aws.com/content/3FemiD2KFjeKbKBfOuXWze0ILIF/woke-up-to-a-dollar10000-aws-bill-how-to-stop-runaway-amazon-bedrock-agent-loops-before-they-drain-your-wallet)）[博客主张]。自纠错不可依赖：ICLR 2024 的经典结论是**无外部反馈的内在自纠错会降低性能**（GSM8K/SVAMP/HotpotQA 上模型常把对的改成错的），自纠错只在有工具/验证器等外部反馈时有效 [arXiv:2310.01798](https://arxiv.org/abs/2310.01798) [论文实测]——这正是「循环兜底最终要靠升级给人」的学理依据。

---

## 2. 业界实践精读

先给一张跨来源的「什么算一次失败/一环、阈值多少、触发后去哪」对照表，便于后文互参：

| 来源 | 环的度量 | 阈值 | 触发后去向 | 升级出口选项 |
|------|---------|------|-----------|--------------|
| mission-control | 同一任务失败次数 | 3 次 | decisions queue（人工判断专用层） | 换法重试 / 跳过 / 停止 |
| OpenHands StuckDetector | 同签名动作-观测 / 动作-错误 / 独白 / 乒乓 | 4+ / 3+ / 3+ / 6+ 周期 | halt 执行（`stuck_detection=True` 默认开） | 停止 + nudge 提示（每 streak 一次） |
| Anthropic 多代理 | 无自动检测（生产 tracing + LLM-as-judge 事后定位） | — | 重启代价高 → 从错误点恢复（检查点） | 工具失败显式告知让代理自适应 |
| Claude Code Agent Teams | 无自动检测（API 错误通知 lead） | — | 失败行常驻面板 + hooks 可拦截 | 人工发消息 / 换人重生 / Esc 中断该队友 |
| LangGraph | 无内置（`interrupt()` 是人工布点） | — | 图挂起等 resume（需 checkpointer） | `Command(resume=...)` 即人工裁决值 |
| Bedrock Agents | 编排循环迭代数 | 硬上限（不可配） | `Max iterations exceeded` 失败返回 | 仅失败信号 + session 超时兜底 |
| Temporal | 重试策略 maximum attempts + 超时 | 按策略可配 | Signal 等人批准（可等数天） | 审批 Signal / Saga 补偿回滚 |
| 本插件 review 路径 | needs_revision 轮次 | repair 3 轮 / m 票 2 轮 | escalated 终态 | 用户 `retry`（唯一工具内出口） |

### 2.1 mission-control：失败 3 次 → decisions queue（[MeisnerDan/mission-control](https://github.com/MeisnerDan/mission-control)）**[产品宣称]**

本地优先（Next.js + JSON 文件，无数据库）的 AI 代理任务管理器，运行时是 Claude Code CLI（`claude -p`），架构与本插件同构度极高：tasks.json / inbox.json / decisions.json 文件即事实源，inbox+decisions 是代理↔人的通信层。README 原文：

- 「Loop Detection — Auto-detects agents stuck in failure loops; after 3 attempts, escalates to a user decision with options to retry differently, skip, or stop」；「If an agent gets stuck, loop detection escalates to you after 3 failures.」——**失败次数为环的度量**，3 次即升级，且升级自带三选项（换法重试/跳过/停止）。
- 升级落点：`decisions.json`「Pending decisions requiring human judgment」，与 inbox（委派/汇报/提问/批准四类消息）分开——**判断类升级不走普通消息通道**。
- 失败留痕：「Failed tasks generate task_failed activity events with error details, session count, and agent info. Failure reports are automatically posted to your inbox」。
- 配套的续命与急停：「Agents that timeout or hit max turns automatically re-spawn continuation sessions…Configurable max continuations per task」（续命上限可配，防止无限续）；「Inbox Stop Button…kills the process tree and prevents continuation chains from spawning」（人手一击断链）。

### 2.2 OpenHands：StuckDetector 五模式 + delegate 错误传播（[docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)、[源码](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py)）**[产品宣称]**

- 阈值全部可配（`StuckDetectionThresholds`）：同动作同观测 **4+**、同动作同错误 **3+**、独白 **3+**、交替乒乓 **6+**；比较是**语义级**的——「Actions are compared by their tool name, action content, and thought (ignoring IDs and metrics)」，观测按内容+工具名、错误按错误消息比较，从而「忽略时间戳与事件 id 等表面差异」。扫描窗：最后一条用户消息之后、至多 20 个事件。
- 默认开启（`stuck_detection=True`），实时监测「can automatically halt execution…preventing infinite loops and wasted resources」；`is_stuck()` 返回布尔，另有 `get_action_error_nudge()` **每个错误 streak 只发一次**的 nudge（以 `_last_nudged_error_event_id` 记账）——现成的防刷屏设计。
- 两个实证教训：①issue [#6277](https://github.com/OpenHands/software-agent-sdk/issues/6277)（[博客主张]）指出无效调用 `ActionEvent.action = None` 会**逃过检测**，且关掉 stuck 检测后同一修复序列 8 次调用就完成——检测器的输入若有盲区，盲区就是失控口；②delegation 树的失败传播曾是知名缺陷：[#3879](https://github.com/OpenHands/OpenHands/issues/3879)（[博客主张]）——delegate 以错误结束时未产生 `AgentDelegateObservation`，父代理经 EventStream 收不到失败结果而整个运行僵死（[#8187](https://github.com/OpenHands/OpenHands/issues/8187) 显示 delegation 长期带伤）——**嵌套代理的失败必须有一条保证送达的回传通道**，这正是消息总线过代对账设计的价值所在。
- DeLoop 对它的批评：这类检测「do not change the agent policy」——即便装上重复阻断器，模型仍在 71.3% 的任务里提出已执行过的调用 [arXiv:2610.19376](https://arxiv.org/html/2610.19376v1) [论文实测]。
- 勘误：legacy `controller/stuck.py`（含 delegate 专项检查）在仓库重构后已无法访问（404），本文以 SDK 版为准。

### 2.3 Anthropic 多代理研究系统：误差复利 + 检查点恢复（[博客](https://www.anthropic.com/engineering/multi-agent-research-system)）**[博客主张，含生产实测数字]**

- 失控形态实录：并行工具调用让智能体「spawning 50 subagents for simple queries, scouring the web endlessly for nonexistent sources, and distracting each other with excessive updates」；「small changes to the lead agent can unpredictably change how subagents behave」——编排者自身的微小改动即可让子代理群体行为漂移。
- 对策是确定性与不确定性的组合拳：「We combine the adaptability of AI agents built on Claude with deterministic safeguards like retry logic and regular checkpoints」；崩溃后「we built systems that can resume from where the agent was when the errors occurred」（重启昂贵：`restarts are expensive and frustrating for users`）；lead 把计划写入 Memory 以防 200K 截断。
- 可观测性兜底：全量生产 tracing、「monitor agent decision patterns and interaction structures」、LLM-as-judge 按 rubric（事实/引用/完整/来源/工具效率）打 0-1 分、早期靠人工Tester发现系统性偏差。
- 与升级最相关的经验：「letting the agent know when a tool is failing and letting it adapt works surprisingly well」——**失败信号必须显式送达代理**，否则代理在假世界里继续努力。

### 2.4 Claude Code Agent Teams：失败可见性 + 人工接管（[docs](https://code.claude.com/docs/en/agent-teams)）**[产品宣称]**

- 队友失败的通知面：「A teammate whose turn ends on an API error notifies the lead that it failed and includes the error text」；「Teammates may stop after encountering errors instead of recovering.」恢复选项只有两条：直接给它发消息，或「Spawn a replacement teammate to continue the work」；失败的队友**永远保留独立面板行**不被折叠——失败态在设计上不可隐藏。
- 已知的卡滞模式与去留：状态滞后——「teammates sometimes fail to mark tasks as completed, which blocks dependent tasks」（需人工改状态或让 lead 催促）；`TeammateIdle` hook 可在队友转 idle 时以 exit 2 打回继续干；无人值守的代价被明说：「Letting a team run unattended for too long increases the risk of wasted effort.」
- 关键的「没有」：**没有自动循环检测、没有自动升级系统**——检测靠通知+面板+hooks，接管靠人。权限侧的约束可借鉴：「A teammate can't approve a permission prompt or supply consent on your behalf」「a teammate that was denied an action can't relay it to another teammate to bypass the check」——**被拒动作不可借道同级绕过**，即升级/批准权不可被代理间传递稀释。

### 2.5 LangGraph：interrupt() + Command(resume=...) —— 升级原语的标准件（[docs](https://docs.langchain.com/oss/python/langgraph/interrupts)）**[产品宣称]**

- 挂起：节点内调 `interrupt(payload)` 即刻暂停——「Graph execution gets suspended at the exact point where interrupt is called」，实现为运行时捕获的特殊异常；「waits indefinitely until you resume execution with a response」。前置条件：**必须有 checkpointer**（生产建议 durable）+ thread id。
- 恢复：`graph.invoke(Command(resume=value), config)`，`value` 成为节点内 `interrupt()` 的返回值；「You must use the same thread ID when resuming」——**检查点（持久化状态）是升级可恢复的物理前提**，resume 值就是人类的裁决输入。
- 与循环兜底直接相关的规则：节点恢复时**从头重跑**→「Side effects before interrupt() must be idempotent」；resume 值可用 `response_schema`（Pydantic）强校验；「Avoid while True + interrupt() loops inside a single node」。approve/reject 模式（`Command(goto="proceed"|"cancel")`）即「升级→按人裁决路由」的模板。

### 2.6 学术：检测、升级与自纠错的极限 **[论文实测]**

- **DeLoop**（[arXiv:2610.19376](https://arxiv.org/html/2610.19376v1)，Google/BU/UW/USC/DeepMind，2026-10）：签名式结构检测（canonical 调用+字节同观测，无 LLM judge）；循环率与失败率强相关（59.5% vs 33.4%）；**压缩加剧循环**（29.0%→57.3%）；推理期手段全部失效（重复惩罚/阻断最好的循环率仍 46.7%，逐步惩罚 GRPO 15.0%）；DPO 自挖对（环动作为负例、自己后来破环的动作为正例）把 Qwen3-8B 循环率 57.3%→6.1%——**训练能改策略，检测和提示不能**。
- **升级可靠性审计**（[arXiv:2610.21270](https://arxiv.org/html/2610.21270v1)，医疗 LLM 代理，2026-10）：把 Escalate（转人工）作为与 Answer/Ask_Clarification/Abstain 并列的动作，按 **5:1 成本比**计分（漏升级比误升级严重 5 倍）；核心发现是**漏升级主导**：「uncertainty-prompted models miss 32–97% of required escalations」；置信度是弱信号（ECE 0.10–0.54、failure AUROC 0.48–0.77）；正则式工作流控制器能把漏升级压到 0.12–0.24，但对未见改写「recall 从 1.00 掉到 0.00」——**显式工作流状态指示优于置信度，且任何检测器自身要过泛化压力测试**。
- **静默失败分类学**（[arXiv:2606.14589](https://arxiv.org/html/2606.14589v1)，生产运行时 8 周复盘，2026-06）：元模式为「error signal that never reaches a human in actionable form」（≥28 次复现）；约 **70% 的静默失败靠人对推送输出的人工观察发现**，而非测试或审计（审计 0% 事前预防、87% 事后拦截）；对策：把「用户视角观察」当一等可观测性信号、卫兵本身要被验证（「an unvalidated guard is indistinguishable from a vacuous one」）。
- **自纠错极限**（[arXiv:2310.01798](https://arxiv.org/abs/2310.01798)，ICLR 2024）：内在自纠错降低性能、外部反馈才有效——为「循环兜底的终点是升级给人（外部反馈）」提供依据。

### 2.7 生产平台的看门狗/监督形态 **[产品宣称]**

- **Temporal**（[docs.temporal.io/ai](https://docs.temporal.io/ai)）：durable execution——「a Workflow resumes automatically after a crash, a network timeout, or a multi-day wait for a human to approve a step」；Approval 模式用 Signal 捕获带元数据的批准；Activity 以 heartbeat 报进展并支持失败后续跑；Saga 补偿回滚；Event History 承担检查点。重试有 Retry Policy（maximum attempts/退避）——**重试上限与升级等待都是一等公民**。
- **AWS Bedrock Agents**：编排循环（orchestrate→action→observe）有内置迭代上限，超限报 `Max iterations exceeded` 且**当前为不可配置的硬限**（[re:Post](https://repost.aws/questions/QUazRyCtdbSvqFV2fWJMzu3A/aws-bedrock-agent-failurereason-max-iterations-exceeded)、[agents-how](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-how.html)）；社区总结的护栏是 session 超时 + max session duration + CloudWatch 监控（[builder.aws.com](https://builder.aws.com/content/3FemiD2KFjeKbKBfOuXWze0ILIF/woke-up-to-a-dollar10000-aws-bill-how-to-stop-runaway-amazon-bedrock-agent-loops-before-they-drain-your-wallet)）[博客主张]。
- **LangSmith Alerts**（[docs](https://docs.langchain.com/langsmith/alerts)、[blog](https://www.langchain.com/blog/langsmith-alerts)）：按错误率/延迟/反馈分/成本/运行数的阈值告警（5/15 分钟窗）——外层平台的循环兜底是**指标告警**形态，靠人看通知接管。

---

## 3. 设计提炼（8 条可落地启示）

1. **「失败轮」必须以结构化签名定义，而非叙述判断。** 借 DeLoop 的签名（canonical 化调用 + 观测，忽略空白/参数序）与 OpenHands 的语义比较（工具名+内容+thought，忽略 id/时间戳）：同签名重复出现 N 次记一轮；观测变化 = informative repeat，重臂不计数。纯文本「看起来像上一次」不可靠——空格/时间戳差异会漏检，语义等价改写会误检。
2. **三条循环轴正交，检测器各自独立。** 时间轴（无进展窗口）、调用量轴（事件计数预算）、策略轴（A↔B 乒乓 + 同签名失败重复）。OpenHands 五模式是这三轴的细分展开；mission-control 只做了失败计数一条轴也够用，但**任何一条轴缺失，那个象限的循环就无界**。本插件文档已自述「watchdog 管时间窗、预算管调用量」互补——第三轴（同签名失败）与已有振荡告警同属策略轴但输入不同（委派拓扑 vs 工具结果）。
3. **计数必须事件溯源、被检测对象不得兼任记分员。** OpenHands issue #6277（无效调用逃过检测）与 DeLoop（模型不承认知晓环）共同指向：检测输入只能是权威事件流，模型自报/叙述性内容一律不计——本插件 budget 的「模型自报不计入、budget 事件不计入封死自激回路」是同类设计的先例，失败轮计数应复用该哲学。
4. **升级 = 终态 + 人工唯一出口，不是告警。** mission-control（escalate → decisions queue 待人裁决）、LangGraph（interrupt 无限期挂起、仅 Command(resume) 可继续）、本插件 review-escalated（escalated 不可 claim/done，retry 唯一出口）三方一致；Agent Teams 的教训反证：没有终态强制时，「teammates may stop after encountering errors instead of recovering」的烂摊子全靠人巡。升级后若仍留自动通道（自动重试/自动换人），升级就会被绕过。
5. **升级报告是最小结构化信封：状态 + 已试过什么 + 出口选项。** mission-control 的三选项（retry differently / skip / stop）是出口枚举的好模板；LangGraph 用 `response_schema` 强约束 resume 值形状；医疗升级审计的反例——只给置信度不给工作流状态指示，人（和模型）都判不准。信封建议字段：失败签名、尝试计数与时间跨度、涉及的 (task, expert)、当前状态快照、可选出路。
6. **防风暴三件套：streak 内只提示一次、升级有上限、重置权只在人。** OpenHands 的每 error streak 一次 nudge（事件 id 记账）；本插件 budget 的「首次拒绝落事件、后续幂等零事件」；escalation_count 落档且「用户 retry 不清零」。DeLoop 的教训是纯提醒防不住——防刷屏对象是**升级通道**，不是模型行为。
7. **检测的输出是控制权转移，不是模型提示。** DeLoop 实测推理期阻断/惩罚几乎无效（最好 46.7%），自纠错论文证明无外部反馈的自纠会变差——循环检出后正确动作只有：停止自动重试、把决定权交人（或按既有裁决表自动执行「升级到终态」这一步）。nudge 可以有，但只能作为升级前的倒数第二级（本插件 watchdog 的 nudge→max-nudges→adopt/reclaim 即此形态）。
8. **升级成本不对称，缺省应宁可多升。** 医疗审计按 5:1 加权（漏升 5 倍于误升）且实测漏升主导（miss 32–97%）；静默失败研究里 70% 靠人眼看出来。映射到插件：非 review 任务目前**连失败轮检测都没有**，等价于把漏升成本设为 0——阈值宜从宽松（如连续 2–3 轮同签名失败即升）起步再调，而非从紧。

---

## 4. 与本插件现状的对照（非实施承诺）

已有机制（据 `README.zh.md`、`skills/expert-orchestration/SKILL.md`、`tools/taskboard.py`）：

| 机制 | 循环轴 | 触发与出口 | 与业界设计的对应 |
|------|--------|-----------|-----------------|
| watchdog（v2.7） | 时间轴：滑动无进展窗（activity=max(updated,heartbeat,nudge)） | 编排者显式调用（非自动轮询）；nudge（板内静默计数）×max-nudges → adopt（`[交付]` 强证据）/reclaim | ≈Temporal heartbeat + LangSmith 告警的手动版；nudge 无送达通道（自述已知边界） |
| per-(task,expert) 工具预算（v2.8 #16） | 调用量轴：事件溯源计数、跨 attempt/reclaim 累计 | alarm/wrap-up/interrupt 三档；交付出口永不拒绝；`budget --reset` 唯一放行 | ≈Bedrock 硬迭代上限的可配置版 + mission-control 续命上限 |
| 委派振荡告警（WP-7 四小门） | 策略轴（拓扑）：A→B→A 委派振荡 | 非阻断告警 | ≈OpenHands 交替模式的委派版，但只看拓扑、不看工具结果 |
| review-kind 升级（WP-5 + 反风暴执法） | 结果轴（仅 review）：repair 重试超限 | escalated 终态、用户 retry 唯一出口、escalation_count 落档 retry 不清零、第 2 次升级强制上报 | ≈mission-control decisions queue + LangGraph interrupt 语义，是全插件最完整的升级闭环 |

**识别出的 GAP（按严重度排序）：**

1. **非 review 任务无通用连续失败检测。** 结果轴目前只在 review 路径生效（REPAIR_RETRY_LIMIT=3 / REVIEW_ROUND_LIMIT=2）。普通任务 fail→retry 可无限往复：budget 数的是调用量（可被「少而精的失败」绕过），watchdog 数的是时间（每次失败之间只要有 heartbeat 就重臂）。没有「同 (task) 的失败签名重复 N 次」计数器——这正是 mission-control 三次升级和 OpenHands 同错误 3+ 次检测所覆盖的最核心轴。
2. **无重复召唤失败检测。** origin chain 挡的是 (专家, cwd) 拓扑重复，不是「同一任务对同一/任一专家召唤反复失败」——召唤层失败的累计无落点（与 Agent Teams「spawn a replacement teammate」的失控变体同构：换了人、环还在）。
3. **升级报告格式不统一。** review escalated 有 `status` 盘点行；watchdog adopt/reclaim 落检查点轨迹；budget interrupt 落 `budget` 事件；振荡只有提示行——四条通道各自为政，缺统一的「升级信封」（状态+签名+尝试+选项），按静默失败研究(C 类「错误被吞掉或稀释」)属于高危形态。
4. **静默失败面（D 类 fail-plausible）只部分设防。** `[交付]` 前缀启发式只服务 watchdog adopt 场景；专家把失败叙述成推进（"在做了/快好了"）绕过无进展窗口的路径，与生产运行时研究中「错误被转写成流畅叙事」同型，目前无独立检测。

**若做，最小落点排序**（依据 §3）：先补 GAP-1（失败轮计数器复用事件溯源哲学，per-task 而非 per-(task,expert)——换专家失败仍应累计，对照 §4 GAP-2 的召唤层）；GAP-3 随之统一（升级信封作为 review/watchdog/budget/失败轮四通道的共同落盘格式）；GAP-2 可与 GAP-1 同一计数器两处读取；GAP-4 风险已知但检测手段（对抗改写的语义判定）尚不成熟，暂以「升级信封里强制附原始失败文本」缓解——呼应静默失败研究「用户视角观察是一等信号」的结论。

---

## 5. 出处清单

| # | 来源 | 用途 | 访问状态（2026-11-12） |
|---|------|------|------------------------|
| 1 | [MeisnerDan/mission-control README](https://github.com/MeisnerDan/mission-control) | §2.1 循环检测/decisions queue/续命 | 已核实（两次抓取正文，引文逐字） |
| 2 | [clawputer-labs（GitHub org）](https://github.com/clawputer-labs) | 命名勘误：为 #1 的 fork | 已核实（org 页 + 仓库描述） |
| 3 | [OpenHands Stuck Detector guide](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) | §1/§2.2 五模式与阈值 | 已核实（正文抓取） |
| 4 | [software-agent-sdk stuck_detector.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py) | §2.2 实现细节（阈值可配/扫描窗/nudge 记账） | 已核实（blob 页抓取） |
| 5 | [OpenHands issue #3879](https://github.com/OpenHands/OpenHands/issues/3879)、[#8187](https://github.com/OpenHands/OpenHands/issues/8187)、[SDK issue #6277](https://github.com/OpenHands/software-agent-sdk/issues/6277) | §2.2 delegate 失败传播缺陷/检测盲区 | 搜索结果核实（未抓 issue 正文） |
| 6 | [OpenHands SDK events 架构](https://docs.openhands.dev/sdk/arch/events) | §2.2 EventStream 事件框架 | 搜索结果核实 |
| 7 | [Anthropic 多代理研究系统](https://www.anthropic.com/engineering/multi-agent-research-system) | §1/§2.3 误差复利/检查点/监控 | 已核实（正文抓取，引文逐字） |
| 8 | [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) | §2.4 失败队友处理/无自动环检 | 已核实（正文抓取，引文逐字） |
| 9 | [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | §2.5 interrupt/Command(resume)/幂等规则 | 已核实（正文抓取，引文逐字） |
| 10 | [DeLoop（arXiv:2610.19376）](https://arxiv.org/html/2610.19376v1) | §1/§2.6 循环定义/实测/检测不改策略 | 已核实（正文抓取） |
| 11 | [医疗升级可靠性审计（arXiv:2610.21270）](https://arxiv.org/html/2610.21270v1) | §2.6/§3 漏升级主导/5:1 成本比 | 已核实（正文抓取） |
| 12 | [静默失败分类学（arXiv:2606.14589）](https://arxiv.org/html/2606.14589v1) | §1/§2.6/§4 静默失败元模式 | 已核实（正文抓取） |
| 13 | [LLMs Cannot Self-Correct Reasoning Yet（arXiv:2310.01798，ICLR 2024）](https://arxiv.org/abs/2310.01798) | §1 自纠错极限 | 搜索结果核实（未抓正文） |
| 14 | [Temporal Durable AI](https://docs.temporal.io/ai) | §2.7 durable execution/Signal 审批/heartbeat | 已核实（正文抓取） |
| 15 | [AWS Bedrock Max iterations exceeded（re:Post）](https://repost.aws/questions/QUazRyCtdbSvqFV2fWJMzu3A/aws-bedrock-agent-failurereason-max-iterations-exceeded)、[agents-how](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-how.html) | §2.7 硬迭代上限/编排循环 | 搜索结果核实（未抓正文） |
| 16 | [Bedrock 失控循环账单案例（builder.aws.com）](https://builder.aws.com/content/3FemiD2KFjeKbKBfOuXWze0ILIF/woke-up-to-a-dollar10000-aws-bill-how-to-stop-runaway-amazon-bedrock-agent-loops-before-they-drain-your-wallet) | §1/§2.7 失控代价 | 搜索结果核实（未抓正文） |
| 17 | [LangSmith Alerts docs](https://docs.langchain.com/langsmith/alerts)、[发布公告](https://www.langchain.com/blog/langsmith-alerts) | §2.7 指标阈值告警 | 搜索结果核实（未抓正文） |
| 18 | [Awesome-LLM-Multi-Agent-Failure-Detection-and-Attribution](https://github.com/mala-lab/Awesome-LLM-Multi-Agent-Failure-Detection-and-Attribution) | 学术线索索引 | 搜索结果核实（未抓正文） |
| 19 | legacy [All-Hands-AI/OpenHands controller/stuck.py](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/controller/stuck.py) | delegate 专项检查（历史） | **未能访问**（404/ECONNRESET，仓库重构后路径失效）；以 #4 SDK 版为准 |

**遗留问题**：①mission-control 的循环检测只有 README 宣称，源码级实现（计数在 daemon 还是 session 层、失败轮如何定义）未逐行核实；②OpenHands issue 引文未抓正文（经搜索摘要转述，属二手）；③「升级信封」具体字段集与插件现有 `status`/信封格式的兼容设计留待设计阶段（见 §3.5、§4.3）。
