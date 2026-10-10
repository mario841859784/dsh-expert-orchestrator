# dsh-expert-293 T2 回炉交付报告 — restrictProbeFaces 真机失配根因修复

日期：2026-10（回炉轮）｜仓库 HEAD 基线：e05ce8d（2.9.3），开工时工作树干净
改动文件：`lib/tools.js`、`test/tools.selftest.mjs`（scope=lib,test 达成；未动版本号/CHANGELOG/cordis.patch.yml/agent.cordis.yml）

## 一、根因判定（A 方向，源码行号实证）

**「宿主 spawn 侧对 spec.toolFilter 再过滤」假设不成立；deny=3 是插件侧自收窄，机理如下：**

1. 宿主对 toolFilter 是**原样透传**：dsh-subagent/lib/index.js:1418/:1462（request.toolFilter 原样入 descriptor/composition）→ :1815 `applyChildComposition` → :401 `childCtx.tools.restrict(composition.toolFilter)`；:619-:625 parseToolFilter 只校验形状，无名字过滤。
2. preset 工具（subagent/subagent_fork/workflow/ralph）**不在全局层**：dsh-agent-preset-registry/lib/index.js:701-718 `composeFrom` 只做 `bindScopeParent(子 scope key, preset generation key)`（:710 join）——preset 组合行注册在 preset generation scope 层，对每个 agent 是**祖先链层贡献**（dsh-tools/lib/index.js:2938-2946 注释原文亦证）。dsh-agent-loop/lib/index.js:778 `createScope(loopCtx, this)`——**agent 对象本身即 scope key**。
3. **真机失配的确切机理**：dsh-tools 视域方法把 scope 作为**显式参数**——`get(name, scope)`（:2940）/`schemas(scope)`（:3021），「omitted = the global view」；`view(scope)` 中 restrictableNames = 全局层 ∪ 祖先链层（:2955-:2985），`restrict()` 校验集即它（:2904）。而 cordis Service 代理（cordis/lib/index.js:117-122 `createShadowMethod`、:125-157 `createTraceable`，tracker property="ctx"）**只把 this.ctx 重绑到访问方 ctx，从不向省略的参数注入 scope**。因此 2.9.3 新加的 scopeCtx 面（exec.agent.ctx）上无参调用 `schemas()`/`get(name)` 读到的仍是**全局视域**——scopeCtx 面在真机退化成第二个全局面，preset 作用域名双面双盲 → `filterRestrictableTools` 判「definitively 未注册」剔除 → deny 收窄成 3 名召唤工具。
4. 宿主会接受 6/7 名 deny：被召唤专家的 scope 链 = [child → generation]（composeFrom 绑定），其 restrictableNames = 全局 ∪ generation 层，含全部递归防护名——2.9.3「并集是安全上界」的判断本身正确，只是探测根本没读到那个视域。

## 二、落地修复（B 方向选型）

- **主执法层（唯一插件可达且实证有效的层）= toolFilter 可见性 deny，修复探测面**：
  - `hostRestrictableNames(ctx, scope)`：`schemas(scope ?? undefined)` / 探测面 `get(name, scope)` 显式传 scope（旧代宿主不收该参数时忽略多余实参，行为与 2.9.3 一致，不回归）。
  - `restrictProbeFaces(ctx, scopeCtx, scope)`：scope **只透传给 scopeCtx 面**；插件 ctx 面保持全局视域——view() 的 restrictableNames 不受既有 restrictions 影响，全局注册名即使被召唤者侧 restrict 隐藏也须由全局面确证保留。
  - `filterRestrictableTools`/`resolveProfileEffect` 加第 5 参 scope 透传；runExpert 调用点传 `exec?.agent ?? null`（对象即 scope key）。
