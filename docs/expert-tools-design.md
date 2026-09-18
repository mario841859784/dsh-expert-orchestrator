# 自有召唤工具实现设计（list_experts / summon_expert / summon_experts）

> 状态：实现前设计（v2.2.0 之后迭代，用户已裁决：弃用 maxDepth 深度控制，递归防护改工具层 toolFilter）。
> 依据：DSH 0.1.6-alpha.1 宿主源码（@deepseek-ai/dsh-tool-subagent、@deepseek-ai/dsh-subagent、@deepseek-ai/dsh-subagent-spawn-in-process）、Agency 参考实现（MichengAI/dsh-agency-agents src/index.ts，731 行，已逐段核对）、本仓 v2.1/v2.2 来源管理现状（roster-aliases.json 28 条、merged/roster.json rosterFormat:2、getExpertContent 只读访问器）。

## 一、preset 插件内自定义工具注册契约（宿主实测口径）

**注册 API**：`ctx.tools.register(defineTool({...}))`，descriptor 五要素：
- `name`：全局唯一工具名（我们用 `list_experts` / `summon_expert` / `summon_experts`，与 Agency 同名以复用编排协议习惯）；
- `description`：给模型的用途说明（ summon 的描述需包含「Call list_experts first if you do not know the expert name」引导）；
- `parameters`：参数 schema（`{name: {type:'string', required:true, description}}` 形态；批量版 items 用 `additionalProperties:false` 收紧）；
- `output`：`{schema: {type:'object', properties...}, render: (args, value) => [{type:'text', text}]}`——render 决定工具结果在对话里的呈现（summon 直接渲染 answer 正文）；
- `execute(args, exec)`：`exec.agent`（父 agent，spawn 的 parent 必需）、`exec.signal`（取消信号）。

**与 agent.cordis.yml 的绑定**：工具行（`- id: tool-xxx / name: '@deepseek-ai/dsh-tool-subagent'`）注册的是**宿主官方工具**；我们插件的 ctx.tools.register 注册的是**插件自有工具**，两者并存，插件工具不需要在 cordis.yml 加行（Agency 的三个工具就没有对应行）。isolate realm 规则只约束「发布服务」的行——纯工具注册不发布服务，无需 isolate（与Agency 一致：其工具注册无 isolate 标注）。

**运行时服务消费**：`ctx.subagents.getProvider(providerName)` 拿 spawn provider；`ctx.reflect.provide(SERVICE_ID, obj)` 把 catalog/persona 服务暴露给 client（我们的 expertSources Remote 已用同机制）。

## 二、Agency 参照（summon 实现逐要素）

Agency `runExpert(query, task, exec)` 的完整校验与 spawn 序列（照抄语义，替换数据源）：
1. `exec.agent === undefined` → 报错（summon 必须发生在有 agent 的会话）；
2. `ctx.subagents.getProvider(config.provider)` 缺失 → 报错；
3. 能力三查：`provider.capabilities.persona`（注入 persona 文本）、`capabilities.toolFilter`（拒发工具）、仅当配置 maxDepth 时查 `capabilities.depthLimit`；
4. 冲突专家排除：`catalog.experts.filter(e => !e.conflict)`——conflict 项不可被召唤（比我们的 shadowed 更严：conflict 直接不可用）；
5. disabled 检查：`enabledSet().has(expert.slug)` 不含 → 报 expertDisabled；
6. persona 读取：`personaSource.getPrompt(slug, division, locale)`（custom-* 走 library，其余走文件；路径穿越已拒）；
7. spawn 请求：
   ```js
   ctx.subagents.start(config.provider, {
     label: `expert:${expert.slug}`,
     prompt: [{ type: 'text', text: taskText }],
     parent: exec.agent,
     persona: sanitize(persona),                                  // ← persona 注入：子代理 shadow 其 deployment:persona 段
     toolFilter: { deny: ['summon_expert', 'summon_experts', 'list_experts'] },  // ← 递归防护
     ...(maxDepth === undefined ? {} : { maxDepth }),
     signal: exec.signal,
   })
   ```
