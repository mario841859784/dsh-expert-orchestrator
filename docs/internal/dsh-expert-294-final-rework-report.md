# dsh-expert-294 回炉终轮报告：summon 派发回归修复（P0）与 workflow/ralph 旁路执法判定（P1）

- 基线：HEAD e565005（v2.9.4），修复未提交，树内仅 lib/、test/ 与本报告改动。
- 结论一句话：**P0 已落地（deny 只传全局层确证名，summon 恢复派发）；P1 判定为「allow 语义符合落地条件」，已同步落地递归防护 allow，workflow/ralph/subagent/subagent_fork 四条派生通道对被召唤专家全通道不可见。**

## 一、根因（源码行号级）

实机证据：0.2.1-alpha.2 重启后 summon 派发即拒，`tools.restrict() names unknown global tool "subagent"`，报错自带 known 清单含 subagent_fork/workflow/ralph/summon_expert 等、唯独没有 subagent；而编排者（父会话）能调用 subagent。

宿主源码（@deepseek-ai/dsh-tools 0.2.1-alpha.2 lib/index.js）：

1. `restrict()` 校验集（:2893-2906）：`const known = this.view(scope).restrictableNames`（:2904），未知名直接抛 `names unknown global tool ...`（:2906）。scope = 发起 restrict 的 ctx 的 scope——spawn 期即 dsh-subagent `applyChildComposition` 里的 `childCtx.tools.restrict(composition.toolFilter)`（dsh-subagent lib/index.js:401）。
2. `view(scope)` 的集合定义（:2957-2983）：
   - `restrictableNames` = **inherited**（全局层 ∪ scope 链各层工具，:2960-2963/:2968-2970）——**不含 own 层**（:2962 `if (layer === own) continue`）；
   - `visible` = inherited 中「每个链上层都 admits」者（:2971）**∪ own 层工具无条件并入**（:2973-2976）。
3. 子代理的 scope 链：`composeFrom(childCtx, parent.ctx)` → `join` → `bindScopeParent(childKey, generation.key)`（dsh-agent-preset-registry lib/index.js:701-712/:668-680）——子代理 scope 父被绑到 **preset generation key**（根为全局层），**召唤者的 own 层与其更高祖先层（GUI 会话 preset generation，实机现场的 subagent 所在层）都不在子代理链上**。
4. 2.9.4 的探测面（lib/tools.js 旧 restrictProbeFaces T2 版）对召唤者 agent scope 显式传 `scope=exec.agent`，读 `schemas(exec.agent)`/`get(name, exec.agent)`——这两个 seam 返回的都是 `view(exec.agent).visible`（:3021/:2994），**包含召唤者 own 层/更高祖先层工具**。于是「召唤者可见的 subagent」被确证为「已注册」进入 deny，而子代理侧校验集（全局 ∪ generation）不认识它 → 整个 spawn 被拒。

本质：**「召唤者可见集」（view(summoner).visible）与「子代理 restrict 校验集」（view(child).restrictableNames)是两个集合**；且 schemas/get 这条 seam 只能读到 visible，无法区分一个「scope 可见」的名字究竟属于 generation 层（子代理可 restrict）还是召唤者 own/更高层（不可 restrict）。结论：唯一可靠的执法规则是 **deny/allow 名单只收全局层确证的名字**（全局层 ⊆ 任何 scope 的 restrictableNames，view() 从 global 层起算 inherited，:2960）。

## 二、P0：恢复 summon（已落地）

`lib/tools.js`：

- `restrictProbeFaces(ctx)` / `filterRestrictableTools(ctx, names, label)`：剔除召唤者 scope 视域面，只保留插件 ctx 全局视域面（schemas 无参枚举 / get 无参逐名探测）。单面判定语义不变：确证已注册→保留；确证未注册→剔除+warn；探测异常→保守保留；无探测缝→原样传递。
- `hostRestrictableNames(ctx)`：去掉 scope 参数，固定全局视域（无参调用在 dsh-tools 即全局视域，:3021/:2994）。
- `resolveProfileEffect(ctx, profile)` 与 summon 发射点：删除 scopeCtx/scope 透传。
- 真机效果：deny = 全局层确证的递归清单子集（= list_experts/summon_expert/summon_experts 三名）→ 宿主 restrict 校验通过，spawn 恢复。subagent/subagent_fork 的执法回落到宿主 maxDepth=1 深度熔断（2.9.3 真机实证有效；dsh-subagent lib/index.js:279-282 resolveChildDepth 抛 SubagentDepthError）。
- 附带加固：deny/allow 名单显式剔除 `run_code`（保留 PTC 传输名，restrict 对其直接抛错 :2903，且 PTC 非原生模式下它就在全局 visible 里 :2977，探测面会误确证）。

## 三、P1：workflow/ralph 旁路执法判定（已落地 allow）

