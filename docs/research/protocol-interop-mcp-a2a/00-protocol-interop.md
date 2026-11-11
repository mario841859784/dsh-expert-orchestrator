# 协议对接：把「任务板 + 专家花名册」导出为可互操作节点（2026-11）

> 调研性质：纯外部文献/规范调研（网络检索 8 轮，官方规范页逐页精读），未改动任何实现。日期：2026-11-12。
> 用途：为 dsh-expert-orchestrator 的 MCP/A2A 导出面做可行性与技术选型前置。
> 证据强度标注：**[一手规范]** = 官方规范原文已逐页核读；**[官方文档]** = 厂商官方文档/公告（检索摘要核对）；**[二手]** = 第三方文章，仅作旁证；**[未逐一核对]** = 检索结果转述，未打开原文。
> 交叉引用：[编排全景调研](../agent-orchestration-landscape/00-landscape.md) §3 协议标准化、§6 候选方向 5（协议对接）。

## 1. 问题定义

本插件目前是一个「协议孤岛」：任务板、消息总线、专家花名册只在本插件进程内可用，外部接触面只有裸 CLI。把任务板 + 花名册导出为 MCP/A2A 可互操作节点，动机有四：

1. **外部代理加入任务板（跨宿主编排）**。其他宿主（Claude Code、别的编排器、其他会话）目前只能以「同工作区文件访问」为前提调 `taskboard.py`；导出为 MCP 节点后，任何 MCP 客户端可以不依赖文件系统假设、以标准 JSON-RPC 面读写任务板——这正好补上[全景调研](../agent-orchestration-landscape/00-landscape.md) §4「任务板开放为代理可读写真源」的对外一侧。
2. **外部工具审计**。仪表盘/工单系统/看板 UI 可以用 MCP Resources 或 tools 只读面拉取板状态，不必解析内部 JSON 事件流；tools/call 的结构化入参也优于散落 shell 历史的审计残留（§5-8）。
3. **花名册作为能力公告**。专家花名册天然映射 A2A AgentCard 的 skills 列表：外部协调者先发现「有哪些专家可委派、各擅长什么」，再谈传输——A2A 的发现模型就是「先读卡、后连线」（§3.1）。
4. **时机窗口**。两大协议均已入中立基金会（MCP→AAIF 2025-12、A2A→LF 2025-06，§2.4/§3.1），规范面进入稳定期（stdio 自 2024-11 未变、Tools/Resources API 前后兼容），此时做导出，选型的失效风险最低。

关键约束：外部写路径的调用者**天然是代理**——本插件已裁决「代理转达的批准视为不可信输入」（见全景调研 §4 Claude Code agent teams 的同类语义），导出面必须继承这条信任链语义，而不是绕开它。

## 2. MCP 现状精读

### 2.1 核心规范形态

- **协议基底**：MCP 是构建在 JSON-RPC 2.0 上的开放协议。规范首页：[modelcontextprotocol.io/specification/2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18) **[一手规范]**。
- **传输层**（[transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) **[一手规范]**）：两种标准传输。
  - **stdio**：客户端把 MCP server 当子进程拉起，stdin/stdout 交换 JSON-RPC 消息，**换行分隔且消息内不得嵌换行**；stdout 只许写合法 MCP 消息（日志走 stderr）；规范原文「Clients **SHOULD** support stdio whenever possible」。
  - **Streamable HTTP**：取代已弃用的 HTTP+SSE（2025-06-18 起）；单一 MCP endpoint，POST 发消息、GET 开 SSE 流；支持 `Mcp-Session-Id` 会话、`Last-Event-ID` 断线续传；安全要求三条：校验 `Origin`（防 DNS rebinding）、本地只绑 127.0.0.1、实现认证。