8. 同步等结果：`const run = await ctx.subagents.start(...); const result = await run.result;`（one-shot 语义，summon 阻塞至专家完成）；`result.stopReason !== 'completed'` → partialOutput 报错；`finally { await run.dispose() }`；
9. `sanitize(persona)`：注入前净化——我们实现时必须保留此步（persona 来自磁盘文件，防 frontmatter 注入面）；
10. 批量版 `summon_experts`：`mapPool(specs, CONCURRENCY=4, ...)` 并发池、部分成功仍返回（ok/error 逐项）；
11. 父会话系统提示注入：`ctx.systemPrompt.section({name:'agency:experts', order:117, text})`——带 `parentSession !== undefined → return ''` 守卫（被召唤的子代理不注入该段）。

**与 Agency 的差异点（我们的适配）**：
- 数据源：Agency 目录扫描 `<division>/*.md` + frontmatter name/emoji；我们= merged/roster.json（core+sources，rosterFormat:2）+ roster-aliases.json（28 条惯用名映射）+ getExpertContent（v2.2 已有只读访问器）；
- 分组维度：无 division 概念 → **用来源 ID 作分组维度**（list_experts(bySource?) 按来源分组计数/展开）；
- 冲突语义：Agency conflict=不可召唤；我们=去重代表可召唤、shadowed/disabled 不可召唤（语义映射写进工具 description 与实现）。

## 三、expert 解析链（委派名 → persona 文本）

```
list_experts(bySource?)
  → roster.json: core[11] + sources[](awesome 171 / agency-agents-zh 273 / custom N)
  → 剔除 shadowed / disabled / conflict → 按来源分组（文件数计数；bySource 展开详情）
  → 惯用名兼容：roster-aliases.json 的 28 条映射反向可见（routing.md 惯称 ↔ 原生 name）

summon_expert(expert, task)
  → expert 解析：a) 精确 name（含 zh 包 name: 字段）；b) roster-aliases 惯用名命中（如「低风险变更工程师」→ 最小变更工程师）；c) 无歧义 title 归一命中；多命中 → 报错列候选
  → 启用检查：shadowed/disabled 拒绝（error.expertDisabled）
  → persona 文本：getExpertContent({sourceId, file})（v2.2 已有，seatbelt 复用）
  → sanitize(persona)
  → ctx.subagents.start(provider, {prompt: taskText, persona, toolFilter: {deny: ['list_experts','summon_expert','summon_experts','subagent','subagent_fork']}, parent: exec.agent, signal})
  → await run.result → run.dispose → 返回 {expert, answer}
```

**toolFilter 拒发清单（与 Agency 的差异，已加固）**：Agency 只 deny 三个召唤工具（其子代理仍可 spawn 通用 subagent）；我们**追加 deny `subagent` / `subagent_fork`**——被召唤专家彻底失去派生能力，递归防护完全闭环（用户裁决：递归防护改工具层）。代价：专家无法自行派帮助者（与 Agency 时代「专家不得再召唤」规则一致，符合用户既有裁决方向）。

## 四、maxDepth 移除后果清单

1. **无宿主深度熔断（部分）**：删除四行 `maxDepth: 2` 后，工具 schema default=3 生效（`.default(3)`）——**depth > 3 仍会抛 SubagentDepthError**，即「回到工具默认 3 层熔断」，不是无界。递归主路径已被 toolFilter 拦截，default 3 只是纵深防御兜底；
2. 子代理递归途径盘点（toolFilter deny 后）：召唤工具 ✗、subagent/subagent_fork ✗（建议 deny）、workflow 工具 ⚠️（dsh-tool-workflow 可派 agent——Agency 未 deny 它；开放问题：我们是否追加 deny 'workflow'，建议是）；
3. provider-managed 语义不再使用（此前它 = 不传 maxDepth = 无熔断，是本事故根因之一）；
4. `assertSubagentProviderConfiguration` 仅在 maxDepth 为数字时查 depthLimit 能力——移除后该检查自然跳过，spawn/fork provider（depthLimit: true）兼容性无影响。

