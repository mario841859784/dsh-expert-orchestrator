# 缓存与 Token 成本经济学：多智能体编排的量化调研

> 专题：「子代理上下文与缓存成本经济学」之二 · 缓存与 token 成本经济学
> 调研日期：2026-11-11 · 方法：纯只读网络检索（web_search / web_url_read），全部结论附出处 URL
> 适用对象：LLM 多专家编排插件（编排者按任务召唤子代理专家，子代理各自消耗上下文）的成本感知编排策略
> 边界：本报告只覆盖缓存与 token 成本经济学；模型路由与 context engineering 综述由另一专家负责，不越界覆盖

---

## 1. 主流厂商 Prompt Caching 机制与定价

### 1.1 Anthropic（显式缓存，最精细的定价模型）

机制（来源：[Anthropic Prompt Caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)）：
- **显式缓存**：用 `cache_control` 标记最多 **4 个 cache breakpoint**，前缀逐字节一致才命中。
- **自动缓存**（2026 新增）：多轮对话中 cache point 自动前移到最后一个可缓存块，无需手工维护断点；与显式断点可叠加。

确切定价（来源同上，及 [etyb-skills 汇总](https://github.com/e-t-y-b/etyb-skills/blob/main/stacks/anthropic-claude/prompt-caching.md)、[respan.ai 定价解析](https://www.respan.ai/articles/claude-prompt-caching)）：
- **Cache write（5 分钟 TTL，默认）**：**1.25×** 基础输入价。
- **Cache write（1 小时 TTL，需显式指定 `"ttl": "1h"`）**：**2×** 基础输入价（文档原文："Cache write tokens with a 1-hour TTL are 2 times the base input tokens price"）。
- **Cache read**：**0.1×** 基础输入价（即 90% 折扣）。
- 最小可缓存长度：1024 tokens（Opus/Sonnet；Haiku 为 2048）。
- 换算示例（Claude Sonnet 5.5，基础输入 $2/MTok，来源 respan.ai）：20K system prompt 命中 100 次：无缓存 $4.00 → 有缓存 1 次 write（$0.05）+ 99 次 read（$0.198）= **$0.248，约省 94%**。
- **盈亏平衡点极低：只要 ≥1 次缓存命中就能赚回 1.25× 的写溢价**；命中 ≥10 次后 read 单价仅为原价的 1/10。
- 注意事项（社区观察，[provider-level caching 研究汇总](https://github.com/MohamedAbdallah-14/prompt-to-asset/blob/main/docs/research/31-cost-optimization-agentic/31a-provider-level-caching-strategies.md)）：缓存隔离粒度从 org 改为 per-workspace（2026-02-05 起），跨 workspace 共享前缀不命中。

### 1.2 OpenAI（全自动隐式缓存，无断点）

机制与定价（来源：[OpenAI Prompt Caching 官方公告](https://openai.com/index/api-prompt-caching/)、[官方文档](https://platform.openai.com/docs/guides/prompt-caching)、[etyb-skills 汇总](https://github.com/e-t-y-b/etyb-skills/blob/main/stacks/openai/prompt-caching.md)）：
- **全自动**：无需任何标记，对 prompt 前缀（≥**1024 tokens**）自动缓存；缓存按 **1024-token 边界**递增对齐。
- **折扣：cached input 统一 50% off**（官方示例：gpt-4o-2024-08-06 输入 $2.50 → 缓存 $1.25；gpt-4o-mini $0.15 → $0.075）。
- TTL：短窗口，约 **5–10 分钟空闲**后失效；活跃对话期更久（OpenAI 不承诺精确 TTL，低谷时段命中率更高——避开高峰派工可提高命中）。
- 无 write 溢价：命中就省，不命中不罚。代价是无法像 Anthropic 那样精确控制缓存什么。

### 1.3 DeepSeek（磁盘缓存，命中/未命中的价差最大）

机制（来源：[DeepSeek 官方公告](https://api-docs.deepseek.com/zh-cn/news/news0802)）：
- 全自动、无需改代码；**只有从第 0 个 token 开始前缀相同才算命中**（"中间开始的重复不能被缓存命中"）——对编排组版意味着：任务书必须严格"共享前缀 + 差异后缀"。
- usage 中返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 可实时监控命中率。
- 官方称极端示例下 128K 输入首 token 延迟从 13s 降至 500ms。

确切定价（来源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)，当前生效价）：
- deepseek-flash：**cache hit $0.003/MTok（谷时）/ $0.006（峰时）**；**cache miss $0.15 / $0.30**；输出 $0.6 / $1.2（谷/峰，峰时=谷时 2 倍，UTC 周一至周五 01:00-04:00 与 06:00-10:00 为峰）。
- deepseek-v4-pro：**hit $0.022 / $0.044；miss $0.66 / $1.32**。
- **命中价仅为未命中价的 2%–3.3%（约 30–50 倍价差）**——所有厂商中最陡的缓存折扣曲线。谷时派工 + 前缀组版可将子代理输入成本压到原价的零头。

### 1.4 Google Gemini（显式 + 隐式双轨，按时长计费存储）

机制（来源：[Gemini 2.5 implicit caching 官方公告](https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/)、[Gemini API 定价页](https://ai.google.dev/gemini-api/docs/pricing)）：
- **隐式缓存**（2025-05 起，Gemini 2.5 全系）：自动命中公共前缀，**与显式缓存同享 75% 折扣**；最小请求 1024 tokens（2.5 Flash）/ 2048 tokens（2.5 Pro）；官方建议"动态内容放 prompt 末尾"以提高命中。
- **显式缓存**（2024-05 起）：开发者声明缓存并计存储费，折扣同样 75%。

确切定价（Gemini 2.5 Flash，付费层，来源定价页）：
- 显式缓存存储：**$0.50 / 1M tokens / 小时**（至 2026-12-31；2027-01-01 起涨到 $1.00）。
- 缓存输入价约为基础输入价的 25%（如 Flash 缓存价 $0.075/MTok 量级，模型代次间有差异）。
- **Gemini 的独特之处：显式缓存按时长收费**——编排者若为"横跨数小时的批次"建显式缓存，需要权衡存储费 vs 命中收益；短批次用隐式缓存即可。

### 1.5 横向对比速览

| 厂商 | 缓存方式 | Write 溢价 | Read 折扣 | TTL | 关键阈值 |
|---|---|---|---|---|---|
| Anthropic | 显式断点 + 自动前移 | 5min: 1.25×；1h: 2× | **0.1×（省 90%）** | 5min / 1h | ≤4 断点；≥1024 tokens |
| OpenAI | 全自动隐式 | 无 | **0.5×（省 50%）** | ~5–10min 空闲 | ≥1024 tokens，1K 边界 |
| DeepSeek | 全自动磁盘缓存 | 无 | **0.02–0.033×（省 ~97–98%）** | 未公开（按系统淘汰） | 必须从 token 0 前缀一致 |
| Gemini | 隐式 + 显式 | 显式需付存储费 $0.5–1/M tok/h | **0.25×（省 75%）** | 隐式短窗；显式按时长计费 | ≥1024（Flash）/ 2048（Pro） |

**对编排插件的核心含义**：read 折扣（0.1×–0.5×）远大于 write 溢价（1.25×–2×），所以"尽量让每个子代理请求都命中缓存"几乎永远是正期望动作；唯一例外是 DeepSeek/Gemini 显式缓存的存储费场景。

---

## 2. 隐式前缀缓存对多代理编排的影响

### 2.1 前缀一致性决定一切

所有厂商的前缀缓存都是"从 token 0 起逐字节/逐块一致"才命中（DeepSeek 官方明文，[api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/news/news0802)；OpenAI 按 1024-token 块；Anthropic 按断点块）。多代理编排下这意味着：

- **同一批次派出的 N 个子代理，若任务书在"前部"就各不相同（例如每个任务书都把任务 ID、时间戳、动态上下文拼在 prompt 开头），则 N 份 prompt 各自全价 miss、零命中。**
- 反之，若组版顺序为 `固定层（system prompt + 工具定义 + 共享任务规范）→ 半固定层（任务类型模板）→ 动态层（任务参数放最末）`，N 份 prompt 共享长前缀，**只有 1 份承担 1.25× write 溢价，其余 N-1 份按 0.1×（Anthropic）计费**。
- Anthropic 文档明确给出该模式的官方背书："多轮对话中 cache point 自动前移……previous content is read from cache"（[prompt-caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)）。

### 2.2 已知的 cache-aware 编排实践

1. **共享前缀的工程化落地（Chainguard driftlessaf 库）**：提供 `WithCacheFirstUserBlock` 与 `WithUserPromptSuffix`，把"静态操作员撰写的大 payload"渲染为首个用户消息的独立文本块、把每个任务的小差异指令放**尾部第二块**——专为"多个执行体共享同一大 payload、只变尾部小指令"的舰队执行设计（如多视角 reviewer 各审同一 changeset）。出处：[pkg.go.dev/chainguard.dev/driftlessaf](https://pkg.go.dev/chainguard.dev/driftlessaf@v0.11.7/agents/executor/claudeexecutor)。
2. **分层共享前缀的命中率量化（AutoBot-AI 基建分析）**：把 prompt 拆为 Sections 1–5 共享层（~12.8K tokens）+ Section 6 动态层（~3.2K tokens），**每次调用命中 80%**；Tier1 默认代理组全量共享基础 prompt（命中 90–95%），Tier2 分析代理只共享 identity+architecture 两段（共享 2.3K）。出处：[GitHub mrveiss/AutoBot-AI prompt-optimization-for-vllm-caching.md](https://github.com/mrveiss/AutoBot-AI/blob/542f8591f26b45ecc859d402fe290ad988ff0153/autobot-infrastructure/shared/analysis/prompt-optimization-for-vllm-caching.md)。
3. **批量子代理的"缓存预热门控"（NousResearch hermes-agent PR #86553）**：对批量派出的子代理增加 opt-in 的 prompt-cache warm-up gate / launch stagger——先让一份请求完成 write，再放开其余子代理并发，把整批从"N 次并发 write"变成"1 次 write + N-1 次 read"。出处：[GitHub NousResearch/hermes-agent PR #86553](https://github.com/NousResearch/hermes-agent/pull/86553)。（代价：stagger 引入 (N-1)×S 秒的首波延迟税，报告内已量化。）
4. **服务端路由层的缓存亲和（llm-d-router）**：`prefix-cache-affinity-filter` 按"哪台实例已持有该前缀的 KV cache"做路由，把昂贵 prefill 变成近似免费的缓存查找；对自建推理网的编排者是同样的"命中驱动的派工排序"思想。出处：[pkg.go.dev/llm-d-router prefixcacheaffinity](https://pkg.go.dev/github.com/llm-d/llm-d-router/pkg/epp/framework/plugins/scheduling/filter/prefixcacheaffinity)。
5. **学术系统层**：Prompt Cache（MLSys 2024, arXiv:2311.04934）用 PML 把 prompt 显式建模为可复用模块（module 复用 attention states），证明"把 prompt 结构化为共享模块"可在推理服务端直接省时省钱——编排者组版时可借鉴"模块化 prompt schema"。出处：[arXiv:2311.04934](http://arxiv.org/abs/2311.04934)、[MLSys 论文 PDF](https://proceedings.mlsys.org/paper_files/paper/2024/file/a66caa1703fe34705a4368c3014c1966-Paper-Conference.pdf)。
6. **自建 serving 侧**：vLLM Automatic Prefix Caching 复用已有查询的 KV cache，新查询共享前缀即可跳过共享部分计算；对编排者插件而言，即使不用官方 API 缓存，自建 vLLM 网关同样吃前缀组版的红利。出处：[docs.vllm.ai automatic_prefix_caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)。

### 2.3 组版反模式

- 把"每任务都变的字段"（task_id、时间戳、检索到的文档、上一轮输出）拼在 prompt 前段 → 全批 miss。
- 每个子代理使用不同的 system prompt 措辞（即使语义相同）→ 零共享前缀。
- 多轮子代理对话中频繁"重写"历史（改一个字就打破前缀）→ 全量重算。Anthropic 的自动前移缓存（上文 1.1）就是为避免这个设计的。

---

## 3. 多代理 Token 放大的量化证据

### 3.1 Anthropic 官方数字（第一手证据）

来源：[Anthropic 工程博客《How we built our multi-agent research system》](https://www.anthropic.com/engineering/multi-agent-research-system)（2025-06-13，Jeremy Hadfield 等），量化点：
- **Opus 4 lead + Sonnet 4 subagents 在内部研究 eval 上胜过单代理 Opus 4 达 90.2%**——质量收益是真的。
- **token 用量解释了 BrowseComp 上约 80% 的性能方差**——多代理的收益主要就是"花更多 token"，不是智能上的免费午餐。
- **代理模式平均用约 4× chat 的 token；多代理系统约 15×**——这是该模式最诚实的成本约束。
- 派工规模的经验规则（编排者防失控）：简单事实查找 = **1 个代理、3–10 次工具调用**；直接比较 = **2–4 个子代理、各 10–15 次调用**；复杂研究 = **最多 10+ 子代理**。早期版本曾出现"为琐碎查询生成 50 个子代理"的失控。来源：官方博客第 3 节（独立转述核对：[arthurchiao.art 中文全译](http://arthurchiao.art/blog/built-multi-agent-research-system-zh/)、[beri.net 摘要](https://www.beri.net/learning/anthropic-multi-agent-research-system)、[Simon Willison 笔记](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)）。
- 生产可靠性教训：代理有状态、错误会复合 → 检查点 + 恢复；完全生产级 tracing 才能诊断"agent 找不到明显信息"类故障；同步执行造成瓶颈（单个慢子代理阻塞全局）。来源：博客"Production reliability"节。

**独立解读**（[fuller-smith.co.uk 评论](https://www.fuller-smith.co.uk/commentary/multi-agent-systems-cost-not-free-speed/)）：并行子代理买的是**延迟**（复杂查询研究时间最多省 90%），付的是 **~15× token**——"子代理不是免费的加速，是用 token 买的速度"。Anthropic 博客同时明确指出：共享上下文的任务（如大多数编码任务）不适合多代理（[同上博客](https://www.anthropic.com/engineering/multi-agent-research-system)）。

### 3.2 Cognition《Don't Build Multi-Agents》（对立论点）

来源：[cognition.ai/blog/dont-build-multi-agents](https://cognition.ai/blog/dont-build-multi-agents)（Walden Yan，2025-06-12）：
- 两条 context engineering 原则：**Share full context**（子代理必须携带主任务全上下文，而非片段）与 **Actions carry implicit decisions**（每个代理的行动隐含决策，隔离的代理会做出相互冲突的隐含决策）。
- 论点：多代理的信息割裂导致错误累积与结果冲突（以"开发 Flappy Bird 克隆"为例：背景与角色风格冲突）；子代理若携带完整上下文又**破坏了并行省上下文的初衷**，反而比单代理更贵。
- 结论：**优先单线程代理 + 上下文压缩**（Devin 路线），压缩模型提取"决策与结论"类关键信息。

**与 3.1 的调和**：两份证据并不矛盾——多代理的经济学成立域是「子任务真正独立、不需要共享决策上下文」的研究类广度任务；对需要共享决策的任务，多代理既加 token 又降质量。**编排者的成本感知策略应把"子任务独立性判定"作为派工前的前置门控**（详见第 5 节 D2）。

### 3.3 Token 放大的成本换算（结合第 1 节定价）

- 单代理长任务有天然的**多轮缓存命中**（每轮前缀=上轮全文），实际输入成本远低于名义价；并行子代理各自短对话，**前缀只有 system prompt 段可共享**——若组版不当，15× 放大再叠加 10–50× 的 miss 单价，实际成本差可达 **数十倍到上百倍**。
- 反过来，若组版得当（共享 90% 前缀 + Anthropic read 0.1×），15× 的名义放大可被压回 **~2–4×** 的有效成本——这是缓存经济学对编排策略的最大杠杆。
- KV cache 层面：prefix cache 命中直接免掉共享段的 prefill 计算（[vLLM APC](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)），命中率同时改善 TTFT 与服务端容量——成本低与延迟低同源。

---

## 4. 成本感知编排的已有方案与研究

1. **TALE：Token-Budget-Aware LLM Reasoning**（arXiv:2412.18547）：两阶段——先由"预算估计器"按任务复杂度估算 token 预算，再把预算写进 prompt 引导生成，在保性能的同时显著降 token 成本（token elasticity 观察：只有落在合理区间的预算才有效）。出处：[arXiv 2412.18547](https://arxiv.org/html/2412.18547v3)。→ 编排者可直接复用"按复杂度给每个子代理下发 token 预算"的做法。
2. **BudgetFlow-Agent：成本约束的自动工作流搜索**（IEEE 2026）：把工作流优化建模为多目标问题（性能、token、延迟、失败风险），在 MCTS 中用 cost-aware reward 联合优化，并含可复用算子库；明确批评现有工作"只顾成功率、忽视 token 成本"。出处：[ieeexplore.ieee.org/document/11634430](https://ieeexplore.ieee.org/document/11634430)。
3. **BTUP: Best Token Use Path**（Zenodo 预印本）：把 context policy、prompt transform、**cache strategy**、工具、校验与失败处理放进同一个被优化对象，优化目标是**累计任务成本（CAR）而非单次调用成本**；且"压缩从不无条件施加，控制器基于对下游的预测影响选择 context policy"。出处：[Zenodo BTUP 论文 PDF](https://zenodo.org/records/21387024/files/BTUP_paper_v1.1.pdf)。→ "把缓存策略作为派工决策的一等属性"是已有研究背书的架构。
4. **FrugalGPT / 级联与预算感知路由**：FrugalGPT（Chen et al. 2024）按"从最便宜到最贵逐级查询直到满足置信度阈值"的 cascade 节省成本；后续预算感知路由（Budget-Aware Routing, DAAO 等）在每步/每轨迹做模型选择。在 AgentRouter 类工作的对比实验中被作为基线系统化评估（含端到端完成率、每轨迹美元成本、路由开销毫秒级指标）。出处：[arXiv 2609.22951 对比研究](https://arxiv.org/pdf/2609.22951)。→ 模型路由本身由另一专家专题负责，此处只保留"成本层级结构"结论。
5. **预算感知的级联校准（电商客服基准）**：JISEM 2025 论文给出成本-质量路由基准：前沿模型与小模型每 token 价差 1–2 个数量级，路由应按"意图是否含糊、多轮、政策敏感"分层。出处：[Zenodo JISEM PDF](https://www.zenodo.org/records/21869764/files/JISEM.pdf)。
6. **免费执行器悖论（Free-Executor Paradox）**：代码修复迭代实测——Haiku solo 比"Opus 编排 + 免费执行器"更省还是更差取决于任务结构；结论是关键问题不是"哪个模型最好"而是**"编排者的回读成本何时能被执行器的省费摊销"**。出处：[Zenodo 01-main.pdf](https://zenodo.org/records/20998558/files/01-main.pdf)。→ 编排插件需把"编排者自己的 read-back token"计入成本模型。
7. **Anthropic 生产实践侧**：effort-scaling 规则（第 3.1 节的 1/2–4/10+ 分级）本质就是内嵌在 prompt 里的成本预算分级；token 用量监控占 80% 方差的发现说明"**成本监控本身就是质量监控**"。出处：[multi-agent research system 博客](https://www.anthropic.com/engineering/multi-agent-research-system)。

---

## 5. 面向「编排者插件」的设计启示（8 条可落地）

**D1 · 任务书缓存组版（最高杠杆，先做这个）**
把每个子代理的任务书严格按 `共享前缀（system prompt + 工具定义 + 专家角色规范 + 输出 schema）→ 动态任务参数（放最末）` 组版；同一批次禁止把 task_id/时间戳等变化字段拼在前段。依据：Anthropic 断点机制 + DeepSeek"从 token 0 起才算重复"（§1.1、§1.3、§2.1）。参考实现：Chainguard `WithCacheFirstUserBlock`/`WithUserPromptSuffix`（§2.2-1）。

**D2 · 派工前的独立性门控（成本+质量双重保险）**
对"需要共享决策上下文"的任务（编码改造、跨子任务风格一致性）拒绝并行多代理，改单线程+压缩；只有真正独立的广度任务才 fan-out。依据：Anthropic 自认的适用边界 + Cognition 上下文分裂论点（§3.1、§3.2）。

**D3 · 按 Anthropic 经验规则内嵌 effort 分级预算**
在编排者 prompt 中写死分级：简单=1 子代理/3–10 次调用；比较=2–4 子代理/各 10–15 次调用；复杂=≤10 子代理；并对"琐碎任务禁止派子代理"设硬规则。配合 TALE 思路给每个子代理下发显式 token 预算（§3.1、§4-1）。

**D4 · 批量子代理的"1 write + N read"预热派工**
同一批 N 个共享前缀的子代理不并发首发：先发 1 个完成 cache write，再放行其余 N-1 个吃 read（0.1×）+ 磁盘命中价；用 hermes-agent 的 stagger 经验控制延迟税（首波末位延迟 ≤(N-1)×S 秒，S 取数秒级）（§2.2-3）。

**D5 · 命中率作为一等可观测指标 + 预算熔断**
让每个子代理回传 `prompt_cache_hit/miss_tokens`（DeepSeek/Anthropic usage 均有），编排者按会话/批次聚合命中率；低于阈值（如 <50%）告警并触发组版检查。为每次编排运行设 token/成本硬上限，超限熔断为降级路径（单代理或规则模板）。依据：§1.3、§3.1（token 用量解释 80% 方差→成本监控=质量监控）。

**D6 · 命中驱动的派工排序与调度亲和**
派工队列按"前缀亲和度"排序：把与最近完成请求共享前缀的任务优先派发（复用缓存/TTL 窗口内）；自建网关场景复用 llm-d 的 prefix-cache-affinity 思想（§2.2-4）。同时按厂商峰谷定价排程——DeepSeek 谷时输入/输出全价减半（§1.3），非紧急批量任务可排谷时。

**D7 · 子代理上下文最小化 + 结构化回传**
子代理任务书只含其角色所需字段（不携带编排者全上下文），产出"结构化结果 + ≤200 token 摘要 + 置信度"回传，供编排者综合而非全文注入；这同时抑制 15× 放大中的编排者 read-back 项（§3.1、§3.3、§4-6）。

**D8 · 缓存策略进派工决策函数，按厂商特性分策略**
派工决策把「预期命中率 × 厂商 read 折扣 − write 溢价 × 预期 miss 数（− Gemini 类显式存储费）」作为一项成本属性参与取舍；Anthropic 优先用 5min TTL（1 次命中即回本），跨小时长批次才考虑 1h TTL（2×）或 Gemini 显式缓存（须算 $0.5–1/M tok/h 存储费）。依据：§1.5、§4-3（BTUP 把 cache strategy 作为一等优化对象）。

---

## 附：主要出处一览

| 主题 | URL |
|---|---|
| Anthropic prompt caching 文档 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| OpenAI Prompt Caching 公告 | https://openai.com/index/api-prompt-caching/ |
| OpenAI prompt caching 文档 | https://platform.openai.com/docs/guides/prompt-caching |
| DeepSeek 硬盘缓存公告 | https://api-docs.deepseek.com/zh-cn/news/news0802 |
| DeepSeek 模型与定价 | https://api-docs.deepseek.com/quick_start/pricing |
| Gemini 2.5 implicit caching 公告 | https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/ |
| Gemini API 定价 | https://ai.google.dev/gemini-api/docs/pricing |
| Anthropic 多代理研究系统博客 | https://www.anthropic.com/engineering/multi-agent-research-system |
| Cognition《Don't Build Multi-Agents》 | https://cognition.ai/blog/dont-build-multi-agents |
| Simon Willison 笔记 | https://simonwillison.net/2025/Jun/14/multi-agent-research-system/ |
| Chainguard 缓存组版库 | https://pkg.go.dev/chainguard.dev/driftlessaf@v0.11.7/agents/executor/claudeexecutor |
| AutoBot-AI 分层前缀命中率分析 | https://github.com/mrveiss/AutoBot-AI/blob/542f8591f26b45ecc859d402fe290ad988ff0153/autobot-infrastructure/shared/analysis/prompt-optimization-for-vllm-caching.md |
| hermes-agent 缓存预热门控 PR | https://github.com/NousResearch/hermes-agent/pull/86553 |
| llm-d prefix-cache 亲和路由 | https://pkg.go.dev/github.com/llm-d/llm-d-router/pkg/epp/framework/plugins/scheduling/filter/prefixcacheaffinity |
| Prompt Cache (MLSys 2024) | http://arxiv.org/abs/2311.04934 |
| vLLM 自动前缀缓存 | https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/ |
| TALE 论文 | https://arxiv.org/html/2412.18547v3 |
| BudgetFlow-Agent | https://ieeexplore.ieee.org/document/11634430 |
| BTUP | https://zenodo.org/records/21387024/files/BTUP_paper_v1.1.pdf |
| AgentRouter 级联/路由对比 | https://arxiv.org/pdf/2609.22951 |
| JISEM 预算级联基准 | https://www.zenodo.org/records/21869764/files/JISEM.pdf |
| Free-Executor Paradox | https://zenodo.org/records/20998558/files/01-main.pdf |
| Anthropic caching 定价汇总（respan） | https://www.respan.ai/articles/claude-prompt-caching |
| 多代理成本评论 | https://www.fuller-smith.co.uk/commentary/multi-agent-systems-cost-not-free-speed/ |