- **Tools API**（[server/tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) **[一手规范]**）：
  - `tools/list`（游标分页）发现，`tools/call`（`name` + `arguments`）调用；服务端声明 `tools` 能力 + `listChanged` 通知。
  - 工具定义：`name`/`title`/`description`/`inputSchema`（JSON Schema）/可选 `outputSchema` + `structuredContent`；**`annotations`（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`）只是提示，规范警告「clients MUST consider tool annotations to be untrusted unless they come from trusted servers」**——导出面不能靠 hint 做权限执法，须在服务端强制。
  - 双轨错误：协议错误（JSON-RPC error）与工具执行错误（`isError: true` 的正常响应）。
- **Resources**（[server/resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) **[一手规范]**）：URI 标识的上下文数据，`resources/list` / `resources/read` / 模板资源 / 可选订阅（`resources/subscribe` + 更新通知）——任务板状态文件、花名册 JSON 都适合作为只读 Resource 导出（树状只读、应用驱动）。
- **生命周期与版本协商**（[lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) **[一手规范]**）：`initialize` 请求带客户端支持的 `protocolVersion`；服务端支持则**原样返回**，不支持则返回自己支持的另一版本；客户端不支持则断开。stdio 关停顺序：关 stdin → 等退出 → SIGTERM → SIGKILL。

### 2.2 授权（2025-06-18 修订）

- [authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) **[一手规范]**：基于 **OAuth 2.1**（draft-13）+ RFC 8414/7591/9728。**受保护 MCP server = OAuth 2.1 resource server**；MCP server **MUST** 实现 RFC 9728 Protected Resource Metadata，401 响应 **MUST** 带 `WWW-Authenticate` 指向资源元数据；token 必须 RFC 8707 `resource` 参数绑定受众、**MUST NOT** token passthrough。
- **stdio 传输明确不在该授权规范内**：原文「Implementations using an STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment」——本地导出面的身份凭据走环境变量/参数是规范预期的形态。
- 第三方精读佐证：[den.dev 2025-11 授权修订解读](https://den.dev/blog/mcp-november-authorization-spec) **[二手]**。

### 2.3 Tasks 扩展（2025-11）

- [官方 Tasks 扩展文档](https://modelcontextprotocol.io/extensions/tasks/overview)（spec: [modelcontextprotocol/ext-tasks](https://github.com/modelcontextprotocol/ext-tasks)）**[一手规范]**：为长时操作返回**持久任务句柄**而非阻塞——`CreateTaskResult`（`taskId`/TTL/轮询间隔）→ `tasks/get` 轮询 → `tasks/update` 中途喂输入 → `tasks/cancel`（协作式，不保证生效）。任务状态：`working`/`input_required`/`completed`/`failed`/`cancelled`（后三个终态）。**宿主支持因客户端而异**，须双方显式 opt-in（扩展能力协商 `io.modelcontextprotocol/tasks`）。
- 引入时点：2025-11-25 规范修订（[WorkOS 解读](https://workos.com/blog/mcp-2025-11-25-spec-update) **[二手]**：「experimental Tasks primitive，call-now/fetch-later」）。
- 与 A2A 任务模型对照见 §3.2——两者状态机惊人地同构（working/input_required/completed/failed/cancelled 与 A2A 的 working/input_required/completed/failed/canceled/rejected 几乎逐态对应）。对本插件的含义：taskboard.py 的事件流任务天然可以双挂到两个协议的任务抽象上，无需为其中一个改模。

### 2.4 注册表与最小服务端

- **官方注册表**：[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) + [registry/about](https://modelcontextprotocol.io/registry/about) **[官方文档]**：公开 MCP server 元数据中心，`server.json` 统一 schema + 公开 REST API（[modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)）。
- **治理**：Anthropic 于 2025-12-09 把 MCP 捐给 Linux 基金会旗下 Agentic AI Foundation（Anthropic/Block/OpenAI 共同发起）（[官方公告](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation) **[官方文档]**）。
- **无 SDK 最小 stdio 服务端**（Python 标准库即可）：[foojay.io raw stdio 解析](https://foojay.io/today/understanding-mcp-through-raw-stdio-communication/)（Java 示例，逐行 JSON-RPC、writer.flush 即时送达、**绝不写 stdout 日志**）+ [sesen.ai 无 SDK Python 教程](https://sesen.ai/blog/mcp-server-python-without-the-sdk)（纯标准库实现 `initialize`/`notifications/initialized`/`tools/list`/`tools/call`/`ping`，与官方 SDK 客户端互通）**[二手教程]**。最小面 = 5 个方法 + 新行分隔 JSON；常见坑：把日志写进 stdout、误用 Content-Length 帧（stdio 无帧头）。
- **安全基线**（[security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) **[一手规范]**）：本地 stdio server「**以与客户端相同的特权运行**」是官方原话级别的警告；官方建议本地服务「Use the `stdio` transport to limit access to just the MCP client」；一键配置本地 server **MUST** 先经用户同意并完整展示要执行的命令。

### 2.5 生产平台如何用 MCP 导出任务系统

| 平台 | 工具面形态 | 出处与强度 |
|---|---|---|
| Linear（官方） | 「查找/创建/更新 issues、projects、comments」——读（search/list/get）+ 写（create/update/assign/状态变更）+ 评论，官方持续扩充 | [linear.app/docs/mcp](https://linear.app/docs/mcp) **[官方文档]** |
| GitHub（官方） | 按命名 toolset 组织（`issues`、`pull_requests`…）；2025-10-29 起把细粒度工具合并为多功能工具（如 `create_and_submit_pull_request_review`）；`X-MCP-Toolsets` 头可选子集 | [github-mcp-server](https://github.com/github/github-mcp-server)、[官方 changelog](https://github.blog/changelog/2025-10-29-github-mcp-server-now-comes-with-server-instructions-better-tools-and-more) **[官方文档]** |
| Notion（官方） | 把 REST API 端点直接映射为工具：`API-post-search`、`API-post-page`、`API-patch-page`、`API-query-data-source` 等（Docker Hub 列出 24 个工具）；另有官方托管远程版 | [makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server)、[Docker Hub 工具清单](https://hub.docker.com/mcp/server/notion) **[官方文档]** |
| Asana（社区） | CRUD 任务工具（如 `asana_get_task_stories`）；已知缺口：不能直接创建到指定 section、描述编辑不进活动历史 | [ampcome-mcps/asana-mcp](https://github.com/ampcome-mcps/asana-mcp)、[Glama 工具页](https://glama.ai/mcp/servers/BlZvi/asana-mcp-server/tools/asana_get_task_stories) **[二手]** |

共性结论：任务系统的 MCP 导出几乎都收敛为「**read 组（search/list/get）+ write 组（create/update/transition）+ 评论组**」三分面；第三方经验总结也推荐「先读后写、批量调用」（[agenticskills.io Linear 技能页](https://agenticskills.io/skills/linear) **[二手]**）。**「写组显式 opt-in」没有规范强制的开关，全靠服务端自己执法**——这是本插件要自己补的。

## 3. A2A 现状精读

### 3.1 AgentCard 与 AgentSkill

- Google 2025-04 发布 A2A（[官方博客](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) **[未逐一核对]**，官方站转述）；**2025-06-23 捐赠 Linux 基金会**成立 Agent2Agent 项目（[LF 公告](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents) **[一手公告]**，已逐页核读：AWS/Cisco/Salesforce/SAP/Microsoft/ServiceNow 背书，100+ 企业支持）。注意：全景调研旧文记「2025-12 捐赠」，据 LF 原文应更正为 2025-06；2025-12 是 MCP 捐入 AAIF。
- **AgentCard**（[agent2agent.info/docs/concepts/agentcard](https://agent2agent.info/docs/concepts/agentcard) **[官方镜像文档]**，规范源 [a2aproject/A2A](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) **[未逐一核对·超时]**）：
  - v1.0 必备字段：`name`/`description`/`version`/`supportedInterfaces`/`capabilities`/`defaultInputModes`/`defaultOutputModes`/`skills`；可选：`provider`/`documentationUrl`/`iconUrl`/`securitySchemes`/`securityRequirements`/`signatures`。
  - v0.2.x → v1.0 改名：`url`/`preferredTransport`/`additionalInterfaces` → 统一为 `supportedInterfaces[]`（按优先序列绑定+URL 组合）；`security` → `securityRequirements`。
  - **卡片可签名**：RFC 8785 规范化 + RFC 7515 JWS；「Clients SHOULD verify at least one signature before trusting a card」。
- **AgentSkill**：核心四字段 `id`/`name`/`description`/`tags`；可选 `examples`/`inputModes`/`outputModes`/`securityRequirements`。**skill 是发现的单元**——与专家花名册的「适用任务/禁入任务/典型交付」逐字段对得上（tags≈适用任务、description≈典型交付、examples≈few-shot）。
- **发现**（[agent-discovery](https://github.com/a2aproject/A2A/blob/main/docs/topics/agent-discovery.md) **[官方文档·未逐页]** + [agent2agent.info](https://agent2agent.info/docs/concepts/agentcard)）：三渠道——① well-known URI（RFC 8615）：**v1.0 为 `/.well-known/agent-card.json`，旧版为 `/.well-known/agent.json`**，两者仍在野外共存（[agentcard.net 校验器](https://www.agentcard.net/well-known-agent-json) **[二手]**，Microsoft 的 resolver 默认路径仍可配旧名）；② 注册表/目录（curated collections）；③ 直接配置 URL 或内联卡片。

### 3.2 任务生命周期与协议分工

- **Task = A2A 核心动作单元**（[agent2agent.info/docs/concepts/task](https://agent2agent.info/docs/concepts/task) **[官方镜像文档]**）：8 状态——`submitted`/`working`（活动）、`input_required`/`auth_required`（中断）、`completed`/`failed`/`canceled`/`rejected`（终态）。要点：**任务 ID 恒为服务端生成**（客户端不造 ID）；终态不可复活（follow-up 开新任务但共用 contextId）；向终态任务发消息返回 UnsupportedOperationError；断线≠取消（须 GetTask 对账，「重试策略必须考虑前一请求可能已产生副作用」——与任务板 CAS/attempt 代际防重入同构）。操作面：`message/send`、`message/stream`、`tasks/get`、`tasks/cancel`（CancelTask 不保证成功）。更新三通道：轮询 / 流式 / push webhook。
- **客户端行为规范**（同一页）：`input_required` 时客户端**续用同一 taskId** 发后续消息（「the client does not manufacture another task ID to mean 'turn two'」）；`auth_required` 时认证走任务历史之外的通道，凭证不进任务历史。这些约束与任务板「attempt 代际绑定 + 审计字段落档」的既有语义可直接对齐。
- **A2A vs MCP 分工**（[官方专题页 a2a-and-mcp](https://a2a-protocol.org/latest/topics/a2a-and-mcp/) **[一手官方文档]**，已逐页核读）：
  - 「**MCP is vertical. It deepens a single agent. A2A is horizontal. It connects agents across that boundary.**」「MCP connects an agent to tools, APIs, and data. A2A connects it to other agents.」
  - 组合模式：「An agentic application might use A2A to communicate with other agents. Inside, each agent uses MCP to work with its own tools and resources.」
  - **官方给出的桥接面**：「An A2A Server (a remote agent) can expose some skills as MCP-compatible resources」——即同一能力可以既挂 MCP 工具面又挂 A2A 卡片，正好是本插件「任务板 MCP 化 + 花名册 A2A 卡片化」双轨导出的规范依据。

## 4. 其他参考（各一段）

- **ACP（Agent Client Protocol）**：Zed 发起的**编辑器↔编码代理**协议（[zed.dev/acp](https://zed.dev/acp) **[官方文档]**），Claude Code/Gemini CLI 可经 ACP 接入任意支持编辑器（[Zed 外部代理文档](https://zed.dev/docs/ai/external-agents)、[claude-agent-acp 适配器](https://github.com/agentclientprotocol/claude-agent-acp)）。对本插件的意义：它是「同一能力、换宿主复用」的第三条路，但面向 IDE 场景，与任务板导出无直接交集。
- **AG-UI（Agent–User Interaction Protocol）**：CopilotKit 支持的**前端↔代理**事件式协议，标准化流式 UI 事件与 human-in-the-loop 工具交互（[docs.ag-ui.com](https://docs.ag-ui.com/introduction) **[官方文档]**）。本插件无需此层——UI 归宿主（Typert），不归插件。
- **OpenAI Agents SDK handoffs**：**handoff = 把整段会话控制权移交给专职代理**；与「agent-as-tool」（调用方保留控制权、另一代理仅作可调用工具）相对（[官方文档](https://openai.github.io/openai-agents-python/handoffs) **[官方文档]**、[对比文](https://www.linkedin.com/pulse/understanding-handoffs-vs-agents-as-tools-openais-agents-majid-sheikh-cvxgf) **[二手]**）。概念上印证本插件 summon 模型（lead 保留控制权、专家按任务书交付）属于 agent-as-tool 一侧，而任务板是两者之外的第三种协调媒介。

## 5. 设计提炼（可落地启示）

1. **MCP stdio 服务端包 CLI = 最低成本导出**。stdio 传输就是「子进程 + 新行分隔 JSON-RPC 2.0」，与 taskboard.py/bus.py 的「子进程 + 单行 JSON 回执」形态几乎同构（§2.4 无 SDK 佐证）：薄 Python 脚本把 `tools/list`/`tools/call` 翻译成 `taskboard.py`/`bus.py` 子调用并回传其单行 JSON 回执，无需任何 SDK，`initialize`/`notifications/initialized`/`tools/list`/`tools/call`/`ping` 五方法即可上客户端。
2. **读先于写（read-first export）**。默认只导只读工具（status/list/show/metrics）+ Resources（板状态文件、roster.json）；写类工具（create/claim/done/approve…）须显式 opt-in 开关才注册。规范依据：annotations 只是提示不可执法（§2.1），MCP 无标准写权限开关——必须服务端自执法。具体命名可循 GitHub 官方 toolset 先例（`X-MCP-Toolsets` 头选子集，§2.5）：导出面用环境变量如 `DSH_EXPERT_MCP_TOOLS=read` / `read,write` 分档。信任链语义：外部写路径的调用者天然是代理（MCP 客户端背后是 LLM），与「代理转达的批准视为不可信输入」同构——外部写默认走 draft/approve 面而非直入 ready，复用任务板既有批准流（代理 scoped 自建的 `--created-by --of` 成对入口 + 强制 draft 已就位，正好是外部写的落点）。
3. **身份：参数/环境变量显式传入，自我声明留档**。stdio 无 OAuth（规范明言 stdio 不走授权规范、凭据从环境取，§2.2）。导出面接受 `--by <caller-id>` 式参数与环境变量注入，语义为「客户端自我声明，不验证」——与 taskboard.py 既有 `--by`/`--created-by` 审计口径一致；文档如实写明这是声明式身份，不防伪造（能写工作区文件者本可直改板，§bus.py 既有威胁模型）。
4. **A2A AgentCard 从花名册生成（card-first, transport later）**。每个专家 = 一个 AgentSkill（id=专家名、tags=适用任务、description=典型交付）；整个插件 = 一张 AgentCard。先落卡片的静态生成（从 `expert-sources/merged/roster.json` 派生 agent-card.json），传输端（A2A server）后做——官方已预留「A2A Server 可把 skill 暴露为 MCP 兼容资源」的桥接面（§3.2），MCP 面可先行、A2A 卡片声明零成本。
5. **well-known 发现路径按现版走 + 兼容旧名**。卡片落 `/.well-known/agent-card.json`（v1.0）；若宿主生态仍按旧版探测，可同路径补发 `/.well-known/agent.json`（两者野外共存，§3.1）。MCP 侧对应「注册表 server.json」形态——本地插件可不进注册表，靠宿主配置直连即可。
6. **不导出 summon 本身（递归防线留在进程内）**。花名册只导「存在性与胜任面」，不导「召唤通道」：外部代理拿到的是任务板写面（代理 draft → 本插件 lead 审批），不是直接 spawn 本插件专家的能力。否则外部编排器可借导出面造成跨宿主任命链（A 召 B、B 召回 A 的宿主级环路），与 lib/origin-chain.js 的进程内（expert, cwd）重复 hops 拒绝语义冲突——导出面保持 origin-chain 单机封闭，是同一裁决的对外延伸。
7. **版本协商直接复用规范机制**。MCP：`initialize` 里服务端「支持则原样返回、否则返回自己最新、客户端不认则断开」（§2.1）；HTTP 面加 `MCP-Protocol-Version` 头、缺省按 2025-03-26 兜底。导出脚本固定声明单一支持版本（如 2025-06-18）即可，无需自造兼容层。A2A 卡片带 `protocolVersion` 字段同理。
8. **安全叙事如实：本地 stdio = CLI 同信任级**。官方原话「MCP servers run with the same privileges as the client」+ 建议「stdio 限制访问面仅为 MCP 客户端」（§2.4）。导出 MCP 不引入新的特权边界——能连 stdio 的进程本来就能调 CLI；要把这句话写进导出文档，不宣称「MCP 化增强了安全性」。真正的增量安全收益在**审计**：tools/call 的 name/arguments 全程结构化留痕，优于散落 shell 历史。

## 6. 与本插件现状的对照

已有能力（均为一手代码事实）：

- **任务板**：`skills/expert-orchestration/tools/taskboard.py`——状态机 + 依赖 DAG + 崩溃恢复 + CAS revision；全部 stdout 为**单行 JSON 回执**（契约按精确键名校验，见 SKILL.md §回执契约严格化）；代理 scoped 自建任务已有入口（`create --created-by <专家名> --of <任务id>`，强制 draft、scope ⊆ 父任务）；m 票评审、escalated 终态均已落。
- **消息总线**：`skills/expert-orchestration/tools/bus.py`——落盘信箱 + at-least-once 游标 + 过代过滤；信箱根随 cwd 的约定已成文。
- **花名册**：`expert-sources/merged/roster.json`（bundled-core + 已启用外部来源；入册登记来源名/路径/sha256；跨源重名并存）+ `list_experts` 工具（紧凑/展开双模式）。
- **召唤**：`lib/tools.js` 的 `summon_expert`/`summon_experts`/`list_experts`——**插件自有进程内工具**（v2.3），origin-chain 防线在 `lib/origin-chain.js`（进程内）。
- **宿主内配置面**：`lib/remote.js`——Typert Remote 服务（cordis.patch.yml 根服务声明），expertSources 设置 API 仅宿主可达，非跨进程协议。

GAP：**无任何 MCP/A2A 导出面**。外部代理/工具接触任务板唯一途径是裸 CLI（要求共享工作区与 Python 环境），外部世界无从发现花名册能力。对照 §5：导出 MCP 的全部材料（单行 JSON 回执、`--by` 审计参数、draft 批准流、只读命令族）都已就位，缺的只是一个 JSON-RPC stdio 适配层 + 一张从 roster.json 派生的 AgentCard；这与其余候选方向相比工程量最小、且不动信任模型（新写面全部落在既有 draft/approve 语义内）。

导出候选面清单（对照 §5 的落点）：

- **tools（只读档）**：`taskboard_status` / `taskboard_list` / `taskboard_show` / `taskboard_metrics` / `bus_stats` / `list_experts`——每个工具 = taskboard.py/bus.py 既有子命令的直译，输入 schema 从 argparse 参数面机械派生，输出原样透传单行 JSON 回执（structuredContent + text 双轨，对齐 §2.1）。
- **tools（写档，opt-in）**：`taskboard_create`（外部代理恒走 `--created-by --of` + draft）/ `taskboard_progress` / `bus_send`——不导 `approve`/`retry`/`recover`/escalated 解除等用户裁决类命令（这些是「代理转达的批准不可信」的反面，必须留在人/lead 手里）。
- **resources**：`expert-taskboard://<board>/tasks`（板状态）、`expert-taskboard://<board>/events`（事件流）、`expert-roster://merged/roster.json`（花名册）——URI scheme 自定义需符合 RFC 3986（§2.1 Resources）。
- **A2A 卡片**：`agent-card.json` 由构建脚本从 `expert-sources/merged/roster.json` + `roster-aliases.json` 派生，随版本重生成；`capabilities.streaming=false`、传输接口留空——先声明能力，传输后置。