## 五、最小接口清单

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_experts` | `bySource?: string` | `{sources: [{source, count, experts?: [{name, title, source}]}], total}` | 缺省只列来源+计数；传来源 ID 展开该来源专家（name 为花名册原生 name） |
| `summon_expert` | `expert: string`（必填，花名册 name 或 roster-aliases 惯用名）、`task: string`（必填，自包含） | `{expert, answer}` | 同步阻塞至专家完成；persona 注入；toolFilter deny 递归 |
| `summon_experts` | `experts: [{expert, task}]`（≤8） | `{results: [{expert, ok, answer, error?}]}` | 并发 4、部分成功语义 |

非工具接口：`ctx.reflect.provide('expertOrchestratorCatalog', catalogService)`（client 设置页继续消费）；`ctx.systemPrompt.section('expert-orchestrator:roster', ...)`（父会话花名册引导，带 parentSession 守卫）。

## 六、风险与开放问题

1. **ctx.tools / ctx.subagents 在我们插件上下文的可用性**：Agency 与 dsh-tool-subagent 均在同一宿主注册成功，风险低，但实现第一步必须做存在性断言（缺 capability 即 fail-fast 报清晰错误）；
2. **递归防护闭环依赖 deny 清单完备性**：deny 漏掉任何一个可派生工具（如 workflow）即开侧门——实现时以「deny 全部已知可派生工具 + 新增派生工具时同步」为维护约定；
3. **persona 注入的 sanitize**：persona 文件来自上游仓库（第三方），注入前 sanitize 的规则需定义（至少：剥离 frontmatter、长度上限、控制字符清理）；
4. **getExpertContent 与 summon 的读放大**：summon 时读 persona 全文（几 KB-几十 KB），450 位花名册全量 list 时只读元数据不读正文（Agency 用 frontmatter-only 启动加载 + 按需读正文，同款）；
5. **与已装 dsh-agency-agents 的共存**：用户已卸载；若将来重装，工具重名（list_experts 等）冲突行为未知——开放问题，届时实测；
6. **过渡期暴露**：本设计落地前，递归防护 = 工具默认 3 层深度（maxDepth 已移除）+ 无 toolFilter——实现排期应尽快。

## 七、实现记录（T2，后端架构师）

- 已实现：lib/tools.js（registerExpertTools：list_experts/summon_expert/summon_experts 三工具 + sanitizePersona + resolveExpert 解析链 + EXPERT_TOOLS_DENY_LIST 递归防护）；lib/index.js apply 末尾 fire-and-forget 接线（动态 import + 降级为 console.error，不崩 preset——偏离 Agency fail-fast 的刻意决策）。
- 与设计的差异：①注册失败降级而非 fail-fast；②deny 清单追加 'workflow'（设计文档第四节建议采纳）；③defineTool 解析失败降级恒等包装（沙箱/离线场景；宿主环境经 peerDependencies pnpm auto-install-peers 解析）；④task 码点上限 8000（与 Agency 一致，非任务书草稿的 20000）。
- agent.cordis.yml：subagent/subagent_fork 活跃行加 toolFilter deny（召唤工具 + subagent/subagent_fork/workflow 六项）；maxDepth 移除已由调研阶段完成。
- package.json：peerDependencies 声明 @deepseek-ai/dsh-tools（0.1.6-alpha.1 || 0.1.6-alpha.2，pnpm auto-install-peers 解析）。
- 验证：mock 36/36（注册/解析链/sanitize/全链路 spawn 断言/批量部分成功/递归 deny）+ 回归 38/38、52/52、51/51、45/45（conflicts 断言已按 v2.1.1 裁决语义更新）。
