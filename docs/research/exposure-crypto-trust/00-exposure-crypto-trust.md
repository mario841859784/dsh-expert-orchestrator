# 对外暴露面 + 密码学信任研究：A2A HTTP、MCP 写面鉴权与 Ed25519 签名为什么是同一道题

> 研究专题：dsh-expert-orchestrator 中期方向「对外暴露面 + 密码学信任」——统一收编三个遗留项：①A2A HTTP transport、②MCP 写面鉴权升级、③Ed25519 签名/验签（方向 4 身份三层中的密码学层）。
> 调研性质：纯外部文献调研（web only），未改动任何实现。日期：2026-11-12。前作：[协议对接调研](../protocol-interop-mcp-a2a/00-protocol-interop.md)、[身份信任调研](../agent-identity-trust/00-identity-trust.md)。
> 证据强度标注：**[一手规范]** = 规范正文逐字核实；**[产品宣称]** = 官方文档/README 宣称；**[博客主张]** = 第三方文章/教程；**[二手未核]** = 搜索摘要层面核实、未抓正文。

---

## 0. 结论速览

1. 三个遗留项共享同一根因：**权限跨边界流动，身份不随行**。A2A 规范自己就说破了这个形状：「Identity information is not transmitted within A2A JSON-RPC payloads; it is handled at the HTTP transport layer」——身份永远落在传输层/带外，而权限（写板、派工、批准）走协议载荷（§1）。
2. **顺序铁律：鉴权先于暴露**。MCP 2025-06-18 对 HTTP 传输的三条安全要求（Origin 校验 MUST / 本地绑 127.0.0.1 SHOULD / 认证 SHOULD）是做 HTTP 暴露的最低配，且规范明言 stdio 传输「SHOULD NOT follow this specification, and instead retrieve credentials from the environment」——即鉴权体系只在升级到 HTTP 的那一刻才有意义，stdio 不欠这套账（§2.2、§3.1）。
3. A2A 最小服务端与已发布的 MCP stdio 服务是**同构的翻译层**：官方示例（a2a-samples helloworld、AWS/Azure/Google 托管面）全走官方 SDK，但协议面本质是「POST 一个 JSON-RPC、回一个 task 对象」+ 一张 well-known 卡片——对本插件意味着复用 `mcp_taskboard.py`「子进程调用 taskboard.py」骨架即可，无需 SDK（§2.2/§2.3）。
4. **MCP 写面鉴权的正解是 OAuth 2.1 资源服务器全套**（RFC 9728 元数据 + RFC 8707 受众绑定 + token 透传禁令），没有便宜版：受众不校验 = token 跨服务盗用边界崩塌（规范原文点破，§3.2）。本地场景的替代不是砍掉鉴权，而是换信任载体：unix-socket + OS 级 peer 凭证（PostgreSQL peer auth 是生产先例），或 mTLS 前置（§3.4）。
5. Agent Kanban 证明 Ed25519 落板面可行（每会话密钥对 + 自签 JWT + 服务端验签），但其证据仅 README 层，且上游 README 已演进到另一套措辞（Enbor Session/resource-token）——**README-only 证据，方案照抄前先读码**（§4.1）。文件板等价物 = 事件行带签名 + 折叠/重放时验签，签名只买到「密钥持有归因」，买不到「人」与「批准权」（§4.2/§4.5）。
6. 打包路线：**近期**卡面安全声明 + 写面审计回显（近零成本）；**中期**A2A 最小 HTTP（轮询、无流式）与 unix-socket 写面二选一先行；**签名**只在前两者落稳且出现跨板/跨机需求后立项，且必须与密钥分发、吊销故事捆绑交付（§5）。

---

## 1. 统一问题定义：权限过界，身份不过界

**已发布的暴露面现状**（据 `CHANGELOG.md`、`skills/expert-orchestration/SKILL.md`、`scripts/gen-agent-card.mjs`）：MCP stdio 服务零依赖纯 python3，读面默认开放 7 工具、写面 `DSH_TASKBOARD_MCP_WRITES=1` 才暴露 create/claim/progress/done/fail，关闭时具名拒 `writes_disabled`；信任边界如实声明「stdio=与 CLI 同信任级别……本服务不新增执法面只做协议转换与写面开关」「身份经工具参数自报（owner/--by）」；`gen-agent-card.mjs` card-first 落盘，**url 缺省空占位（卡只描述能力，不宣称已有 A2A transport 端点）**，capabilities 声明 streaming/pushNotifications=false。三个遗留项就是这条暴露线上的三段欠账：

