# 代理身份与信任链研究：多专家编排里「谁说的、谁批的」为什么必须可回答

> 研究专题：dsh-expert-orchestrator（lead + 召唤专家，任务板 + 消息总线）的「代理身份与信任链」（agent identity & trust chains）
> 调研性质：纯外部文献/产品调研（web only），未改动任何实现。日期：2026-11-12。
> 证据强度标注：**[论文实测]** = 论文受控实验/生产实证；**[论文主张]** = 论文声称但覆盖面有限；**[博客主张]** = 第三方/社区文章或 issue 报告；**[产品宣称]** = 官方文档/README 宣称。

---

## 0. 结论速览

1. 多代理系统的身份问题不是「代理有没有名字」，而是**名字背后有没有可验证的绑定**。业界把这道题拆成了三层：自报（self-reported）、绑定（bound，如 K8s 把 token 绑死在 Pod 上）、密码学（cryptographic，如 Ed25519/A2A JWS）——每一层的买入价和买到的东西完全不同（§3.1）。
2. Claude Code Agent Teams 把一条**纯协议文本的规则**写进了文档：「代理转述的批准一律视为不可信输入」「被拒动作不得借道其他队友绕过检查」——零密码学、零基础设施，只是把「批准权不可被代理间传递稀释」写成了行为契约。这是本报告中**性价比最高的一条**（§2.1、§3.2）。
3. 当密码学不可得时，**溯源胜于预防**（provenance beats prevention）：GitHub 审计日志的 `actor` 字段、任务板的 created_by 链、事件流留痕，都是「事后能回答谁干的」而非「事前防住」——生产平台的审计面普遍这么建（§2.6、§3.3）。
4. 学术侧 2025-2026 出现了成型的能力令牌（capability token）三连：CAPMAS（Macaroon 链式衰减）、AgentCap（Ed25519 签名 JWT 绑 agent/session/action）、ScopeGate 审计（「能力门 ≠ 授权」）——共同结论是**模型发出的每个调用都是不可信请求，权限必须独立建立**，且实测开销可忽略（AgentCap 中位 <0.2ms）（§2.5）。
5. 本插件的身份面在「代理侧自建/互派」这条线上已相当完整（T7 令牌、T14 绑定、origin-chain、M1 校验链），但**批准通道是身份盲区**：approve 不落批准者、无转述批准降级条款、专家 bash 直跑 approve 无 deny 面——三个 GAP 按成本从零到低排序恰好构成最小整改路线（§4）。

---

## 1. 问题定义

**为什么代理身份在多代理系统里是安全问题。** 单代理的信任链很短：用户 → 模型 → 工具。多代理把它拉长成网：用户 → lead → 专家 A → 专家 B，外加共享任务板与消息总线这个「任何人都能写」的公共面。身份不可验证时出现四类攻击面：