任务给定判定条件逐项核对（全部有源码行号依据）：

| 核对项 | 结论 | 依据（dsh-tools lib/index.js） |
|---|---|---|
| allow 是否对全部可见工具生效 | **是**（inherited 全集；子代理 own 层豁免） | view():2968-2971 inherited 名须每个链上层 `admits()`；:2973-2976 own 层豁免——豁免恰好保住 dsh-subagent 装在 child own 层的结构化输出机制（view() 文档 :2944-2947 明言此契约） |
| preset 作用域工具是否被 allow 遮蔽 | **是** | generation 层工具属于 inherited，不在 allow → `admits()` 失败 → visible 不含 |
| allow 名单校验集是否=全局层 | **校验集=全局 ∪ generation（:2904/:2967-2970），⊆ 关系成立**：allow 从全局枚举面取（`hostRestrictableNames(ctx)` 全局视域）→ allow ⊆ 全局层 ⊆ 校验集 → restrict 必过；反方向（allow 含召唤者 own/更高层名）会重蹈 2.9.4 覆辙，已由枚举来源结构性排除 |
| 空 allow 语义坑 | **已防护** | `admits()` 对空 allow 集把全部 inherited 判为不可见（:2642-2645）；`buildRecursionAllowList` 求交后为空 → 返回 null，调用方退回 deny-only，绝不下发空 allow |

落地（`lib/tools.js` 新增 `buildRecursionAllowList(ctx)`）：宿主 `tools.schemas()` 全局枚举面可用 → `allow = 全局层注册名 − EXPERT_TOOLS_DENY_LIST − run_code`（动态枚举，未硬编码全集）；枚举面缺失/异常/求交为空 → null → deny-only（派生面执法由 maxDepth=1 兜底，不做假修复）。接线两处：无档案 summon 路径与 `resolveProfileEffect` 档案未配 tools.allow 路径（档案自带 allow 时 #19 白名单语义不变）；`isToolAvailable` 同步按 allow 判定，#17 persona 剪除联动。

行为代价（如实声明）：allow 是白名单语义，generation 层上不属于全局层的**全部**工具（含将来新增的 preset 级工具）对被召唤专家一并不可见——这正是「全通道不可见执法」的代价面；若某部署把专家必需的工具挂在 generation 层，需把它上移全局层或回落 deny-only。

## 四、改动清单

- `lib/tools.js`：文件头语义注记；EXPERT_TOOLS_DENY_LIST 执法语义注记；hostRestrictableNames/restrictProbeFaces/filterRestrictableTools 重写（全局单面 + run_code 防护）；新增 buildRecursionAllowList；resolveProfileEffect 与 summon 发射点接线。
- `test/tools.selftest.mjs`：重写 dsh-expert-293 T1/T2/降级三用例为 2.9.4 回炉语义（P0 主用例含「deny 全局名→spawn 通过」断言）；新增 buildRecursionAllowList 与 resolveProfileEffect P1 两用例；导入 buildRecursionAllowList。
- `docs/internal/dsh-expert-294-final-rework-report.md`：本报告。

## 五、npm test 摘录

```
ℹ tests 282        （基线 280：+2 = P0 现场钉死重写用例组、P1 两个新用例）
ℹ pass 281         （基线 279）
ℹ fail 0
ℹ skipped 1        （与基线一致）
```


## 六、编排者冒烟判据（可观察现象）

1. **P0 spawn 恢复**：编排者任一 summon（如 `summon_expert(expert: 后端工程师, task: ...)`）不再报 `tools.restrict() names unknown global tool "subagent"`；专家正常返回结果。
2. **deny 收窄可见**：宿主日志/console.warn 出现 `toolFilter deny 跳过宿主未注册的工具：subagent`（以及本部署不在全局层的其他派生名）——收窄是显式告警，不是静默。
3. **P1 全通道不可见**：向被召唤专家问「你当前可见工具清单里是否有 workflow / ralph / subagent / subagent_fork」，应答**均不可见**（2.9.3 冒烟时专家可见且实调 workflow 成功派生 depth-2，本版应变为调 workflow 即 UNKNOWN_TOOL/工具不存在）。
4. **P1 全局工具不误伤**：同一专家可见 bash/read/edit/glob/grep/web 等全局层工具与自身 persona（说明 allow 未遮蔽全局层与 own 层机制，专家仍能正常干活）。
5. **maxDepth 熔断仍在**（deny-only 降级路径的兜底验证）：若某部署无 schemas() 枚举面，专家尝试 `subagent` 派生应收到 `subagent depth 2 exceeds maxDepth 1`（dsh-subagent SubagentDepthError）。
6. **回归边界**：专家若被要求回报 toolFilter，deny 应恰为 3 名召唤工具（全局确证子集），allow 为全局枚举减递归清单——不再出现 7 名全量 deny。
