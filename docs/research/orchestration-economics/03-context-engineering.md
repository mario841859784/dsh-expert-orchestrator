# Context Engineering 主线综述及其与编排经济学的交叉

> 方向：LLM 多专家编排经济学研究之三（多智能体编排方向）
> 供稿专家：提示词工程师
> 性质：纯只读网络调研，全部结论附出处 URL；检索完成于 2026-11-11
> 委派边界：本报告只覆盖 context engineering 主线综述；模型路由与缓存成本经济学由另一专家负责，本报告仅在「KV-cache 与上下文结构」一节引用 Manus 一手数据作为交叉点，不做展开。

---

## 0. 术语与坐标系

**Context engineering（上下文工程）** 已从「prompt engineering」演化为一门独立学科：

- Anthropic 定义：context engineering 是「在 LLM 推理期间策展与维护最优 token 集合的策略集」，涵盖 system prompt 之外落入上下文的全部信息（工具、MCP、外部数据、消息历史等）；它不再是写好一段静态提示词，而是**每次推理前都要迭代的策展动作**。[Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Karpathy（被多方向共同引用）：上下文工程是「在上下文窗口中为下一步填入恰好正确信息的精细技艺与科学」，类比 LLM=CPU、上下文窗口=RAM、context engineering=操作系统的内存管理。[LangChain context_engineering 仓库 README](https://github.com/langchain-ai/context_engineering)
- Cognition 定义：context engineering 是 prompt engineering 的下一层——「在动态系统中自动化地做到这件事」，是构建 agent 的工程师的**第一号工作**。[Cognition, Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)
- 学术界：[A Survey of Context Engineering for Large Language Models (arXiv:2507.13334)](https://arxiv.org/abs/2507.13334)（166 页、分析 1400+ 论文）给出形式化分类体系：基础组件层（context retrieval & generation / context processing / context management）→ 系统集成层（RAG、记忆系统、工具集成推理、**multi-agent systems**）。该综述把多智能体系统明确列为 context engineering 的四大系统集成形态之一，证实「编排决策本身就是上下文决策」这一命题在学术侧已有对应位置。

**两条公理（贯穿全文）**：

1. **Context rot（上下文腐烂）**：token 数增长时模型准确召回上下文信息的能力下降；注意力预算（attention budget）是有限资源，transformer 的 n² 注意力配对关系被拉薄，且训练分布中长序列稀少。上下文是**边际收益递减的有限资源**。[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)；实证：[Chroma, Context Rot 研究](https://research.trychroma.com/context-rot)
2. 因此好上下文工程的定义是：**找到能最大化期望行为概率的、最小的高信号 token 集**（"the smallest set of high-signal tokens"）。[Anthropic, 同上](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

---

## 1. 精读一：Anthropic《Effective context engineering for AI agents》（2025-09-29）

出处：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### 1.1 注意力预算（attention budget）

- 每个新增 token 都消耗注意力预算；模型在长上下文下精度下降是「性能梯度」而非「硬悬崖」——长上下文仍可用，但信息检索与长程推理的精度降低。
- 架构根因：transformer 全 token 两两注意力（[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)）在 n 增大时被拉伸；位置编码插值（[arXiv:2306.15595](https://arxiv.org/pdf/2306.15595)）扩展上下文但有位置理解损失。
- **编排含义**：给子代理塞满上下文不是「信息充分」而是「预算透支」——这与给人类员工塞满会议纪要同理。

### 1.2 有效上下文的解剖学（静态部分）

- **System prompt 的「正确海拔」（right altitude）**：两端失败模式——过硬（hardcode 脆弱 if-else 逻辑）与过空（模糊高层指导、假设共享上下文）。最优解是「具体到能引导行为、灵活到能给出强启发式」。建议分区组织（`<background_information>`、`## Tool guidance` 等，XML 标签或 Markdown 标题），但追求「完整刻画期望行为的最小信息集」——**minimal ≠ short**。
- **工具即上下文契约**：工具集臃肿是最常见失败模式（功能重叠、决策歧义）；「如果人类工程师说不出该用哪个工具，AI 代理更不可能」。工具应返回 token 高效的结果。
- **少样本示例**：不推荐堆砌边界情况清单，推荐策展「多样化、典型化的示例集」——示例是 LLM 的「千言万语的图片」。

### 1.3 检索范式转移：预取 → just-in-time（运行时即时检索）

- 传统嵌入预检索让位于「轻量标识符（文件路径、存储查询、链接）+ 工具按需加载」策略；Claude Code 用 Bash head/tail 分析大数据库而不整载对象。
- 元数据即信号：文件路径层级、命名约定、时间戳本身携带语义（`tests/test_utils.py` ≠ `src/core_logic/test_utils.py`）。
- 渐进披露（progressive disclosure）：代理通过探索逐层构建理解，只在工作记忆中保留必要部分。
- **权衡与混合策略**：运行时探索比预取慢；无引导时代理会滥用工具、追死胡同、错过关键信息。最佳实践是混合：Claude Code 把 CLAUDE.md 预置入上下文 + glob/grep 即时检索。静态内容多的领域（法律、金融）更适合预取为主。
- **Anthropic 自评的保守结论**："do the simplest thing that works" 仍是最佳建议。

### 1.4 长时程任务的四类技术（本节为编排插件的核心素材）

Anthropic 明确给出三类绕开上下文窗口限制的技术 + 选择标准：

| 技术 | 机制 | 适用场景 | 关键操作细节 |
|---|---|---|---|
| **Compaction（压实/压缩）** | 接近窗口上限时把对话历史总结为摘要，重启新窗口 | 需要大量往复对话、维持对话流的任务 | Claude Code 实现：保留架构决策、未解决 bug、实现细节，丢弃冗余工具输出；续接压缩上下文 + 最近访问的 5 个文件。最轻量形态是**工具结果清除**（tool result clearing，已上线 Claude Developer Platform 的 [context management 功能](https://www.anthropic.com/news/context-management)） |
| **Structured note-taking（结构化笔记 / agentic memory）** | 代理定期把笔记持久化到上下文窗口之外的记忆，之后读回 | 有清晰里程碑的迭代式开发 | Claude Code 的 todo list、NOTES.md；Claude 玩宝可梦跨数千步维护精确计数与地图；随 Sonnet 4.5 发布 [file-based memory tool](https://www.anthropic.com/news/context-management) |
| **Sub-agent architectures（子代理架构）** | 子代理以干净上下文窗口处理聚焦任务，只向主代理返回**浓缩摘要（常为 1,000–2,000 token）**，自身探索可花数万 token | 并行探索有红利的复杂研究/分析 | 关注点分离：详查上下文隔离在子代理内，主代理专注综合 |

**选择标准（Anthropic 原文）**：compaction 适合需要大量对话往复的任务；笔记适合有清晰里程碑的迭代开发；多代理架构适合并行探索有回报的复杂研究与分析。

**压缩的艺术**：先**最大化召回**（确保压缩 prompt 捕获 trace 中每条相关信息），再迭代**提升精度**（剔除冗余）。过度压缩会丢失「其重要性后来才显现的微妙但关键的上下文」。

### 1.5 交叉点：与缓存经济学的关系

Anthropic 主张「找到最小高信号 token 集」+「工具结果清除」，与 Manus 的 KV-cache 优先（见 §3）在「保持前缀稳定」上同向，但 Anthropic 更侧重**注意力效率**，Manus 更侧重**计费/延迟效率**——两种「效率」在编排插件中是两个不同的优化目标（见 §5）。

---

## 2. 精读二：Cognition《Don't Build Multi-Agents》 vs Anthropic 多代理研究系统——两条路线的对照

### 2.1 Cognition 的两条原则（出处：https://cognition.ai/blog/dont-build-multi-agents，作者 Walden Yan，2025-06）

> **Principle 1**：Share context, and share full agent traces, not just individual messages（共享上下文，且共享完整代理轨迹，而非仅单条消息）
> **Principle 2**：Actions carry implicit decisions, and conflicting decisions carry bad results（每个动作都隐含决策，冲突的决策带来坏结果）

论证结构（Flappy Bird 反例）：
- 把任务拆给子代理 → 子代理误读子任务（做了马里奥背景）→ 各子代理基于**冲突的隐含假设**行动 → 汇总者拿到两个互相不一致的成果。
- 即使把原始任务复制给子代理也不够：真实生产对话是多轮的，代理做过的工具调用、任何细节都可能影响任务解释——所以必须共享**完整轨迹**，而非仅任务描述。
- 结论强度：「Principle 1 & 2 至关重要且极少值得违反，**默认排除任何不遵守它们的多代理架构**」。
- 推荐路径：默认用**单线程线性代理**（上下文连续）；确实超长时，引入一个专职 LLM 把动作与对话历史压缩为「关键细节、事件、决策」——Cognition 承认这很难做对，甚至为特定领域**微调小模型**做压缩。
- 佐证案例：**Claude Code subagents**（2025-06 时点）——子代理只回答定义良好的问题、不写代码、不与主代理并行，因为子代理缺主代理上下文，并行会产出冲突响应；收益仅在于子代理的调查工作不占主代理历史。**Edit-apply model**（大模型输出 markdown 修改说明 → 小模型重写整个文件）因「最轻微歧义导致错误编辑」而被淘汰——同样是「决策上下文传递失真」。
- 未来判断：跨代理上下文传递问题尚无人专注解决；它可能随单线程代理与人类沟通能力提升而「免费」解决。

### 2.2 Anthropic 多代理研究系统（出处：https://www.anthropic.com/engineering/multi-agent-research-system，2025-06-13）

与 Cognition 直接相反的路线，但给出了严格的成立条件：

- **效果数据**：Opus 4 lead + Sonnet 4 subagents 在内部研究 eval 上比单代理 Opus 4 **高 90.2%**；BrowseComp 上**token 用量单独解释 80% 的性能方差**（另两因素：工具调用次数、模型选择）。
- **本质机制**：「搜索的本质是压缩。子代理以并行独立上下文窗口探索，再把最重要 token 浓缩给 lead agent」——即多代理是**用并行上下文窗口换 token 预算**的架构。
- **成本数据（关键经济学数字）**：代理比 chat 多用约 **4×** token；多代理系统比 chat 多用约 **15×** token。多代理系统「要求任务价值高到足以支付增长的性能成本」。
- **明确划出的不适用域**：「需要所有代理共享同一上下文或代理间强依赖的领域不适合多代理系统」——点名**编码任务**（真正可并行的任务少于研究）。这正是 Cognition 立场在其适用域内的直接印证。
- **给编排者的操作教训**（原文 8 条中与上下文决策直接相关的）：
  1. **教编排者如何委派**：每个子任务需要目标、输出格式、工具与信息源指引、清晰任务边界；模糊指令（"research the semiconductor shortage"）导致子代理重复搜索或误读。
  2. **按复杂度缩放投入（effort scaling rules）**：简单事实查证 = 1 个代理 3–10 次工具调用；直接比较 = 2–4 个子代理各 10–15 次调用；复杂研究 = 10+ 子代理明确分工。**显式把「预算分配规则」写进编排者 prompt**，防止对简单查询过度投资（早期版本最常见失败）。
  3. **子代理输出落文件系统，最小化「传话游戏」（game of telephone）**：子代理把成果写入外部 artifact 系统，只向协调者回传**轻量引用**——直接对应 Cognition 担心的「跨代理上下文传递失真」，Anthropic 的解法是**绕过对话通道、以文件为准**。
  4. 长对话管理：阶段完成后先总结并存入外部记忆再开新阶段；上下文将满时 spawn 干净上下文的新子代理、靠仔细的交接（handoff）维持连续性。
  5. 同步执行的代价：lead 同步等待子代理，无法中途引导、子代理无法互相同步——承认异步化是未来方向但会引入状态一致性问题。
  6. 错误复合与可恢复性：代理有状态、错误复合，靠「检查点 + 从错误点恢复」而非整体重启。

### 2.3 分歧点与各自成立条件（本报告核心对照表）

| 维度 | Cognition（反多代理） | Anthropic（多代理研究系统） |
|---|---|---|
| 核心主张 | 多代理 2025 年必然脆弱：上下文共享不彻底、决策分散 | 多代理在广度优先研究任务上 +90.2%，是扩展 token 预算的正确架构 |
| 成立条件 | 编码等强依赖、需共享隐含假设的任务（默认一切任务） | 高价值、重并行、信息超单窗口、多工具接口的任务 |
| 对子代理的上下文输入 | 共享**完整轨迹**，否则排除该架构 | 每个子代理拿到结构化任务书（目标/输出格式/工具/边界），**不共享完整轨迹** |
| 对「冲突决策」的解法 | 不让冲突发生（单线程 / 全轨迹共享） | 允许隔离探索，但**子代理产物落文件系统 + 轻量引用回传**，减少传话失真；产出为「可并行的信息收集」而非「会冲突的写操作」 |
| 对压缩的态度 | 专职 LLM 压缩是「很难做对、需投资」的深水区 | compaction 是第一杠杆，先保召回再提精度 |
| 15× token 成本 | 未正面处理（其架构本身更省） | 明示并接受：任务价值必须覆盖 15× 成本 |

**综合判读**：两者并非真矛盾，而是**任务类型划分**——Anthropic 的多代理红利出现在「只读型、可分解、结果可合并」的研究任务；Cognition 的警告命中「写操作型、隐含假设密集、结果必须互相咬合」的编码任务。一个编排插件的第一分流决策应是：**把任务先分类为「读型/写型」与「可并行/强依赖」，再决定上下文共享策略**。

---

## 3. 补充高信号来源

### 3.1 Manus《Context Engineering for AI Agents》（2025-07-18）

出处：https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus（作者 Yichao 'Peak' Ji）

- **KV-cache 命中率是生产期 agent 的单一最重要指标**：直接决定延迟与成本；Manus 平均输入:输出 token 比约 **100:1**（agent 场景 prefill 远大于 decode）；Claude Sonnet 缓存命中 0.30 USD/MTok vs 未命中 3 USD/MTok，**10 倍差价**。（注：此处仅引一手事实，成本经济学展开归另一专家。）
- 上下文结构三原则：① **prompt 前缀稳定**（系统 prompt 开头放精确到秒的时间戳会毁掉缓存）；② **上下文 append-only**，序列化确定性（JSON key 顺序不稳定会静默破坏缓存）；③ 显式设置缓存断点。
- **Mask, don't remove**：不要中途动态增删工具定义（定义在上下文前部，改动即毁缓存 + 模型会引用已删除工具产生幻觉动作）；用状态机 + token logits 掩码约束动作空间（工具名统一前缀 `browser_` / `shell_` 便于前缀掩码）。
- **文件系统即上下文（the ultimate context）**：无限大小、天然持久、代理可直接操作；「代理必须基于全部先前状态预测下一步动作，而无法预测哪个观测十步之后变得关键——**任何不可逆压缩都有风险**」。因此 Manus 的压缩策略全部设计为**可恢复**：网页内容可丢只要 URL 保留、文档内容可省只要沙箱路径仍在。
- **Recitation（复诵）操纵注意力**：持续重写 todo.md 把全局计划推到上下文末端（模型近期注意力范围），对抗 lost-in-the-middle 与目标漂移；Manus 平均任务约 50 次工具调用，长循环中尤其必要。
- **Keep the wrong stuff in**：不要清除失败轨迹——「抹掉失败就是抹掉证据」；模型看到失败动作与堆栈会隐式更新先验、避免重蹈覆辙。错误恢复能力是真实代理行为的清晰标志。
- **Don't get few-shotted**：上下文里相似的动作-观测对会让模型机械模仿模式（20 份简历审查陷入节奏性重复），解法是注入多样性扰动。

### 3.2 LangChain：write / select / compress / isolate 四操作框架

出处：[langchain-ai/context_engineering 仓库（README + 4 个 notebook）](https://github.com/langchain-ai/context_engineering)；对应 LangChain 博客文章（blog.langchain.com 现行 URL 结构调整后未能直接抓取到原文页，本报告以官方仓库为准，仓库 README 即为该框架的权威表述）。

- 四类操作：**Write**（把上下文持久化到外部：scratchpad、记忆）、**Select**（检索相关上下文入窗）、**Compress**（压缩历史/token 预算）、**Isolate**（隔离：多线程会话、沙箱、**子代理各自的上下文**）。
- 仓库把 Karpathy 的「OS/RAM」类比与「context 类型三分法」形式化：**Instructions**（prompt、记忆、few-shot、工具描述）/ **Knowledge**（事实、记忆）/ **Tools**（工具反馈）。
- 编排含义：这是四操作与四类上下文的**正交矩阵**——任何编排决策（给谁、给多少、何时收走）都可以映射到该矩阵的一个格子。

### 3.3 学术综述：arXiv:2507.13334《A Survey of Context Engineering for LLMs》

出处：https://arxiv.org/abs/2507.13334（2025-07，166 页，1400+ 论文）

- 分类体系：基础组件 = **Context Retrieval & Generation / Context Processing / Context Management**；系统集成 = **RAG、Memory Systems、Tool-Integrated Reasoning、Multi-Agent Systems**。
- 关键研究缺口（原文）：模型在**理解复杂上下文**上已很强，但在**生成同等复杂度的长输出**上显著受限——「理解-生成不对称」是该领域头号优先问题。
- 编排含义：子代理的产出（长文）不可信任其自身复述的完整性——协调者读摘要而非原文时，恰好站在不对称的「弱侧」（生成/转述侧），这为 §4 的「产物落盘 + 引用回传」提供学理支撑。

### 3.4 其他被高信号来源引用的实证

- Chroma《Context Rot》：needle-in-haystack 型实验证明 token 增多时信息召回能力普遍退化（[research.trychroma.com/context-rot](https://research.trychroma.com/context-rot)，由 Anthropic 博客引用）。
- Anthropic 工具设计姊妹篇：[Writing tools for AI agents – with AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)（工具自包含、抗错、意图明确；由 context engineering 博客引用）。
- Anthropic [context management 产品公告](https://www.anthropic.com/news/context-management)：tool result clearing + memory tool 上线，是 compaction/note-taking 从博客主张到平台原语的落地证据。

---

## 4. 「上下文决策经济学」视角提炼

综合上述来源，编排插件面临的三个上下文决策可表述为成本收益问题：

### 4.1 给子代理多少上下文？

- **收益侧**：更多共享上下文 → 减少隐含决策冲突（Cognition P1/P2）、减少子任务误读（Anthropic「教编排者委派」——模糊任务书导致重复搜索与误判的直接成本是**重复的 15× token 消耗**）。
- **成本侧**：子代理窗口被主代理历史占满 → 注意力预算透支（context rot）、无法并行多开（每实例都是全量 trace）、以及传话链放大失真。
- **业界均衡解**：不共享原始 trace，共享**结构化任务书**（目标 + 输出格式 + 工具/信源指引 + 任务边界 + 相关决策摘要）+ **产物经文件系统交接**。即「上下文最小化，但任务书信息密度必须足够」——Anthropic 用 2.2 节教训 2 量化了密度不足的下场，Cognition 用 P1/P2 量化了密度结构性缺失的下场。**信息密度标准**可归纳为：任务书 = 主代理已做出的**相关决策**（为什么这样拆）+ 该子任务的**世界状态边界**（哪些事已做/未做）+ 明确的**产出契约**（格式、粒度、落点），而非任务原文转发。

### 4.2 压缩的收益与失真风险

- 收益：窗口续命、成本下降（Manus：每 token prefill 都在花钱，即便有缓存）、注意力预算回收。
- 失真风险三条独立来源：① Anthropic——「过度压缩丢失其重要性后来才显现的上下文」；② Manus——「无法预测哪个观测十步后关键，任何不可逆压缩都有风险」；③ Cognition——压缩本身是「很难做对的深水区」，需要领域微调。
- 三家收敛出的风险控制手段：**可恢复压缩**（Manus：丢内容留 URL/路径引用；Anthropic：工具结果清除 + 保留决策与 bug 清单 + 最近 5 文件）、**先召回后精度的调参顺序**（Anthropic）、**压缩器专业化**（Cognition：专职模型甚至领域微调）。
- 编排含义：压缩不是「是否」而是「何时 + 何种 + 何种恢复垫」。安全梯度：工具结果清除 < 摘要替换 < 不可逆丢弃；越靠右越需要文件系统兜底。

### 4.3 上下文最小化原则

- Anthropic 全篇的第一性原则（smallest set of high-signal tokens），落到三处：system prompt 的最小完备集、工具的最小可用集、示例的典型化策展。
- Manus 的对应面：文件系统做「无限上下文」，窗口只留**索引与状态**（todo.md 复诵即「把最小计划集持续顶到注意力前沿」）。
- LangChain 的对应面：四操作中 Write/Isolate 的存在意义就是让 Select/Compress 有东西可选——**先把状态外置，窗口里才能最小**。
- 最小化的两条硬约束（编排者不可违反）：Cognition P1（冲突敏感型任务必须全轨迹共享，此时「最小化」让位于「正确性」）；Anthropic 的 minimal ≠ short（任务书过薄 = 15× 重复成本的来源）。

---

## 5. 面向「编排者插件」的 7 条可落地启示

1. **任务分流先行：读型可并行 → 多代理；写型强依赖 → 单线程/全轨迹共享**。落地：编排者第一步把任务按「只读信息收集 vs 会产生需互相咬合的产出」分类；只读类才允许并行子代理（Anthropic +90.2% 数据仅成立于研究型任务；Cognition 的警告完全命中编码型）。这是所有后续上下文决策的父决策。

2. **子代理任务书执行「决策+边界+契约」三段式信息密度标准**。每份任务书必须含：本子任务相关的**已做决策及其理由**、世界状态边界（已做/未做/其他子代理在做什么，防止重复搜索）、产出契约（输出格式、粒度、落点路径）。禁止转发任务原文或一句话派单——Anthropic 实测模糊派单直接造成重复 15× token 开销。

3. **子代理产物一律落盘文件系统，回传轻量引用（路径 + 1,000–2,000 token 摘要），不走对话通道**。同时对抗 Cognition 的「传话游戏失真」与 Anthropic 的 token 开销；学理依据是综述的「理解-生成不对称」——转述长文必然失真，引用则不。

4. **压缩分三级安全梯度 + 恢复垫，按窗口占用率触发而非定时**。梯度：工具结果清除（最安全，老结果一律清除）→ 轨迹摘要（保留：架构决策、未解决 bug/失败清单、待办；丢弃：原始工具输出）→ 不可逆丢弃（仅限有文件路径/URL 兜底的内容）。触发器：窗口占用率阈值（Anthropic 的 200K 截断教训）或阶段边界（里程碑完成时压缩，比中途压缩失真更小）。压缩 prompt 先按「最大召回」调通再收精度。

5. **把 effort-scaling 规则硬编码进编排者 prompt**。直接移植 Anthropic 的规则：简单查证 1 代理 3–10 次工具调用；直接比较 2–4 子代理各 10–15 次；复杂研究 10+ 子代理明确分工。编排者必须对「该开几个子代理、各多少预算」有显式规则，否则会复现「简单任务开 50 个子代理」的失败模式。

6. **检查点式上下文交接**：每个阶段完成时，先把「阶段成果摘要 + 关键决策 + 失败记录」写入外部记忆/文件（LangChain Write 操作），再进入下一阶段或 spawn 干净上下文的新子代理；失败轨迹**不清洗**（Manus：抹掉失败就是抹掉证据），作为交接材料的一部分传递，让下一手代理不再踩坑。

7. **按缓存命中组织提示词结构（与缓存经济学专家的接口）**：编排者生成的任何 prompt 应遵循 Manus 三原则——前缀稳定（系统 prompt 头部禁放时间戳等每次变化的内容）、append-only（不回改历史动作/观测，JSON 序列化 key 顺序确定）、工具定义不中途增删（用掩码/状态机而非从上下文删除）。子代理批量派发时使用**共享的任务书模板前缀**，让并行子代理之间也吃到前缀缓存。（成本细节移交模型路由与缓存成本经济学专家。）

（可选第 8 条，作为 1–7 的兜底）：**todo 复诵机制**——长时程编排任务的计划持续重写并置于上下文末端（Manus recitation / Anthropic structured note-taking），对抗 50+ 步循环中的目标漂移；对编排者插件而言即「任务板状态摘要始终是上下文最后一块」。

---

## 6. 出处清单（全部结论的 URL）

| # | 来源 | URL | 访问状态 |
|---|---|---|---|
| 1 | Anthropic, Effective context engineering for AI agents (2025-09-29) | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 已精读（全文抓取） |
| 2 | Cognition (Walden Yan), Don't Build Multi-Agents (2025-06) | https://cognition.ai/blog/dont-build-multi-agents | 已精读（全文抓取） |
| 3 | Anthropic, How we built our multi-agent research system (2025-06-13) | https://www.anthropic.com/engineering/multi-agent-research-system | 已精读（全文抓取） |
| 4 | Manus (Yichao 'Peak' Ji), Context Engineering for AI Agents (2025-07-18) | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | 已精读（正文抓取至「Don't Get Few-Shotted」节） |
| 5 | LangChain, context_engineering 仓库（write/select/compress/isolate） | https://github.com/langchain-ai/context_engineering | 已抓取 README 全文 |
| 6 | Mei et al., A Survey of Context Engineering for LLMs, arXiv:2507.13334 | https://arxiv.org/abs/2507.13334 | 已抓取摘要与元数据 |
| 7 | Chroma, Context Rot 研究 | https://research.trychroma.com/context-rot | 经来源 1 引用（未直接抓取全文） |
| 8 | Anthropic, context management 产品公告（tool result clearing + memory tool） | https://www.anthropic.com/news/context-management | 经来源 1/3 引用（未直接抓取全文） |
| 9 | Anthropic, Writing tools for AI agents | https://www.anthropic.com/engineering/writing-tools-for-agents | 经来源 1 引用 |
| 10 | Transformer 原论文 / 位置插值论文 | https://arxiv.org/abs/1706.03762 ; https://arxiv.org/pdf/2306.15595 | 经来源 1 引用 |

**备注**：LangChain 博客原文页（blog.langchain.com / blog.langchain.dev 多个 URL 变体均 404，疑因站点改版）未能直接抓取，故以官方仓库 README 为该框架主张的权威出处；web_fetch 端点本次不可用（HTTP 404），全部抓取经 SearXNG web_url_read 完成。未覆盖 Cognition 原文图示（架构图无法文本化），其论证已由正文文字完整承载。
