# GitHub Agent 编排项目全景调研（2026-11）

> 调研性质：纯外部文献/产品调研（网络检索 4 轮），未改动任何实现。日期：2026-11-11。
> 用途：为 dsh-expert-orchestrator 后续开发方向提供参考。
> 交叉引用：与[编排经济学调研线](../orchestration-economics/00-overview.md)重叠的方向（模型路由、成本、context engineering）以其分报告为准，本文只做索引。
> 证据强度：本文为二手综述性质（GitHub README / 官方文档 / 第三方报道），未做一手实测；引用以文中 URL 为准。

## 1. 通用编排框架梯队

| 项目 | 定位 | 特点 |
|---|---|---|
| [LangGraph](https://github.com/langchain-ai/langgraph) | 图状态机编排 | 持久化/检查点/HITL/流式，已到 1.x，生产就绪；适合分支与长时任务 |
| [CrewAI](https://github.com/crewAIInc/crewAI)（~33k★） | 角色团队协作 | Flows + hierarchical crews，已接入 A2A |
| [AutoGen](https://github.com/microsoft/autogen)（~46k★） | 对话式多代理 | 已与 Semantic Kernel 合并为 MS Agent Framework（企业级 + A2A）；社区分叉 [AG2](https://github.com/ag2ai/ag2) 延续 |
| OpenAI Agents SDK | 极简编排 | handoffs/guardrails，provider-agnostic（100+ LLM），抽象层极薄 |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT)（48k+★） | SOP 驱动软件公司模拟 | PRD→设计→代码→测试流水线 |
| [Swarms](https://github.com/kyegomez/swarms)（~7k★） | 企业级集群 | 顺序/并行/层级/混合多种编排模式 |
| [DeepCode](https://github.com/HKUDS/DeepCode)（13.3k★） | 论文转代码多代理 | 用 MCP 协调专职代理（解析/规划/实现/测试/文档） |

**趋势**：「agent = LLM 在循环中自主用工具」已成共识定义；厚框架让位于薄循环——OpenAI SDK 与 Claude Code 都刻意保持抽象极薄。参考：[awesome-ai-agent-frameworks 中文选型指南](https://github.com/Vincentwei1021/awesome-ai-agent-frameworks)、[LLM-Agents-Ecosystem-Handbook 框架对比](https://github.com/oxbshw/LLM-Agents-Ecosystem-Handbook/blob/main/docs/framework_comparison.md)。

## 2. 自动编排优化（学术前沿）

- [AFlow](https://github.com/FoundationAgents/AFlow)（ICLR 2025）：MCTS 自动搜索「代码表示」的 agentic workflow。
- [MaAS](https://github.com/bingreeky/MaAS)：agentic supernet，按 query 动态采样多代理架构。
- [DAAO](https://github.com/AutoAgents-ai/DAAO)（WWW'26）：基于 MaAS，RL 训练「调度大脑」——按题目难度动态决定用哪些推理算子、配哪个 LLM、走几层，「答得准又省钱」。
- ADAS：meta-agent 自动发明编排方案；FlowMAS（[arXiv 2609.37151](https://arxiv.org/html/2609.37151v1)）：信息引导 GFlowNet 学工作流拓扑。

共同主张：**编排本身是可以被学习/优化的对象**（质量与成本联合优化）。深入展开见[编排经济学 · 01-model-routing](../orchestration-economics/01-model-routing.md)。

## 3. 协议标准化（互操作层）

- **MCP**：2025-11 发布 Tasks 扩展，2026-07 RC 规范；[CNCF 正式评估其作为分布式代理系统的 wire spec](https://tech.yahoo.com/ai/meta-ai/articles/cncf-evaluates-mcp-cloud-native-142016206.html)（TOC initiative #1746，类比 OCI 地位）。
- **A2A**：[Google 2025-04 发布](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)，2025-12 捐赠 Linux 基金会。
- **ACP**：编辑器集成协议（VS Code/Zed/JetBrains）；另有 [agent-api-server](https://pypi.org/project/agent-api-server/2.1.9/) 对三层协议格局的梳理。
- 三层互补格局成形：MCP=LLM 调工具，ACP=编辑器集成，A2A=代理间协作；2026-03 成立 Agent API Initiative (AAIF)。

## 4. 编码代理「任务管控」（与本插件最直接对标）

1. **[Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)**（官方，实验特性）：lead + teammates、共享任务板、代理间消息传递。两个工程细节值得借鉴：① 文档明确建议「先检查是否有更轻量的选项」——协调开销和 token 消耗远高于单会话；② **代理转达的批准被视为不可信输入**，teammate 不能代替人批准权限，被拒绝的动作不能经由其他 teammate 中继绕过。
2. **[OpenHands](https://github.com/All-Hands-AI/OpenHands)**：AgentDelegate 树形嵌套控制器，共享 EventStream，`delegate_level` 分层 + 全局共享 token 指标（架构分析见 [Clade 的 OpenHands 架构笔记](https://raw.githubusercontent.com/shenxingy/Clade/33bba56feb707b2e6ac956b51e9fbd12500eadf7/docs/research/2026-03-30-openhands-architecture.md)）。
3. **[mission-control](https://github.com/clawputer-labs/mission-control)**（及 [sj-unit72/mission-control](https://github.com/sj-unit72/mission-control)）：JSON 文件为唯一真源（无数据库、无云依赖），代理人格 = spawned 会话，daemon 常驻轮询，**循环检测失败 3 次自动升级给人**，报告进收件箱。
4. **Agent Kanban**（[vtit-agent-kanban](https://www.npmjs.com/package/vtit-agent-kanban)）：agent-first 看板，每个代理有 **Ed25519 加密身份** + 角色 + 可加载技能，代理可自建任务、互派任务、**自组织成队**。
5. **EVOX**（[xkhanhs/evox-nex](https://github.com/xkhanhs/evox-nex)）：角色代理（PM/后端/前端）+ 外部系统（Linear）为真源 + 2 分钟同步实时仪表盘，PM 代理负责写复盘。

## 5. 范式趋势提炼

1. **前沿从 prompt engineering 转向 context engineering**（Anthropic 2024-12《Building effective agents》→ 2025-09《Effective context engineering for AI agents》是分水岭）：编排的核心问题变成「管理流经链条的上下文」——压缩、记忆、子代理隔离。深入展开见[编排经济学 · 03-context-engineering](../orchestration-economics/03-context-engineering.md)。
2. **人机协作任务管控 UX 成为独立品类**：看板/仪表盘/收件箱；文件态任务板作为「代理可读写的互操作层」是共同架构选择。
3. **代理身份与信任**成为新工程问题：加密身份、权限中继安全、审计分离。
4. **沙箱化/容器化 worker**、循环检测与人工升级是生产标配（[多代理框架全景 2026](https://github.com/SteveGJones/ai-first-sdlc-practices/blob/main/library/multi-agent-framework-landscape.md) 对 sandbox/comms 有专门梳理）。
5. **自适应编排**（按难度与成本路由）从论文走向落地（DAAO 等）。

## 6. 对 dsh-expert-orchestrator 的候选开发方向

已有能力（专家花名册 + summon、共享任务板 `team_task_*`、四泳道看板、消息总线、多板切换）正好对标 Claude Code agent teams / Agent Kanban 这条线。候选方向按性价比排序：

1. **任务板开放为代理可读写真源**（mission-control 模式）：代理自建任务、互派任务、自组织——目前任务板偏「lead 派发」，可增加代理侧主动写路径。**← 用户已于 2026-11-11 开始推进此方向**。
2. **编排经济学**：子代理上下文/缓存成本感知、按任务难度路由模型与专家数量（呼应 DAAO「调度大脑」与 context engineering 主线）——已有专门调研线 [orchestration-economics](../orchestration-economics/00-overview.md)。
3. **循环检测与人工升级**：子代理卡死/重复失败 N 次自动上报 lead 或用户。
4. **代理身份与信任链**：至少先做「代理转达的批准不可信」这类安全语义。
5. **协议对接**（中长期）：任务板/专家能力以 MCP 或 A2A 形态导出，成为可互操作节点。