1. **混淆代理人（confused deputy）**：低权代理把指令注入共享内容（任务书、summary、消息），高权代理用自己的合法权限执行。学术审计的结论最直白：主流框架把「把工具暴露给模型」当成了「授权」——「none provides a deterministic fail-closed per-call value authorization gate by default」，对 LangChain/LangGraph、LlamaIndex、Stripe Agent Toolkit 三家逐一核实 [arXiv:2606.28679](https://arxiv.org/abs/2606.28679) [论文实测]。Quarkslab 把它定性为**授权问题而非提示问题**：「framing it as an authorization problem, not a prompting/model-smarts problem」（[博客](https://blog.quarkslab.com/agentic-ai-the-confused-deputy-problem.html)）[博客主张]。MCP 官方规范也专设了 Confused Deputy 一节（代理服务器转发被盗授权码）（[MCP auth spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)）[产品宣称]。
2. **批准洗白（approval laundering）**：一个动作被人拒绝后，经另一个队友重新提出——被拒的裁定被代理间传递稀释。Agent Teams 为此写了明文禁令（§2.1）。
3. **不可信的转述批准（relayed approvals）**：队友声称「用户已经批了」，接收方无从分辨这是用户原话还是队友的转述/捏造。Agent Teams 的处理是把这类声称整体降级：「It treats an approval claim relayed from another agent as untrusted input rather than confirmation from you」（[docs](https://code.claude.com/docs/en/agent-teams)）[产品宣称]。
4. **共享状态里的伪造署名（spoofed sender names）**：任务板/邮箱文件里的 owner、--by 落款是自报字符串——任何能写板文件的进程都能冒充任何人。本插件对此的如实声明与业界通病同型（§4）。

这四类共享同一个根因：**权限随消息流动，而身份不随消息流动**。A2A、MCP、Agent Teams、学术能力令牌四条线给出的都是同一个方向——让权限的流动带上可验证的身份锚点。

**本文使用的三层术语**（§2 各来源按此归类，§3.1 展开）：**自报**（self-reported，名字/落款是自由文本，板面不校验真伪）、**绑定**（bound，身份与某个由权威方管理的载体挂钩——进程、代际令牌、签名密钥，生命周期随之管理）、**密码学**（cryptographic，署名可被板外任何一方独立验证，不可否认性成立）。三层是累积关系而非替代关系：密码学层的密钥分发与吊销仍依赖绑定层的载体管理，绑定层的载体最初仍要靠自报层命名——差别在于**谁在什么时刻能伪造什么**。

与循环检测研究（`docs/research/loop-detection-escalation/`）的衔接：循环失控烧的是资源，身份失控烧的是**授权边界**——前者的兜底终点是升级给人，后者的信任锚点同样是人（§3.8）；两份报告共享同一条元设计：把「人的裁决」做成系统里的一等终态，而非告警噪声中的一项。

---

## 2. 业界实践精读

先给一张跨来源的「身份什么层、权限怎么绑、批准落在谁」对照表，便于后文互参：

| 来源 | 身份形态 | 权限绑定 | 批准终点 | 转述/代理间批准 |
|------|---------|---------|---------|----------------|
| Claude Code Agent Teams | 自报名 + 来源分级（会话 ≠ 用户） | permission mode per teammate | 人（lead 会话内审批） | 转述批准=不可信输入；被拒不得借道 |
| Agent Kanban | Ed25519 指纹 + 角色（leader/worker） | 自签 JWT 服务端验签 | 人（human sign-off，PR 评审） | 提交人不得自收自审 |
| A2A | AgentCard 自描述 + 可选 JWS 签名 | securitySchemes（OAuth2/OIDC/mTLS…） | 各自企业策略（Enterprise Ready） | 声明式安全要求，接收方核验 |
| MCP | token 受众绑定（RFC 8707 resource） | 资源服务器模型 + 静态 client 需逐 client 同意 | 授权服务器背后的人（交互式同意） | token 透传禁令（上下游隔离） |
| 学术能力令牌 | 签名令牌六元组（agent/session/action…） | 引用监视器逐调用执法 | 无自动批准（budget/lifetime 限时） | 委托链单调衰减（只减不增） |
| 本插件 | 自报名 + T7 令牌 + origin-chain | scope 继承校验 + 事件溯源 | 人（approve 唯一入口，未落批准者身份） | 无明文规则（GAP-2） |

### 2.1 Claude Code Agent Teams：转述批准 = 不可信输入，批准权不可代行（[docs](https://code.claude.com/docs/en/agent-teams)）**[产品宣称]**

- **队友不能代用户批准**：「A teammate can't approve a permission prompt or supply consent on your behalf」；队友的权限提示直接出现在 lead 会话：「Teammate permission prompts appear in the lead session, so approve them there yourself」——批准通道的终点锚定在人。
- **转述批准降级为不可信输入**：「It treats an approval claim relayed from another agent as untrusted input rather than confirmation from you.」——这条规则没有用任何密码学实现，它是**写给协议/文档的行为契约**。
- **被拒动作不得借道绕过**：「a teammate that was denied an action can't relay it to another teammate to bypass the check」——拒绝裁定跟着动作走，不被转发洗白。
- **配套的消息来源标注**：「Claude Code tells the receiving agent the message came from another Claude session, not from you.」——消息按来源分级（会话 ≠ 用户），且规则外溢到团队之外：「The same rules apply to a message that arrives from one of your other Claude Code sessions, outside the team entirely.」
- **共享状态的完整性面**：邮箱文件读取时逐条校验格式，「Entries that don't match the message format are reported as errors and removed」；发送确认绑定落盘成功。注意：这是**格式完整性**而非署名防伪——与自报身份同层。
- auto 模式下代理间消息逐条先审：「It reviews each message before Claude Code delivers it... A message it blocks never reaches the recipient.」

### 2.2 Agent Kanban（npm [vtit-agent-kanban](https://www.npmjs.com/package/vtit-agent-kanban)，上游 [saltbo/agent-kanban](https://github.com/saltbo/agent-kanban)）：Ed25519 代理身份 + 角色分级 **[产品宣称]**

- 代理身份密码学化：「Every agent gets an Ed25519 identity — a cryptographic fingerprint that follows them across tasks, commits, and PRs.」Ed25519 密钥对**每次代理会话生成**，指纹自公钥派生，另有 identicon 可视化。
- 认证模型：「JWT auth — agents sign their own tokens, verified server-side」——代理自签 JWT，服务端验签；leader 身份「created explicitly once per runtime, then reused across sessions」。
- **角色分级的信任表**（README 原表）：Humans（user session，查看/聊天/管理）｜Leader Agents（Ed25519 JWT：建/派/拒/完成/取消任务、管理板与代理）｜Worker Agents（Ed25519 JWT：认领任务、建子任务、记进度、提交评审）｜Daemons（API key 轮询）。**能力跟着角色走，角色跟着密钥走**。
- 上游 README 补充了一条职责分离铁律：「The assignee cannot accept or reject its own submission.」（[saltbo/agent-kanban](https://github.com/saltbo/agent-kanban)）——评审权与提交权不得同人。
- 证据强度注意：以上均为 README/页面宣称，未获源码级实现核实；npm 包为上游镜像（FSL-1.1-ALv2，26 周下载 ~26 次）。

### 2.3 A2A 协议（Google → Linux Foundation → Agentic AI Foundation）：AgentCard 与代理间认证（[spec](https://a2a-protocol.org/latest/specification/)）**[产品宣称]**

- AgentCard 是代理的自描述清单：「It provides essential metadata including the agent's identity, capabilities, skills, supported communication methods, and security requirements.」关键字段：`securitySchemes`（认证方案）、`securityRequirements`（联系本代理的安全要求）、**`signatures`（AgentCard 自身的 JSON Web Signature）**——发现文档本身可被签名。
- 安全方案对齐 OpenAPI：APIKey/HTTP/OAuth2/OpenIdConnect/**MutualTls** 五族 scheme 对象；客户端「MUST authenticate the request using one of the schemes declared in the public AgentCard.securitySchemes」；服务端「MUST NOT reveal the existence of resources the client is not authorized to access」。
- 治理脉络：Google 2025-04 发布、**2025-06-23 捐给 Linux Foundation**（[Google 官宣](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation)、[LF 新闻稿](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)，创始成员 AWS/Cisco/Google/Microsoft/Salesforce/SAP/ServiceNow）[搜索结果核实]；2026-08 起并入 Agentic AI Foundation（[spec 页公告](https://a2a-protocol.org/latest/specification/)）[产品宣称]。

### 2.4 MCP 授权与任务扩展：资源服务器模型 + 受众绑定（[auth spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)）**[产品宣称]**

- **角色重定义**：MCP 服务器 = OAuth 2.1 **资源服务器**（resource server），MCP 客户端 = OAuth 2.1 client——授权服务器独立在外。「A protected *MCP server* acts as an OAuth 2.1 resource server.」MCP 服务器 MUST 实现 RFC 9728 受保护资源元数据（`WWW-Authenticate` + `/.well-known/oauth-protected-resource`）。
- **受众绑定（audience binding）是反混淆代理的核心**：客户端 MUST 实现 RFC 8707 Resource Indicators——token 请求必须带 `resource` 参数锁定目标 MCP 服务器；服务端「MUST validate that access tokens were issued specifically for them as the intended audience」；**token 透传（passthrough）被明令禁止**：「The MCP server MUST NOT pass through the token it received from the MCP client.」——上下行 token 隔离，防「下游误以为 token 已被上游验证」。
- **2025-11-25 规范引入实验性 Tasks 原语**：call-now-fetch-later——请求可返回任务句柄而不阻塞，生命周期 `working`→`input_required`/`completed`→`failed`/`cancelled`，配套 `tasks/get`、阻塞式 `tasks/result`、`tasks/list`、`tasks/cancel`（[spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)、[WorkOS 解读](https://workos.com/blog/mcp-2025-11-25-spec-update)）[搜索结果核实]；2026-07-28 规范将其改组为扩展、生命周期改为无状态模型（[官方 RC 公告](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate)）[搜索结果核实]。
- 服务器身份/受众绑定的讨论线：`resource` 参数即「token 只对本服务器有效」的规范表达——把**服务器身份绑定进 token 声明**而非网络位置（同页 Security Considerations 节）。

### 2.5 学术：能力令牌、混淆代理审计与身份三层 **[论文实测]**

- **CAPMAS——Macaroon 式链式委托**（[arXiv:2609.06500](https://arxiv.org/abs/2609.06500)，EPFL 系作者，2026-09）：对比学习做语义限定（自然语言查询 → 有界权限集），Macaroon token 承载「offline, tamper-evident delegation with monotonic privilege reduction across agents」——**委托链上权限只能单调衰减**，认证与委托执法从代理推理中解耦。实测：对 OAuth 2.0 Token Exchange（RFC 8693）委托操作快 30×、延迟减半、带宽省 3×；企业级 schema（3100+ 端点）17ms 内 >90% 完美权限束检索；相对全量传递用户权限减少 99.5% 不必要授权 [论文实测]。
- **AgentCap——签名能力令牌 + 工具边界网关**（[arXiv:2611.00729](https://arxiv.org/html/2611.00729v1)，Virginia Tech，2026-10-31）：每个模型提议的工具调用视为不可信；策略引擎校验意图/信任分/参数来源/工作流前置/互斥规则后签发**Ed25519 签名的短时效 JWT 能力令牌**，绑定 agent/session/action/resource/intent/lifetime/budget 六元组；委托建模为只减不增的父子链。实测：AgentDojo 上 GPT-4o 攻击成功率 45.63%→5.09%、GPT-5.4 33.23%→0.00%，攻击下效用几乎无损（75.04% vs 75.68%）；InjecAgent 上同趋势；执法路径中位延迟 <0.2ms。方法论金句：「Intent is not a trusted assertion of benign behavior: the model supplies it.」[论文实测]。
- **ScopeGate 审计——「能力门 ≠ 授权」**（[arXiv:2606.28679](https://arxiv.org/abs/2606.28679)，2026-06）：审计 LangChain/LangGraph、LlamaIndex、Stripe Agent Toolkit 固定版本，三者默认都只有能力门（工具暴露）；提出五阶段 PDP/PEP 设计（scope/授权/金额上限/幂等/默认拒绝），同一越权 payout 调用在 LangChain 默认分发下执行、在 ScopeGate 下被拦：0/48 静态绕过、0/29 自适应越权、0/10 良性误拒 [论文实测]。
- **Anthropic 信任五原则**（[Trustworthy agents in practice](https://www.anthropic.com/research/trustworthy-agents)）：「keeping humans in control, aligning with human values, securing agents' interactions, maintaining transparency, and protecting privacy」；权限粒度到单动作（always allow / needs approval / block）；Plan Mode 把监督「from the individual step to the overall strategy」[博客主张]。

### 2.6 生产平台的身份形态：绑定、审计与签名 **[产品宣称]**

- **GitHub App 安装令牌**（[community 讨论](https://github.com/orgs/community/discussions/196652)、[审计日志文档](https://docs.github.com/github-ae@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/audit-log-events-for-your-enterprise)）：`ghs_` token 代表**应用身份而非用户身份**——用它做的操作归因到 `app[bot]`，审计日志靠 `actor` 字段落档；用户归因需走交互式 OAuth（`ghu_`）。已知归因陷阱：CI 共享 token 会让所有人的操作都归到 App 名下（[copilot-sdk issue #551](https://github.com/github/copilot-sdk/issues/551)）[博客主张]——**共享身份 = 审计失效**，这是「谁干的必须落到细粒度主体」的反面教材。
- **Kubernetes ServiceAccount——绑定式身份的范式**（[docs](https://kubernetes.io/docs/concepts/security/service-accounts/)）：v1.22+ 令牌经 TokenRequest API 签发，「short-lived, automatically rotating token」且**绑定到 Pod 对象**——Pod 删除即失效；token 携带 audience 声明，校验方应核对受众；权限不在 SA 本体，由 RoleBinding 授予。买到的：生命周期绑定 + 受众限定 + 最小授权，无需每代理一把长期密钥 [产品宣称]。
- **Sigstore——产出物签名的无密钥形态**（[safeguard.sh 综述](https://safeguard.sh/resources/blog/what-is-sigstore)、[sbomify](https://sbomify.com/2024/08/12/what-is-sigstore)）：短时效证书绑定 OIDC 身份（如 GitHub workflow），签名入 Rekor 透明日志；GitHub artifact attestations 用它签 in-toto/SLSA 出处声明——验证方同时确认「谁签的」与「怎么造的」。对代理产出物（补丁/报告）的类比：**署名可以事后验，不必事前信任** [博客主张]。

---

## 3. 设计提炼（8 条可落地启示）

1. **身份分三层买，各层买到不同的东西。** 自报层（本插件现状）：买到**防误用**——同板协作方靠名字认人，挡不了恶意伪造；绑定层（K8s SA 式）：买到**生命周期与受众限定**——token 绑进程/会话，死了即失效，越界受众拒收；密码学层（Ed25519/A2A JWS）：买到**不可否认**——板外可验证，跨板/跨机也成立。跳层买入（直接上密码学）在不解决「密钥与代理会话怎么绑定」之前是伪安全；跳层豁免（全程自报）则应像本插件一样把口径如实写死（防误用不防伪造）。
2. **「转述批准不可信」是协议文本，不是密码学问题——最便宜、价值最高的一条。** Agent Teams 的三句原文（队友不能代批/转述批准=不可信输入/被拒不得借道）全部零基础设施实现。映射到本插件：在 SKILL.md 批准语义段写死「专家转述的『用户已批』一律不构成批准；被用户/编排者拒绝的动作不得改头换面经另一专家再提」——一次文档改动，封掉批准洗白整类攻击。
3. **审计留痕优先于防伪造：先让板面能回答「谁批的」。** GitHub 审计日志、K8s 审计、任务板事件流共同哲学：事后可归因是底线，事前防伪是升级。本插件 approve 命令连批准者落款都没有（§4 GAP-1）——补一个自报口径的 `--by` 落款字段（沿 m-vote `--by` 落款即身份的既有口径）即可把「批准不可归因」变成「批准可归因但可伪造」，后者严格优于前者。
4. **跨代理授权用工具生成的不可猜能力令牌。** T7 peer-reassign 的 `at-<16hex>` 工具生成、绝不复用已撤销代际、证明与自报混用即拒（`attempt_source_conflict`）与学术线完全同构（AgentCap 的签名令牌是同思路的密码学升级版；CAPMAS 的 Macaroon 衰减链对应 origin-chain 的深度推导）。扩展方向：任何「代理 A 把权交给代理 B」的面（互派、免审创建、代收消息）都应走同一条「工具生成 + 持有证明 + 单调衰减」的路。
5. **deny 列表是身份执法的落点。** 本插件已有两处先例：递归防护 deny 六项（子代理不能再召唤专家）与 per-expert 档案 toolFilter（非白名单 MCP server 的 `mcp__*` 全 deny）。身份执法同理：**专家不该有的权限，从工具面摘掉**（如对专家 deny 直接跑 `approve`/`reassign` 的 bash 面），比事后审计每条命令便宜且确定——「模型能不能调」比「模型该不该调」好执法。
6. **签名/验签是中期项：文件板上最短路径是签名追加而非改造。** Agent Kanban 证明 Ed25519 落板面可行（每次会话生成密钥对 + 自签 JWT + 服务端验签）；文件板等价物 = 代理在本板生成密钥对、写板时对事件追加签名行、读板时验签——改造成本集中在 taskboard.py 写入/读取两点，与既有 flock+CAS 串行兼容。前置条件是先回答「密钥放哪、和哪个会话绑定」（K8s 的答案：绑对象、短时效、可轮换）——这正是 T7 令牌机制的自然延伸。
7. **职责分离：请求者 ≠ 批准者 ≠ 实施者。** Agent Kanban 上游明文「The assignee cannot accept or reject its own submission」；本插件 M1 链已有雏形（自建草案强制 draft、owner==created_by、批准在编排者手里）但未成文为通用规则。成文化：任何「自己提议、自己验收」的组合都是反模式——专家自建任务的批准权留在编排者，评审任务的评审员不得是修复者本人（m 票路径的独立召唤已部分覆盖）。
8. **人是信任链的最终锚点，批准通道必须 terminating 在人。** Agent Teams（权限提示出现在 lead 会话、队友不能代批）、Anthropic 五原则（keeping humans in control）、A2A（Enterprise Ready 对齐既有企业实践）三方一致。架构含义：代理间可以流传**信息**，但**授权**只能从人流向代理——任何把批准消息在代理间转手的设计（含「专家代用户批另一专家的草案」）都在稀释锚点。

---

## 4. 与本插件现状的对照（非实施承诺）

已有机制（据 `README.zh.md`、`skills/expert-orchestration/SKILL.md`、`tools/taskboard.py`、`CHANGELOG.md`）：

| 机制 | 层级 | 现状与口径 | 对应业界形态 |
|------|------|-----------|-------------|
| owner 自报名 | 自报 | 全板 owner 为板面自报，多文档明示「防误用不防伪造」（T9 open-counts、T14 规则 6） | Agent Teams 邮箱文件的格式完整性层（无署名防伪） |
| m-vote `--by` 落款 | 自报 | 「落款即身份」，信任模型与直改主板同信任级别（能写板文件即可伪造落款），评审员身份系统为既定非目标（SKILL.md §m 票节） | GitHub `actor` 字段的审计层 |
| T14 attempt 绑 owner | 绑定（opt-in） | `DSH_EXPERT_ATTEMPT_BIND_OWNER` 开启后代际落 attempt_owner，持证明通道（done --by/vote --by/reassign）校验 mismatch；缺省关闭 | K8s SA 绑 Pod 的任务板弱化版 |
| T7 peer 互派能力令牌 | 绑定 | 工具生成不可猜 `at-<16hex>`、不复用已撤销代际、证明与自报混用拒 `attempt_source_conflict` | AgentCap 令牌的前密码学版 + CAPMAS 单调衰减思想的拓扑版 |
| origin chain（M8-2） | 绑定（拓扑） | 任务书末行 (专家名, cwd) 链、重复对即拒、深度由链长推导不信任计数字段 | 防环链路溯源；协议侧复制约定经对照实验 9/9 保真 |
| created_by（M1） | 自报+校验 | 7 具名错误码校验链（owner==created_by、scope ⊆ 父任务、强制 draft 等） | Agent Kanban 职责分离的部分形态 |

**识别出的 GAP（按严重度排序）：**

1. **approve 不携带批准者身份，板面无法回答「谁批的」。** `cmd_approve`（taskboard.py:1580）只改状态（draft→pending/ready），无 `--by` 参数、批准者不落事件 args——与 done/vote/reassign 三条持证明通道的既有留痕口径不一致。对照 §3.3：这是审计面（甚至自报层审计）的缺位，不是防伪缺位；补齐成本最低、收益最直接。
2. **无「转述批准不可信」协议规则。** 专家转述「用户已同意/已批准」在现行文档里没有降级条款——对照 Agent Teams 三句原文（§2.1），本插件缺的恰好是最便宜的那层（§3.2）。
3. **专家经 bash 直跑 approve 无 deny 面。** 现行口径把经 bash 改板归入「与直写主板同信任级别」的非目标（过代过滤仲裁面边界声明同口径）；但 §2.1/§3.5 的路线是把「权限不该有的面」从工具面摘掉（deny）作为身份执法，而非接受同信任级——两者不冲突：deny 是防止专家**顺手**调到批准工具，同信任级声明防的是对抗性直改，后者仍是既定非目标。

**若做，最小落点排序**（依据 §3）：GAP-2 一段协议文本（成本≈0）；GAP-1 一个 `--by` 参数 + 事件 args 落档（沿 m-vote 口径）；GAP-3 视宿主 toolFilter 能力评估（专家档案 deny 面）；签名验签（§3.6）仅在前三项落稳且出现跨板/跨机协作真实需求后立项。

---

## 5. 出处清单

| # | 来源 | 用途 | 访问状态（2026-11-12） |
|---|------|------|------------------------|
| 1 | [Claude Code Agent Teams docs](https://code.claude.com/docs/en/agent-teams) | §2.1/§3.2/§3.8 转述批准不可信/队友不能代批/被拒不得借道 | 已核实（正文抓取，引文逐字） |
| 2 | [vtit-agent-kanban（npm）](https://www.npmjs.com/package/vtit-agent-kanban) | §2.2 Ed25519 身份/自签 JWT/角色信任表 | 已核实（页面抓取） |
| 3 | [saltbo/agent-kanban（上游 GitHub）](https://github.com/saltbo/agent-kanban) | §2.2/§3.7 职责分离铁律/签名绑定 | 已核实（README 抓取；细节文档未逐页核实） |
| 4 | [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) | §2.3 AgentCard/securitySchemes/签名 | 已核实（正文抓取） |
| 5 | [Google 捐赠 A2A 官宣](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation)、[LF 新闻稿](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents) | §2.3 治理脉络 | 搜索结果核实（未抓正文） |
| 6 | [MCP Authorization spec（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | §2.4 资源服务器模型/受众绑定/token 透传禁令/Confused Deputy 节 | 已核实（正文抓取，引文逐字） |
| 7 | [MCP Tasks（2025-11-25）](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)、[WorkOS 解读](https://workos.com/blog/mcp-2025-11-25-spec-update)、[2026-07-28 RC 公告](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate) | §2.4 Tasks 原语与改组 | 搜索结果核实（未抓正文） |
| 8 | [CAPMAS（arXiv:2609.06500）](https://arxiv.org/abs/2609.06500) | §2.5/§3.4 Macaroon 单调衰减委托/实测数字 | 已核实（摘要页抓取；全文细节未逐行核实） |
| 9 | [AgentCap（arXiv:2611.00729）](https://arxiv.org/html/2611.00729v1) | §2.5/§3.4 Ed25519 令牌六元组绑定/AgentDojo 实测 | 已核实（正文抓取） |
| 10 | [Confused-Deputy Failures in LLM Agent Frameworks（arXiv:2606.28679）](https://arxiv.org/abs/2606.28679) | §1/§2.5 三框架审计/ScopeGate 实测 | 已核实（摘要页抓取，含正文摘录） |
| 11 | [Anthropic: Trustworthy agents in practice](https://www.anthropic.com/research/trustworthy-agents) | §2.5/§3.8 五原则/权限粒度 | 已核实（正文抓取） |
| 12 | [Quarkslab: Agentic AI the Confused Deputy problem](https://blog.quarkslab.com/agentic-ai-the-confused-deputy-problem.html) | §1 授权问题定性 | 搜索结果核实（未抓正文） |
| 13 | [GitHub community #196652（ghs_ token）](https://github.com/orgs/community/discussions/196652)、[GitHub 审计日志文档](https://docs.github.com/github-ae@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/audit-log-events-for-your-enterprise)、[copilot-sdk #551](https://github.com/github/copilot-sdk/issues/551) | §2.6/§3.3 应用身份归因/共享 token 陷阱 | 搜索结果核实（未抓正文） |
| 14 | [Kubernetes ServiceAccounts docs](https://kubernetes.io/docs/concepts/security/service-accounts/) | §2.6/§3.1 绑定式身份/audience/RBAC | 已核实（正文抓取） |
| 15 | [Sigstore 综述（safeguard.sh）](https://safeguard.sh/resources/blog/what-is-sigstore)、[sbomify](https://sbomify.com/2024/08/12/what-is-sigstore) | §2.6 keyless 签名/Rekor/SLSA 出处 | 搜索结果核实（未抓正文） |
| 16 | [MCP 2025-11 Tasks（safeguard.sh 解读）](https://safeguard.sh/resources/blog/mcp-tasks-explained-long-running-tool-calls-polling-cancellation-and-how-to-secure-them) | §2.4 Tasks 机制细节 | 搜索结果核实（未抓正文） |

**遗留问题**：①Agent Kanban 的 Ed25519/JWT 信任模型只有 README 宣称，源码级实现（密钥生成/验签位置）未逐行核实；②A2A `signatures` 字段的实际采用度（多少生产 AgentCard 真的签名了）未获数据；③vtit-agent-kanban npm 包为第三方镜像，长期以 saltbo 上游为准；④CAPMAS 全文评估细节（威胁模型章节）仅核到摘要层；⑤「2025-11 Tasks 扩展」一说经核实有出入——Tasks 于 2025-11-25 规范以实验性核心原语落地，2026-07-28 才改组为扩展，本文按实际时间线记录（§2.4）。