- **deny 清单补口 `ralph`**（EXPERT_TOOLS_DENY_LIST 6→7 名）：源码实证 dsh-tool-ralph/lib/index.js:301 工具名 "ralph"、:331 `ctx.workflowEngine.start` 每轮 spawn 全新子代理——与 workflow 同为绕过 tool-subagent maxDepth:1 熔断的派生面（证据④同构），此前不在 deny 表=递归侧门。
- **workflow 引擎深度配置：核实为不存在**——PtcWorkflowEngine.Config 仅 provider/maxConcurrentAgents/maxTotalAgents/maxItemsPerCall/syncTimeoutMs（dsh-workflow-ptc/lib/index.js:591-:597）；startChild 不传 maxDepth（:330-:334 附近的 startActivation 调用），startLocal 只认 request.maxDepth（dsh-subagent/lib/index.js:1402-:1405）。**无宿主缝可配深度，cordis.patch.yml 域无需也不应改动**——workflow/ralph 的递归执法只能落在 toolFilter 可见性层，本修复已覆盖。
- 未砍任何功能；非文档-only。

## 三、用例（C 方向）

- **mock 与宿主真实装配的偏差点**：旧用例 mock `scopeCtx.tools.schemas = () => agentScopeNames`（**零参**返回作用域名）——真实宿主 `schemas(scope)` 无参=全局视域，且 cordis 代理不注入 scope 参数。mock 绿真机红即源于此。
- 新增用例 `dsh-expert-293 T2 宿主形状用例`：按宿主形状构造 `schemas(scope)/get(name, scope)` 显式参数语义 mock，双向钉死——①传 scope=7 名全保留；②**回归钉**：同一条 scopeCtx 不传 scope→收窄成 3 名（2.9.3 真机失配现场），防止假形状 mock 回潮；③get 探测面双向同断言；④faces kind 收集。
- 原「T1 负向主用例」mock 重构为宿主形状（summoner 对象=scope key、summoner.ctx 共享同一 registry、显式 scope 透传），全链断言派发描述符 deny=7 名；「T1 降级」用例同步 ralph 收窄语义。

## 四、npm test 摘录（新基线）

```
ℹ tests 280   ℹ pass 279   ℹ fail 0   ℹ skipped 1   ℹ todo 0
```
（基线 279/278 pass/1 skipped → 新基线 280/279 pass/1 skipped，+1 = T2 宿主形状用例）

## 五、编排者下一轮冒烟判据（2.9.3/alpha.2 重启后）

**生效执法层：toolFilter 可见性 deny（spawn 期 `applyChildComposition` → `childCtx.tools.restrict` 宿主执法）。**

1. 召唤任意专家后查其描述符：`toolFilter.deny` 应=**7 名** `[list_experts, summon_expert, summon_experts, subagent, subagent_fork, workflow, ralph]`（2.9.3 真机为 3 名）。若仍 3 名→本修复未部署/未重启，回炉无效。
2. 被召唤专家工具面：subagent / subagent_fork / **workflow** / ralph 全部不可见——实调 workflow 应得 UNKNOWN_TOOL（证据④旁路闭合的可观察判据），实调 subagent 不再到达「depth 2 exceeds maxDepth 1」而是工具不存在。
3. 若宿主注册表某派生名真缺失（如 ralph 未注册）：deny 相应收窄 + stderr 出现 `toolFilter deny 跳过宿主未注册的工具：<名>` warn，summon 不炸（降级语义保留）。
4. 边界提醒（如实声明）：preset 组合行 subagent/subagent_fork 带 `toolFilter.deny: []`+maxDepth:1 是 tool 工具层熔断，对 workflow/ralph 引擎无执法力（引擎 spawn 无 maxDepth 缝）——故冒烟以描述符 7 名 deny + workflow UNKNOWN_TOOL 为准，不要以 depth 报错为准。

## 六、遗留与未验证项

- 召唤者 own 层含与 deny 重名工具的病态部署会在 spawn 期被宿主 restrict 响亮拒绝（响亮失败优先于静默放宽，注释已声明）；两代宿主部署 own 层为空。
- 旧代宿主（schemas/get 不收 scope 参数）行为与 2.9.3 完全一致：未在旧代实机验证，标注为「源码推定」。
- 真机 7 名 deny 的最终确认依赖编排者冒烟（本任务无实机调用面）。

—— 后端工程师
