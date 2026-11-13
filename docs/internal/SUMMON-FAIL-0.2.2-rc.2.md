# 调查报告：summon 通道发射失败（Cannot read properties of undefined (reading 'id')）

日期：2026-11-13 ｜ 性质：只读调查，未做任何代码修改 ｜ 环境：插件 dsh-expert-orchestrator 2.14.1 @ 宿主 DSH 0.2.2-rc.2

## 结论（一句话）

**宿主 0.2.2-rc.2 升级引入的 API 契约变化与插件 2.14.1 summon 发射形状不匹配**：宿主 `startActivation(spec)` 要求 `parent`/`prompt` 等**平铺在 spec 顶层**，而插件把整个 `request`（含 `parent`）**嵌套传递**，宿主读 `spec.parent.id` 时 `spec.parent === undefined` → TypeError，与两位专家报错逐字吻合。

## 证据链

1. **失败现场**（会话 session-6f2d479c，2026-11-13 07:25，评审编排会话）：
   - `summon_experts` 召唤「代码审查员」+「安全工程师」（均 readOnly），两位逐项报 `失败（Cannot read properties of undefined (reading 'id')`，isError=false，确定性复现。
   - 编排者按协议回退 `subagent` 工具成功派出（reviewer-ef3b962 / sec-reviewer-ef3b962）——subagent 通道正常，仅 summon 发射路径崩。
   - 宿主顶层日志（harness.log / info.log）无该报错，证据仅存于会话 transcript。

2. **宿主真实契约**（实读 /vol2/@appdata/Harness/server/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-subagent/）：
   - `lib/index.js:3018-3022`：`startActivation(spec)` 开头即 `if (this.ctx.get("agents")?.get(spec.parent.id) !== spec.parent) throw SubagentError(...)` —— 读 **spec.parent**。
   - `lib/index.js:1478 startLocal(spec)`：读 `spec.prompt` / `spec.agentPreset` / `spec.agentOptions` —— 全部 **spec 顶层**。
   - `lib/types/types.d.ts:23`：`SubagentActivationSpec extends Omit<SubagentStartRequest, 'label'|'signal'>`；`SubagentStartRequest` 顶层字段 = cwd / agentPreset / label / prompt / **parent** / agentOptions / outputSchema / signal。
   - rc.2 运行时已**删除**旧 API `start(provider, request)` 与 `startContinuable`（grep 0 命中）。
   - 宿主自带 subagent 工具（dsh-tool-subagent/lib/index.js:470-481）的正确用法实证：组好 `request={cwd?, prompt, parent, agentPreset?, agentOptions?, maxDepth?}` 后 **`...request` 展开到 spec 顶层**再传 `startActivation({provider, label, ...request, signal, delivery:"parent"})`。

3. **插件错形**（lib/tools.js，两处发射路径同病）：
   - `runExpertContinuable`（~1648-1657）：`seam.startContinuable({provider, label, request:{prompt, parent: exec.agent, ...personaKeys, ...}, signal})` —— parent 嵌在 `request` 内。
   - `runExpertOneShot` activation 分支（~1593-1606）：同样 `request:{...}` 嵌套。
   - `activationDispatch`（tools.js:1374，`!hasLegacyStart && typeof subagents?.startActivation === 'function'`）在 rc.2 上恒 true——两路（continuable / one-shot）全走 activation 轨，全炸。

4. **为什么升级才炸**（时间线）：
   - 旧宿主（≤0.2.2-alpha.x）有 `start(provider, request)`：第二参数就是 request 对象，parent 嵌套正确；transcript 实证 11-11、11-08、10-30 等多会话 summon 成功（「召唤结果：… 完成」）。
   - 宿主 2026-11-12 19:32 升级启动 0.2.2-rc.2（harness.log `dsh started pid=161532`）；11-13 07:25 的失败 summon 是升级后**首次** summon。
   - 插件 `detectResumeSeam`（tools.js:1019-1078）在 rc.2 上 legacy 面全消失 → 走 activation 轨，但沿用了 alpha.2 时代按宿主升级指南适配的嵌套形状（插件注释「宿主 :3032/:3068 实证」为旧版行号）。
   - 注意：宿主 rc.2 升级指南（docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md）示例本身也写嵌套 `request:{parent,...}` —— **指南与 rc.2 运行时实际读法（顶层）自相矛盾**，插件系按该指南适配。

5. **已排除的非因**：
   - provider='spawn'（dsh-subagent-spawn-in-process/lib/index.js:31 `prepareContinuable()` 返回 `Promise.resolve({})`，capabilities 全 true）——provider 面无问题。
   - 插件结算观察器 `createSettlementWatcher` 有 info.id 空值守卫；autoClaim / budget / 锁面均 fail-open；`.id` 直取不在插件 grep 面。
   - auto-claim 提示行（「任务 T1、T5 未自动认领」）是任务书里 T1–T5 字样被误解析，fail-open 无害，与崩溃无关。

## 修复方向（待批准，未动手）

lib/tools.js 两处发射形状改为**顶层平铺**：

```js
// 现（错）：request: { prompt, parent: exec.agent, ...personaKeys, ...agentOptions }
// 改（对）：
await ctx.subagents.startActivation({
  provider,
  label,
  prompt,                       // ContentBlock[]
  parent: exec.agent,
  ...personaKeys,               // agentPreset / agentOptions 等
  ...(agentOptions ? { agentOptions } : {}),
  signal,
  delivery: /* one-shot await run.result 宜 'caller'；continuable 走结算观察器，delivery 语义需再核 */
});
```

- `sendMessage(sender, targetId, content, options)` / `interrupt(targetSessionId, authority)` 签名与宿主匹配，无需改。
- 上游问题：宿主升级指南文档与 rc.2 运行时矛盾，建议向上游反馈。
- 风险点：continuable 轨的 `delivery` 取值需对照宿主 manager 语义再核（one-shot 要 await result，'caller' 不发完成通知）。

## 附：关键文件与行号

- 宿主运行时：`/vol2/@appdata/Harness/server/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-subagent/lib/index.js:3018-3022`（startActivation、spec.parent.id 崩点）、`:1478`（startLocal 读 spec 顶层）
- 宿主类型：`.../dsh-subagent/lib/types/types.d.ts:23`（SubagentActivationSpec）
- 宿主正确用法范例：`.../dsh-tool-subagent/lib/index.js:470-481`
- 插件错形：`lib/tools.js:1374`（activationDispatch）、`~1593-1606`（one-shot）、`~1648-1657`（continuable）、`:1019-1078`（detectResumeSeam）
- 失败会话：`/vol2/@appshare/Harness/.dsh/sessions/<workspace-slug>/session-6f2d479c-c186-492e-b9c6-e38e7239c40c/`（seq78 报错全文）
- 升级指南矛盾点：`/vol2/@appdata/Harness/server/0.2.2-rc.2/node_modules/@deepseek-ai/dsh/docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md`（示例嵌套 request）