| # | 遗留项 | 边界穿越 | 身份现状 | 缺口 |
|---|--------|---------|---------|------|
| ① | A2A HTTP transport | 卡片 → 网络端点：权限面从「同工作区 CLI」扩到「任意网络客户端」 | AgentCard 自描述 + HTTP 层带外凭证（规范：身份不在 A2A 载荷内，[v0.3.0 规范](https://a2a-protocol.org/v0.3.0/specification/)）**[一手规范]** | 卡上没有 securitySchemes 声明；没有端点；谁拿到 URL 谁就能 POST |
| ② | MCP 写面鉴权 | stdio 同特权子进程 → Streamable HTTP 多客户端端点：写工具从 env 开关变成网络可调 | stdio 无鉴权（规范预期：凭据从环境取）+ 调用参数自报 | HTTP 化后 env 开关不再是边界，需要 OAuth 2.1 RS 或本地替代载体 |
| ③ | Ed25519 签名/验签 | 板面事件的身份字段自报 → 密码学归因 | `--by` 落款、owner、capability token `at-<16hex>` 全部是**可被任何能写板文件者伪造的自报** | 签名把「防误用不防伪造」升级为「板外可验证不可否认」，前置是密钥分发 |

**共享威胁模型**（对「把板 CRUD 暴露给外部代理」的插件统一适用）：

- **T1 伪造署名**：外部进程对板文件写事件并落任意 `--by`/owner——现有审计面照单全收（自报口径，SKILL.md 明示「防误用不防伪造」）。暴露面越宽，伪造者越不需要本地文件权限：经 A2A/MCP 写工具注入即可。
- **T2 能力令牌窃取**：`at-<16hex>` token 以明文抄录在任务书文本里随板流传——拿到文本的任何一方即拿到代际权限。防误猜不防持有后的复制。
- **T3 外部写直入**：MCP 写工具语义是「代理转达的板面变更」（SKILL.md 口径）——外部客户端背后是 LLM，转达批准不可信规则已写成协议文本，但**写工具本身没有认证边界**，只有 env 开关。
- **T4 发现面欺骗**：AgentCard 是给 LLM 读的清单——官方 samples 明文警告「All data received from an external agent... should be handled as untrusted input」，未消毒的卡字段进 prompt 即注入面（[a2a-samples](https://github.com/a2aproject/a2a-samples)）**[产品宣称]**。
- **T5 中继洗批准**：已被 SKILL.md §2 成文封死（「代理转达的批准一律不可信」）——注意签名**不**增强这条：签名只能证明「某会话签发了某声明」，不能证明「声明的内容为真」。

三个遗留项的统一解法形状相同：**在每个边界上给「权限载体」配一个「身份载体」，并让两者的生命周期绑定**——①卡+凭证、②token+受众、③事件+签名密钥。这正对应前作身份三层（自报/绑定/密码学）的爬升。

---

## 2. A2A HTTP transport 精读

### 2.1 协议面：message/send、tasks 与执行模式（[v1.0 规范](https://a2a-protocol.org/latest/specification/)）**[一手规范]**

- **message/send（SendMessage）**：请求 = message（必填）+ configuration + metadata；**默认阻塞**——「The operation MUST wait until the task reaches a terminal state ... or an interrupted state ... before returning」；`returnImmediately: true` 时「MUST return immediately after creating the task」。响应是 task 对象**或**直答 message。流式版 message/stream 建 SSE，终态必关流。
- **任务操作族**：`tasks/get`（TaskNotFoundError）、`tasks/cancel`（幂等，TaskNotCancelableError）、`tasks/list`（分页游标）、`tasks/resubscribe`（首事件回当前状态）。
- **执行/交付模式三通道**：阻塞/非阻塞（returnImmediately）、流式（capabilities.streaming）、push webhook（capabilities.pushNotifications，false 时相关操作「MUST return PushNotificationNotSupportedError」）。push = 服务端向配置 URL 发 HTTP POST（`application/a2a+json`），「MUST attempt delivery at least once」，客户端「MUST respond with HTTP 2xx」且「MUST validate the task ID matches an expected task」——push 校验义务在客户端，默认应视为不可信输入。
- **任务状态机**：working（活动）｜completed/failed/canceled/rejected（终态）｜input_required/auth_required（中断）。与本插件 attempt 代际状态同构性已在协议对接前作对照过（§3.2）。
- **版本协商**：客户端「MUST send the A2A-Version header with each request」，空头按 0.3 解释；v1.0 已注册 IANA（`A2A-Version`/`A2A-Extensions` 头 + `application/a2a+json` 媒体类型）。

### 2.2 AgentCard 的 url 绑定与安全声明（[v0.3.0 规范](https://a2a-protocol.org/v0.3.0/specification/)）**[一手规范]**

- **url 绑定传输**：url 是「The preferred endpoint URL for interacting with the agent」，且「The URL MUST support the transport specified by 'preferredTransport'」「The preferredTransport field is REQUIRED and MUST be present in every AgentCard」；`additionalInterfaces` 列额外 (transport, url) 组合，「The same URL MUST NOT declare conflicting transport protocols」。**含义：卡上的 url 一旦非空就是「此端点可用此传输」的可核查承诺**——本插件 url 空占位是正确的不撒谎形态。
- v1.0 改组为 `supportedInterfaces`（「Ordered list of supported interfaces. The first entry is preferred」）+ AgentInterface 对象；卡片发现路径 `/.well-known/agent-card.json`（RFC 8615）。
- **securitySchemes/securityRequirements**：基于 OpenAPI 3.0 的五族 scheme（APIKey/HTTPAuth/OAuth2/OpenIdConnect/MutualTLS）；`security` 列表「can be seen as an OR of ANDs」，可下钻到 per-skill。**声明式而非执行式**：「The client obtains the necessary credentials (e.g., API keys, OAuth tokens, JWTs) through an out-of-band process」——凭证获取明确在 A2A 协议范围之外；「It is generally NOT RECOMMENDED to include plaintext secrets (like static API keys) directly in an Agent Card」。
- v1.0 卡自带 `signatures`（「JSON Web Signatures computed for this AgentCard」）——发现文档本身可签名，是 §4 密钥分发的免费载体。

### 2.3 最小 A2A 服务端（无框架）与本插件的形状

- 官方路径全走 SDK：[a2a-samples](https://github.com/a2aproject/a2a-samples) helloworld（Python/Go/dotnet/Java/JS 五语言，server=「跑 `python __main__.py`」、client=test_client.py；README 已核实，**源码文件未逐行核实**）**[产品宣称]**；托管面生产示例三连：[AWS AgentCore Runtime（自动供端点）](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html)、[Azure AI Foundry（A2A 工具接入）](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/agent-to-agent)、[Google Cloud Run 部署 A2A](https://docs.cloud.google.com/run/docs/deploy-a2a-agents) **[产品宣称·二手未核]**。
- 无框架路径的形状（多篇二手教程一致，如 [SAP Community 逐原理文](https://community.sap.com/t5/artificial-intelligence-blogs-posts/agent-to-agent-protocol-a2a-from-first-principles-to-production/ba-p/14456797)、[Medium from-scratch 文](https://medium.com/@Micheal-Lanham/a2a-from-scratch-build-a-multi-agent-system-in-under-100-lines-of-core-logic-a3b903d60511)）**[博客主张·二手未核]**：`POST /` 收 `{"jsonrpc":"2.0","id":…,"method":"message/send","params":{…}}`，回一个 task 对象（id 服务端生成）；`GET /.well-known/agent-card.json` 发卡。对本插件 = `mcp_taskboard.py` 的 HTTP 版：ThreadingHTTPServer（python 标准库）或 node `http` 模块单文件，POST 处理器翻译到 taskboard.py 子进程，**MVP 只实现 message/send（同步阻塞）+ tasks/get（轮询）**，卡上 capabilities.streaming/pushNotifications 照实 false——流式与 push 是纯增量，不阻塞 MVP。

---

## 3. MCP 写面鉴权精读

### 3.1 stdio 为什么明确出圈（[authorization 规范 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)）**[一手规范]**

- 范围原文：「Authorization is **OPTIONAL** for MCP implementations. When supported: Implementations using an HTTP-based transport **SHOULD** conform to this specification. **Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment.**」——stdio 的身份模型就是「环境即信任边界」：能拉起进程者即被信任，本插件「stdio=与 CLI 同信任级别」声明与规范完全同口径。
- **资源服务器角色**：「A protected *MCP server* acts as an OAuth 2.1 resource server」；MCP server「MUST implement OAuth 2.0 Protected Resource Metadata (RFC9728)」，元数据文档「MUST include the `authorization_servers` field containing at least one authorization server」；401 响应「MUST use the HTTP header `WWW-Authenticate`」指向资源元数据——客户端发现链：401 → `/.well-known/oauth-protected-resource` → AS 元数据（RFC 8414）→ PKCE + `resource` 参数拿 token。

### 3.2 RFC 8707 受众绑定与 token 透传禁令：没有便宜版

- 客户端侧：「MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in [RFC 8707]」——授权与 token 请求都必须带 `resource` 参数，「MUST identify the MCP server that the client intends to use the token with」（canonical URI）。
- 服务端侧：「MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience」；「MCP servers **MUST NOT** accept or transit any other tokens」；「The MCP server **MUST NOT** pass through the token it received from the MCP client」。
- 不做受众绑定的代价（规范 Security Considerations 原文）：「When an MCP server doesn't verify that tokens were specifically intended for it (for example, via the audience claim, as mentioned in [RFC 9068]), it may accept tokens originally issued for other services. This breaks a fundamental OAuth security boundary」。**对本地工具服务器的具体含义**：同机多个 localhost MCP/HTTP 服务各自发/收 token 时，不校验 aud = A 服务签的 token 在 B 服务通用——std→HTTP 升级时的第一坑（迁移经验佐证：[GMI Cloud 本地 vs 远程对比](https://www.gmicloud.ai/en/blog/remote-vs-local-mcp-servers-authentication-deployment-and-which-to-choose)「a stdio server inherits local permissions and needs no client-to-server authentication at all」）**[博客主张·二手未核]**。

### 3.3 stdio → Streamable HTTP 升级清单（[transports 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)）**[一手规范]**

- 传输面：单一 MCP endpoint（POST + GET）；POST 每消息一请求，Accept 同时列 `application/json` 与 `text/event-stream`；GET 开服务端 SSE 流；`Mcp-Session-Id` 会话（无会话头 → 400）、`Last-Event-ID` 断线续传、`MCP-Protocol-Version` 头（缺省兜底 2025-03-26）。stdio 客户端「SHOULD support stdio whenever possible」——HTTP 是可选升级不是替代。
- **Security Warning 三条（升级的最低配，引用逐字）**：「Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks」「When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)」「Servers **SHOULD** implement proper authentication for all connections」；「Without these protections, attackers could use DNS rebinding to interact with local MCP servers from remote websites」——**即：任何 HTTP 化，哪怕只绑 127.0.0.1，Origin 校验是 MUST、认证是 SHOULD 不可省略叙事**。
- 桥接捷径与代价：[sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) 可把 stdio server 套成 HTTP/SSE 端口 **[博客主张·二手未核]**——但鉴权仍在代理层补，不解决 §3.2。

### 3.4 本地替代：unix-socket peer 凭证与 mTLS

- **unix-socket + peer 凭证**：内核在 `connect()` 时刻记录对端 (pid, uid, gid)，Linux `SO_PEERCRED`、BSD/macOS `getpeereid()`，连接方无法伪造（[unix(7) man](https://man7.org/linux/man-pages/man7/unix.7.html)、[cr.yp.to secureipc](https://cr.yp.to/docs/secureipc.html)、[SO 伪造性讨论](https://stackoverflow.com/questions/15974356/unix-sockets-is-it-possible-to-spoof-getsockopt-so-peercred)——root 可伪造的边界存在）**[二手未核]**。生产先例 PostgreSQL peer auth：「Peer authentication, which relies on operating system facilities to identify the process at the other end of a local connection. **This is not supported for remote connections.**」「usually recommendable for local connections」（[PG 文档](https://www.postgresql.org/docs/current/auth-methods.html)）**[产品宣称]**。对本插件：unix-socket 把「同 OS 用户」变成写面准入——比 env 开关强一档（进程存在性 → 进程身份），仍是同信任级的**收窄**而非新信任模型。
- **诚实边界**：unix-socket 不在 MCP 两标准传输内，属于 custom transports——「Clients and servers MAY implement additional custom transport mechanisms ... **MUST** ensure they preserve the JSON-RPC message format and lifecycle requirements defined by MCP」（[transports 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)）**[一手规范]**——可行但要如实标注非标。
- **mTLS 本地前置**：A2A 的 MutualTLSSecurityScheme 给了声明形状（§2.2）；MCP auth 规范对替代传输只说「MUST follow established security best practices for their protocol」——即 mTLS 是部署层（反向代理前置）而非 MCP 规范面内建，选它 = 把信任锚从 OAuth AS 换成证书签发方。

---

## 4. Ed25519 签名面设计精读

### 4.1 先例：Agent Kanban 每会话密钥对 + 自签 JWT（[npm vtit-agent-kanban](https://www.npmjs.com/package/vtit-agent-kanban) v1.5.2）**[产品宣称·README-only]**

- 「Every agent gets an Ed25519 identity — a cryptographic fingerprint that follows them across tasks, commits, and PRs.」「Ed25519 keypair — generated per agent session」「Fingerprint — derived from the public key」。
- 认证：「JWT auth — agents sign their own tokens, verified server-side」；角色信任表：Human（user session：查看/聊天/拒完/管理）｜Leader Agent（Ed25519 JWT：建/派/拒/完/取消/管理）｜Worker Agent（Ed25519 JWT：认领/建子任务/记进度/提交评审）｜Daemon（API key：轮询/拉起会话/合并自动完单）。「Leader identity — created explicitly once per runtime, then reused across sessions」。
- **证据强度警示**：全部为 README 宣称，未获源码级核实；本次抓取 [上游 saltbo/agent-kanban](https://github.com/saltbo/agent-kanban) README 已演进到另一套措辞（「Enbor Session」「Browser OIDC and Agent resource-token authority」）——项目迭代中，**照抄其方案前须读码**；FSL-1.1-ALv2 许可，两年转 Apache-2.0。

### 4.2 文件板签名的设计形状：事件行带签名，折叠/重放时验签

- 现板事实源是追加式事件流（flock+CAS 串行；`open-counts` 等只读面 =「事件流某完整前缀的折叠」，SKILL.md 既有口径）。签名等价物：每条事件追加 `sig` 字段，签名覆盖规范化 `(type, task, seq, args)`；**验签点放在折叠/重放**——读取聚合（open-counts/budget 计数/recover）时逐条验，无效条目**标记不静默**（沿 bus 读侧「格式不符报错移除」与「损坏如实回落不静默当空卡」的既有口径）。seq/前向哈希链给防篡改，签名给归因——两者叠加才完整。
- 与 attempt 代际的互动：签名绑定的是**代际**而非终身——claim 翻新代际时新 attempt 由当值会话签，与 T7「证明与自报混用即拒」语义同构，只是证明从「持有 token」升级为「持钥」。
- 成本预估：纯 python 验签慢但**事件量小**（每任务个位数事件/日），折叠时全量验签在文件板规模下可接受（§4.4 的性能量级支持此判断）。

### 4.3 密钥分发：三个候选载体（缺一即不做签名）

1. **预共享目录**：`~/.dsh/keys/<agent>.pub`（公钥层）+ 会话密钥不落盘仅 env/内存——沿用 experts 目录既有 symlink 守卫先例（SKILL.md：「experts 目录本身为符号链接 → 按空层处理并 stderr 告警」）；目录即信任根，谁写目录谁定义身份。
2. **env 注入**：与 `DSH_TASKBOARD_MCP_*` 同通道——规范侧背书「retrieve credentials from the environment」（§3.1）；含义：env 配置者 = 密钥信任根，与「stdio 环境即边界」一致。
3. **公钥随卡发布**：A2A v1.0 AgentCard `signatures` 字段（JWS 签卡）**[一手规范]**——卡片已由 `gen-agent-card.mjs` 从 roster 派生，公钥公告面免费获得；但**验卡方须先信任卡面**（well-known 路径无内置信任锚），适合跨机二期。
- 吊销：SSH KRL 模式——`RevokedKeys` 文件 + `ssh-keygen -k` 生成（[sshd_config man](https://man7.org/linux/man-pages/man5/sshd_config.5.html) 检索、[golinuxcloud 教程](https://www.golinuxcloud.com/openssh-key-revocation-krl)）**[二手未核]**；注意其 fail-closed 特性（revocation 文件缺失/空则 sshd 直接停用 key 认证，[Rundeck 文档](https://docs.rundeck.com/docs/learning/howto/revoke-ssh-keys.html)）**[产品宣称]**——板面版应显式选语义：板根 `revoked-keys` 文件，验签时查，空文件=吊销空集（不学 SSH 的停用全体）。每会话密钥对天然短命（Agent Kanban 形态），吊销压力主要在 leader 类长命身份。

### 4.4 最小实现库：零依赖 vs 绑定原生

| 路线 | 入口 | 代价 | 对本插件 |
|------|------|------|---------|
| python `cryptography` | `Ed25519PrivateKey.generate()`，32 字节私钥，`sign/verify`（[官方文档](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/ed25519/)）**[产品宣称]** | 引入原生依赖，破坏「零依赖纯 python3」约束 | 适合 CLI 侧 opt-in，不适合随 MCP 服务默认带 |
| node `crypto` | `crypto.generateKeyPair('ed25519')` + `crypto.sign(null, data, priv)`（Ed25519 无需哈希参数，[SO:79341019](https://stackoverflow.com/questions/79341019/how-do-i-use-crypto-createsign-with-ed25519-key)）**[二手未核]** | 零安装（node 自带） | 与 gen-agent-card.mjs（.mjs）同生态，卡片/签名工具可同栈 |
| 纯 python vendored | [jedisct1/ed25519.py](https://github.com/jedisct1/ed25519.py)（仅依赖 hashlib）「no external cryptographic dependencies」；[pyca/ed25519](https://github.com/pyca/ed25519) 为参考实现的优化版；参考实现量级慢（量级千倍于 C，属正确性参考码）**[二手未核]** | 慢；需自带且自担审计 | mcp_taskboard.py 保持零依赖的唯一签名路径；事件量小可容忍 |
- 跨语言互操作：RFC 8032 标准 Ed25519——node 原始 32 字节密钥 ↔ python `from_private_bytes/from_public_bytes` 可直接互验（[node crypto 文档](https://nodejs.org/api/crypto.html) 与 cryptography.io 文档均实现标准格式）**[产品宣称]**——签名不必绑定单一实现栈。

### 4.5 签名买到什么、买不到什么

- **买到**：事件 → 密钥持有者的不可抵赖绑定，任何持公钥的第三方板外可验；跨板/跨机携带信任成为可能（自报口径做不到）；与 T2 对抗升级——token 从「可复制的明文」升级为「须持钥使用的签名物」。
- **买不到**：①**人**——密钥↔代理会话的映射本身是一个目录声明，签名证明「某密钥签的」，不证明「某用户批的」；②**批准权**——签名后的「用户已批」转述仍是转述（T5 靠协议文本不靠密码学）；③**活体安全**——会话密钥被盗 = 盗用者签得出来，直到吊销生效；④**真源防改**——能直写板文件者可整段重写事件流，签名链的完整性前提是「写入通道唯一且可验证」（这正是 fold/重放验签存在的意义）。对应前作身份三层：签名是把**自报层**升到**密码学层**，但**绑定层**（密钥生命周期、分发、吊销）不做完，密码学层就是伪安全。

---

## 5. 设计提炼（10 条，分近期/中期/远期）

**近期（近零成本，不动信任模型）**

1. **卡面安全声明先于卡面端点**：gen-agent-card 补 `securitySchemes`/`securityRequirements` 字段——哪怕声明为「bearer + out-of-band」，让卡在「有端点」之前就如实声明「接入需要什么」；url 维持空占位不动（url 非空 = 端点可核查承诺，§2.2）。前置：无。不做边界：不在卡上写任何未部署的传输端点。
2. **写面审计回显**：MCP 写工具响应回显 `(owner, --by, 事件 seq)`，让外部调用方可对账事件流——把「代理转达变更」的审计口径变成可机读对账面。前置：无（事件流已有）。不做边界：不为 stdio 添加伪鉴权（env 即边界的口径不变）。
3. **签名不立项**：密钥分发故事（§4.3）未答之前不做——签名没有分发方案 = 自签自验 = 归因回到自报层，白付复杂度。

**中期（首个真交付切片，二选一先行）**

4. **A2A 最小 HTTP 服务端**：单文件无框架翻译层（python 标准库或 node http），MVP = message/send 同步 + tasks/get 轮询，卡上 streaming/push 照实 false；**前置**：§5.6 的鉴权载体先落（至少 bearer + 本地 bind + Origin 校验）；**不做边界**：不做无鉴权 HTTP 面——哪怕「本地演示」也不裸奔（§3.3 三条最低配）；不实现 push webhook（push 校验义务在客户端，MVP 无收益）。
5. **MCP 写面 HTTP 化走规范全套**：升级到 Streamable HTTP 时按 OAuth 2.1 RS 交付（9728 PRM + WWW-Authenticate + 8707 受众校验 + 透传禁令），不做「先裸 HTTP 后补 token」的中间态；受众校验从第一天起是 MUST（§3.2）。前置：一个可信授权服务器（哪怕单用户 AS）。不做边界：不签发/接受 aud 不符 token。
6. **本地替代首选 unix-socket + peer 凭证**：若跨机需求未出现，写面升级路径选 unix-socket + `SO_PEERCRED`/`getpeereid`（同 OS 用户准入）而非 OAuth——信任锚从「env 配置者」收窄到「OS 用户」，零新组件；custom transport 身份如实标注。前置：无。不做边界：不宣称 unix-socket MCP 是标准传输。
7. **事件签名最小增量（与 4.3 捆绑交付）**：写入路径事件追加 `sig` 行 + 折叠/重放验签（读侧一处）+ 板根 `revoked-keys` 吊销文件；密钥分发 = 预共享目录 + env 注入双通道起步。前置：§4.3 密钥分发 + 吊销语义。不做边界：不用签名做权限执法（deny 列表执法归属不变）；不签名「批准」语义本身。
8. **capability token 的签名化是远期而非中期**：`at-<16hex>` → 签名 JWT（AgentCap 六元组形态）依赖 §5.7 的密钥面——令牌升级是签名面的消费者，不是前置。前置：§5.7。不做边界：不双轨（同代际两种 token 形态并存）。

**远期（触发条件驱动）**

9. **跨机/跨板协作触发 mTLS 或完整 OAuth**：多机部署时本地载体失效（peer 凭证「not supported for remote connections」），信任锚升级到证书签发方或 AS；公钥公告走 AgentCard signatures（§4.3 选项 3）。前置：真实跨机需求 + §5.7。不做边界：不为假想的多机场景预建 AS。
10. **验证面独立性是验收标准**：任何签名交付须带一个「板外验证器」（独立进程只持公钥验整板）——签名不能只被写入方自己验证，否则与自报同层。前置：§5.7。不做边界：验收器不进信任面（它无写权限）。

**打包路线表**

| 阶段 | 交付 | 前置 | 不做边界 |
|------|------|------|---------|
| N1 | 卡面 securitySchemes/securityRequirements 如实声明 | 无 | 不写未部署端点 |
| N2 | MCP 写面响应回显审计字段 | 无 | stdio 不加伪鉴权 |
| M1 | unix-socket 写面（peer 凭证准入）或 A2A 最小 HTTP（bearer + Origin + 127.0.0.1） | M1 二选一先行，不同时铺 | HTTP 不裸奔；unix-socket 不冒充标准传输 |
| M2 | Streamable HTTP + OAuth 2.1 RS 全套（9728/8707/透传禁令） | 可信 AS | 不做先裸后补的中间态 |
| M3 | 事件签名 + 折叠验签 + revoked-keys + 板外验证器 | 密钥分发双通道 + 吊销语义 | 签名不做执法；不签批准语义 |
| L1 | 签名能力令牌（JWT 化 at-token）/ mTLS·完整 OAuth / 卡签名公告 | M3 + 真实跨机需求 | 不预建假想场景 |

---

## 6. 与本插件现状对照

**已发布暴露面/信任面**（据 `skills/expert-orchestration/SKILL.md`、`skills/expert-orchestration/tools/mcp_taskboard.py`、`scripts/gen-agent-card.mjs`、`CHANGELOG.md`）：

| 已有机制 | 信任层级 | 与三个遗留项的接口 |
|---------|---------|------------------|
| MCP stdio 服务（7 读工具开放/5 写工具 env 门） | stdio=CLI 同信任级（如实声明） | 遗留②的直接基底：翻译层骨架现成，HTTP 化只换壳不换芯 |
| gen-agent-card.mjs（url 空占位、capabilities false、dsh:rosterSource 标注） | card-first 不撒谎 | 遗留①的基底：补 securitySchemes（近期）与端点（中期）都在此文件 |
| approve/reject `--by` 自报审计 + 转述批准不可信协议文本 | 自报 + 协议契约 | 遗留③的对象：`--by` 是签名字段的占位符，签名后从「可伪造落款」升级为「可验签归因」 |
| peer-reassign `at-<16hex>` 工具生成 token + attempt_source_conflict 拒混用 | 绑定（工具生成不可猜） | 遗留③的第二消费者：token JWT 化的前提是密钥面 |
| origin-chain（任务书末行 (专家名, cwd) 链、重复对即拒） | 绑定（拓扑溯源） | 签名的第三落点：链上每跳可签——但这是增强不是前置 |
| attempt 绑 owner / m-vote 落款即身份 / 仲裁面「伪造板=直改主板同信任级」非目标 | 自报 + 绑定 | 签名不改这些非目标——直写板文件的对抗者仍需真源完整性方案（§4.5④） |

**三个遗留项各自在现状之上加什么**：①A2A HTTP = 「卡」升级为「可连线节点」——外部协调者从「知道有哪些专家」到「能直接派消息」；权限面首次出进程边界。②写面鉴权 = env 开关升级为真执法面——从「开关存在」到「边界可验证」。③签名 = 归因从「防误用」到「不可否认」——板外第三方第一次能独立验证「谁写的」。

**签名闭合 vs 不闭合的信任链缺口**：闭合——外部进程伪造 `--by` 落款（T1 的板外部分）、事后抵赖（事件归因可独立验证）、token 明文复制（升级为持钥使用）。不闭合——用户↔代理的映射（密钥目录仍是声明）、批准权合法性（协议文本职责）、活体密钥被盗（吊销时窗）、整板重写（须配合写入通道唯一性）。这与前作身份信任调研的 GAP 排序一致：协议文本规则（已落）→ `--by` 审计（已落）→ 绑定/签名（本报告方向）。

---

## 7. 出处清单

| # | 来源 | 用途 | 访问状态（2026-11-12） |
|---|------|------|------------------------|
| 1 | [A2A v1.0 规范](https://a2a-protocol.org/latest/specification/) | §2.1 message/send/tasks/执行模式/push/版本头/IANA | 已核实（正文抓取，引文逐字；页尾部分截断） |
| 2 | [A2A v0.3.0 规范](https://a2a-protocol.org/v0.3.0/specification/) | §2.2 url 绑定/preferredTransport/securitySchemes/带外凭证 | 已核实（正文抓取，引文逐字；§8+ 截断） |
| 3 | [A2A agent discovery 主题页](https://a2a-protocol.org/latest/topics/agent-discovery/) | §2.2 well-known 路径/卡安全 | 已核实（正文抓取，覆盖有限） |
| 4 | [MCP Authorization 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | §3.1/§3.2 stdio 出圈/RS 角色/9728/8707/透传禁令/受众校验 | 已核实（正文抓取，引文逐字） |
| 5 | [MCP Transports 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | §3.3 Streamable HTTP 机制/安全三条/custom transports | 已核实（正文抓取，引文逐字） |
| 6 | [MCP Security Best Practices 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) | §3.2 token passthrough 背景 | 前作同日已核实（本报告转引） |
| 7 | [npm vtit-agent-kanban](https://www.npmjs.com/package/vtit-agent-kanban) | §4.1 Ed25519 每会话密钥/自签 JWT/角色表/leader 一次性身份 | 已核实（页面抓取，引文逐字） |
| 8 | [saltbo/agent-kanban 上游](https://github.com/saltbo/agent-kanban) | §4.1 证据警示（README 已演进/Enbor Session 措辞） | 已核实（README 抓取，与 npm 页不一致如实记录） |
| 9 | [a2aproject/a2a-samples](https://github.com/a2aproject/a2a-samples) | §2.3 官方示例形态/不可信输入警告 | 已核实（README 抓取；示例源码未逐行核实） |
| 10 | [AWS AgentCore A2A 部署](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html)、[Azure Foundry A2A](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/agent-to-agent)、[Cloud Run A2A](https://docs.cloud.google.com/run/docs/deploy-a2a-agents) | §2.3 托管生产示例 | 搜索结果核实（未抓正文） |
| 11 | [SAP Community A2A 原理文](https://community.sap.com/t5/artificial-intelligence-blogs-posts/agent-to-agent-protocol-a2a-from-first-principles-to-production/ba-p/14456797)、[Medium from-scratch](https://medium.com/@Micheal-Lanham/a2a-from-scratch-build-a-multi-agent-system-in-under-100-lines-of-core-logic-a3b903d60511) | §2.3 无框架最小服务端形状 | 二手未核（搜索摘要核实） |
| 12 | [PostgreSQL 认证方法文档](https://www.postgresql.org/docs/current/auth-methods.html) | §3.4 peer auth 限定本地连接 | 已核实（正文抓取，摘要句；§20.6 专页未抓） |
| 13 | [unix(7) man](https://man7.org/linux/man-pages/man7/unix.7.html)、[cr.yp.to secureipc](https://cr.yp.to/docs/secureipc.html)、[SO SO_PEERCRED 伪造性](https://stackoverflow.com/questions/15974356/unix-sockets-is-it-possible-to-spoof-getsockopt-so-peercred) | §3.4 SO_PEERCRED/getpeereid 形态 | 搜索结果核实（未抓正文） |
| 14 | [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)、[GMI Cloud 本地 vs 远程](https://www.gmicloud.ai/en/blog/remote-vs-local-mcp-servers-authentication-deployment-and-which-to-choose)、[TrueFoundry stdio vs HTTP](https://www.truefoundry.com/blog/mcp-stdio-vs-streamable-http-enterprise) | §3.3/§3.2 升级路径与本地特权继承 | 搜索结果核实（未抓正文） |
| 15 | [cryptography Ed25519 文档](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/ed25519/)、[node:crypto 文档](https://nodejs.org/api/crypto.html)、[SO:79341019 Ed25519 sign](https://stackoverflow.com/questions/79341019/how-do-i-use-crypto-createsign-with-ed25519-key) | §4.4 最小库入口/互操作 | 官方文档搜索核实（未抓正文）/二手未核 |
| 16 | [jedisct1/ed25519.py](https://github.com/jedisct1/ed25519.py)、[pyca/ed25519](https://github.com/pyca/ed25519)、[PyMySQL #786（参考实现出处）](https://github.com/PyMySQL/PyMySQL/issues/786) | §4.4 纯 python 零依赖路线与性能量级 | 搜索结果核实（未抓正文） |
| 17 | [sshd_config man（RevokedKeys）](https://man7.org/linux/man-pages/man5/sshd_config.5.html)、[golinuxcloud KRL 教程](https://www.golinuxcloud.com/openssh-key-revocation-krl)、[Rundeck 吊销 fail-closed 注记](https://docs.rundeck.com/docs/learning/howto/revoke-ssh-keys.html) | §4.3 吊销模式与空文件语义 | 搜索结果核实（未抓正文） |
| 18 | [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)、[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)、[RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html)、[OAuth 2.1 draft-13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) | §3.2 底层规范 | 经 MCP 规范转引（未直接抓取原文） |

**遗留问题**：①A2A v1.0 规范页尾（§8 传输绑定细节、AgentInterface 完整定义）截断未核，落地前需补读；②Agent Kanban 签名实现仅 README 层，且上游措辞已换代——真要做须读其 FSL 源码或等两年转 Apache-2.0；③RFC 9728/8707 原文细节经 MCP 规范转引，写 PRM/audience 校验代码前应直读 RFC；④纯 python ed25519 的实测性能数字未自测（引用量级描述）；⑤mcp-proxy 桥接的安全边界（代理层鉴权）未逐行核实。