## 7. 出处清单

| # | 出处 | 证据强度 | 访问状态 |
|---|---|---|---|
| 1 | https://modelcontextprotocol.io/specification/2025-06-18/basic/transports | 一手规范 | 已逐页核读 |
| 2 | https://modelcontextprotocol.io/specification/2025-06-18/server/tools | 一手规范 | 已逐页核读 |
| 3 | https://modelcontextprotocol.io/specification/2025-06-18/server/resources | 一手规范 | 已逐页核读 |
| 4 | https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle | 一手规范 | 已逐页核读 |
| 5 | https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization | 一手规范 | 已逐页核读 |
| 6 | https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices | 一手规范 | 已逐页核读 |
| 7 | https://modelcontextprotocol.io/extensions/tasks/overview | 一手规范 | 已逐页核读 |
| 8 | https://workos.com/blog/mcp-2025-11-25-spec-update | 二手 | 检索摘要 |
| 9 | https://modelcontextprotocol.io/registry/about 、https://registry.modelcontextprotocol.io 、https://github.com/modelcontextprotocol/registry | 官方文档 | 检索摘要 |
| 10 | https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation | 官方公告 | 检索摘要 |
| 11 | https://foojay.io/today/understanding-mcp-through-raw-stdio-communication/ | 二手教程 | 已核读 |
| 12 | https://sesen.ai/blog/mcp-server-python-without-the-sdk | 二手教程 | 检索摘要 |
| 13 | https://linear.app/docs/mcp | 官方文档 | 检索摘要 |
| 14 | https://github.com/github/github-mcp-server 、https://github.blog/changelog/2025-10-29-github-mcp-server-now-comes-with-server-instructions-better-tools-and-more | 官方文档 | 检索摘要 |
| 15 | https://github.com/makenotion/notion-mcp-server 、https://hub.docker.com/mcp/server/notion | 官方文档 | 检索摘要 |
| 16 | https://github.com/ampcome-mcps/asana-mcp 、https://glama.ai/mcp/servers/BlZvi/asana-mcp-server/tools/asana_get_task_stories | 二手 | 检索摘要 |
| 17 | https://agenticskills.io/skills/linear | 二手 | 检索摘要 |
| 18 | https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents | 一手公告 | 已逐页核读 |
| 19 | https://agent2agent.info/docs/concepts/agentcard | 官方镜像文档 | 已逐页核读 |
| 20 | https://agent2agent.info/docs/concepts/task | 官方镜像文档 | 已逐页核读 |
| 21 | https://github.com/a2aproject/A2A/blob/main/docs/specification.md | 一手规范 | 未逐一核对（两次抓取超时） |
| 22 | https://github.com/a2aproject/A2A/blob/main/docs/topics/agent-discovery.md | 官方文档 | 检索摘要 |
| 23 | https://www.agentcard.net/well-known-agent-json | 二手 | 检索摘要 |
| 24 | https://a2a-protocol.org/latest/topics/a2a-and-mcp/ 、https://a2a-protocol.org/latest/ | 一手官方文档 | 已逐页核读 |
| 25 | https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/ | 官方公告 | 未逐一核对（连接超时） |
| 26 | https://zed.dev/acp 、https://zed.dev/docs/ai/external-agents | 官方文档 | 检索摘要 |
| 27 | https://docs.ag-ui.com/introduction | 官方文档 | 检索摘要 |
| 28 | https://openai.github.io/openai-agents-python/handoffs | 官方文档 | 检索摘要 |
| 29 | https://den.dev/blog/mcp-november-authorization-spec | 二手 | 检索摘要 |
