# capability-ab 握手 Smoke 报告 2 — adapter 缺口修复复跑（z0_env_smoke × baseline × 1 trial）
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **执行者**：DevOps 自动化师（coordinator 委派）
- **日期**：2026-10-19
- **前档**：`SMOKE-REPORT.md`（run 20261019-032141-h4qz，EXIT=1，`no adapter registered for provider "newapi"`）
- **范围**：恰 1 个复跑 trial（同前：scenarios=[z0_env_smoke]、candidates=[]、repeats=1）。排查全程零模型调用（boot 探针 + JSON-RPC initialize 探针均为纯本地/握手流量）。

## 结论一览

| 链路段 | 上次 | 本次 |
|---|---|---|
| runtime boot（client spawn dshBin） | OK | **OK** |
| llm-pi-ai entry 激活 / adapter 注册 | **FAIL**（YAML 键损坏） | **OK**（initialize 握手通过，缺口闭合） |
| JSON-RPC wire 传输 + initialize | OK（结构化错误） | **OK**（真实成功，无错误） |
| newapi HTTP 调用发出 | NOT EXERCISED | **EXERCISED**——请求真实到达 newapi 上游并返回语义化 400 + 上游 Request id（非 401 鉴权拒绝） |
| token 级 usage 证据 | 无 | **无**（请求在生成前被 400 拒绝，totals 全 0） |
| oracle 判分 | 机制 OK | 机制 OK（verdict 产出，全 FAIL——agent 零动作） |
| **端到端 smoke 判定** | FAIL（基建错误） | **PARTIAL——原 BLOCKER 已清除，新 BLOCKER 浮出（模型能力参数不匹配），预算耗尽停止** |

## 一、根因（本任务指派的缺口，源码级实锤）

**宿主有、eval 缺的那一环 = evalHome profile 文件里两处被 YAML 1.1 解析器损坏的 `reasoningEfforts.off` 键。**

1. 上次会话镜像宿主 profile rows 到 `evalHome/profiles/eval/cordis.patch.yml` 时用 YAML 1.1 schema 解析回写，宿主的裸 `off:` 键（js-yaml `JSON_SCHEMA` 下是字符串）变成布尔键 `false:`。
2. runtime 的 entry 校验（`dsh-app-boot/lib/index.js:33`，entryListSchema = js-yaml `JSON_SCHEMA` + `!!js` 扩展，`off` 不再是布尔别名）按字符串键校验 → `dsh-llm-pi-ai` 插件 zod ValidationError：
   `llm-pi-ai (@deepseek-ai/dsh-llm-pi-ai): ValidationError: invalid config: - $.providers.newapi.models[1].reasoningEfforts expected false | { [key: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"]: string | Schema<const> } but got {"false":"none","low":"low","high":"high","max":"max"}`
3. entry 未激活仅产生 warning（boot 继续，`create().catch(logger.error)` 吞错）→ 无 adapter 注册 → `dsh-sdk-jsonrpc-server/lib/index.js:127-130` initialize 的 `hasAdapterFor` 抛 `no adapter registered for provider "newapi"`。
4. 宿主不受影响：宿主 profile patch 用顶层 `- id: llm-pi-ai, config:` 行覆写 dsh-base bundle 的 dormant 行，键为原始 `off:`，JSON_SCHEMA 校验通过。重复 id（eval 用 insert: 追加）非阻塞——`cordis-plugin-loader/lib/index.js:69-82` EntryGroup.update 同 id 去重、last-wins；**键损坏才是根因**。

## 二、修复内容（配置级，边界内）

**文件**：`capability-ab-eval/.dsh-eval/home/profiles/eval/cordis.patch.yml`（仅 2 行）

| 行 | 修复前 | 修复后 | 对应模型 |
|---|---|---|---|
| :37 附近 | `false: none` | `off: none` | deepseek-v4-flash（models[1]） |
| :54 附近 | `false: null` | `off: null` | ark-code-latest（models[2]） |

未改：宿主打包产物、dsh-eval-infra/src、arms yml、client 版本——零越界。

**修复验证（零模型调用）**：
- boot 探针（宿主 dsh 0.2.1-rc.2 + `--profile eval --patch baseline.patch.yml --patch _base-network.patch.yml`）：修复前 stderr 有 `dsh: warning: 1 entry did not activate` + 上述 ValidationError；修复后仅剩无关的 expert-orchestrator typert-protocol 降级提示，EXIT=0。
- JSON-RPC initialize 探针（`.dsh-eval/tmp-probe-init.mjs`，用 eval-infra 同款 `DeepSeekHarness` 参数：profile eval、同两 patch、dshHome=evalHome、provider=newapi、model=glm-5.3-flash）：输出 `INITIALIZE_OK`，EXIT=0。**initialize 握手通过 = hasAdapterFor(newapi) 为真 = adapter 注册缺口闭合**。探针脚本留存于 `.dsh-eval/tmp-probe-init.mjs` 可复跑。

## 三、复跑 trial 记录

- **执行命令**（key 打码，同 SMOKE-REPORT.md 形态）：
  ```bash
  cd capability-ab-eval
  DEEPSEEK_API_KEY="$(python3 -c '...refs.DEEPSEEK_API_KEY...')" \
  NEWAPI_API_KEY="$(python3 -c '...refs.NEWAPI_API_KEY...')" \
  node ../dsh-eval-infra/lib/cli.js preflight baseline --scenario z0_env_smoke
  ```
- **CLI_EXIT = 0**（上次 1）。CLI 闸门：compose OK → mounted OK（2 rows）→ **runs OK**——"a runtime booted on this arm and finished z0_env_smoke in 3s for $0.0000 (the scenario itself did not pass, which is a scenario result, not a loading failure)"。
- **run id**：`20261019-035551-2vyq`（目录 `.dsh-eval/runs/20261019-035551-2vyq/`）
- **ledger**：`ledgers/z0_env_smoke/baseline/rep1.json`
  - `progress.json`: status=done, total=1, completed=1, failed=0, usd=0
  - provider=newapi, model=glm-5.3-flash, **resolvedEffort=null**, turns=1, steps=0, tools=26, wallMs=3037
  - **totals：hit=0, miss=0, output=0, reasoning=0, usd=0**（unpriced=true, usageProvenance=self-reported）
  - **verdict**：`{"ok": false, "detail": "FAILS: bash: probe output missing (bash tool did not execute); grep: wrong/missing file name; glob: wrong/missing count; edit: a.cfg not edited or b.cfg touched; read: wrong/missing line count"}`
- **events**（`rep1.events.jsonl`，30KB，上次 0 字节）：完整 turn 流——inbox splice → turn/start → step/start → system/user message → **request/header（provider=newapi, model=glm-5.3-flash, maxTokens=128000）** → request/context → **assistant/attempt（真实上游响应）** → turn/end。

## 四、鉴权行使证据（如实降级说明）

**token 级证据未取得**（totals 全 0），原因：请求在生成前被模型参数校验拒绝。但链路已被真实行使：

- 事件原文（rep1.events.jsonl seq=13/15）：
  `finish.reason.kind=error, failure.message="400: {\"message\":\"thinking.type `disabled` is not supported by this model Request id: 021792382154353c237340934591b89d6de6b6a9271c1b999cf05\",\"type\":\"BadRequest\",\"param\":\"\",\"code\":\"InvalidParameter\"}", code=INVALID_REQUEST`
- 判读：newapi 若鉴权失败会返回 401/403；实际返回**语义化 400 InvalidParameter + 上游 Request id**（0217… 为上游 bigmodel 风格请求号），说明请求已通过 newapi 鉴权并转发至上游、被上游参数校验拒绝。**key 注入 → runtime → baseURL → 上游的 HTTP 往返成立**；仅缺「生成成功后的 token 计量数字」。

## 五、新 BLOCKER 根因（源码级）

**glm-5.3-flash 拒绝 `thinking.type=disabled`，而 trial 请求注定携带 disabled：**

1. trial 请求不带 reasoningEffort（client initialize 只传 provider/model/maxTokens；`agent-default-model` 行的 `reasoningEffort: max` 仅在 client 未显式指定模型时生效——ledger `resolvedEffort=null` 实证）。
2. evalHome profile glm-5.3-flash 条目声明 `compat.thinkingFormat: zai` + `reasoningEfforts: {off: none, low: low, high: high, max: max}`。
3. 引擎 wire 构造 `@earendil-works/pi-ai/dist/api/openai-completions.js:625`：
   ```js
   if (compat.thinkingFormat === "zai" && model.reasoning) {
       zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
   ```
   **zai 分支不看 `thinkingLevelMap.off`**——无 effort 时无条件发 `thinking: {type:"disabled"}`。（对照：deepseek 格式 ：675 与 openrouter 格式会查 `model.thinkingLevelMap?.off !== null` 决定是否省略。）
4. 上游 glm-5.3-flash 不接受 disabled → 400。

**边界内的候选修复方向（供协调者决策，本次未执行、未烧 trial）**：
- A（最小改动）：evalHome profile glm-5.3-flash 条目 `reasoningEfforts: false` → `resolveModelReasoning` 返回 `{reasoning: false}`（dsh-llm-pi-ai/lib/index.js:588）→ zai 分支条件 `model.reasoning` 为假 → 完全不发 thinking 字段，由服务端默认。代价：该模型声明为非推理模型（smoke/A-A 场景无 effort 请求，无实际影响）。
- B：换 `thinkingFormat` 为发 thinking 与否受 off 映射控制的格式（如 openrouter 分支）——wire 方言变化，上游兼容性未知，风险高于 A。
- C：让 trial 请求携带显式 effort——需改 arms yml / eval-infra src / client 参数，**均在禁止边界内**，不可行。

## 六、A/A 与全矩阵点火前剩余风险清单（更新版）

1. **BLOCKER——thinking 参数不匹配（新）**：按第五节修复并复跑本 smoke 直到 ledger 出现真实 token 用量数字，才可点火更大规模。
2. **鉴权 token 级证据仍缺**：本次仅证明「请求可过 newapi 鉴权到达上游」；生成成功 + usage 计量仍无样本。
3. **计费护栏缺失**：glm-5.3-flash 在 pricing 表缺失（unpriced=true），`--max-usd` 对 unpriced 模型可能不生效；全矩阵成本仅能靠 trial 数量上限控制。
4. **trace 管线**：`rep1.trace.jsonl` 仍 0 字节（0 step trial 的合理表现，但正常 trial 的 trace 样本仍缺）。
5. **会话期协议**：initialize 之后 turn 流式/工具调用/shutdown 契约本次已覆盖到「turn 启动 + 请求发出 + 错误收敛」，但正常完成 turn 仍无样本。
6. **A/A 特有**：两臂同 provider 同 model，差异只能来自 overlay；修复后若两臂行为仍无差异需检查 overlay 生效性。

## 七、边界与预算遵守

- 未改任何源码、arms、client 版本；唯一写入 = evalHome profile 2 行（明示于第二节）+ 本报告 + 探针脚本 `.dsh-eval/tmp-probe-init.mjs`。
- 排查零模型调用（boot 探针 dummy key、initialize 探针纯握手）；复跑恰好 1 trial（20261019-035551-2vyq），失败即停，未迭代。
- key 零回显零落盘：仅运行时 inline 注入子进程 env，未写入任何文件、未出现于任何输出/报告/bus 消息。

## 八、完成定义对照（如实）

| 判定项 | 达成 |
|---|---|
| 复跑恰好 1 trial，产出 verdict + ledger | ✅ |
| adapter 注册缺口修复且 initialize 握手通过 | ✅ |
| 鉴权被真实行使——ledger 有 LLM 调用 token 用量记录 | ❌（HTTP 往返已行使、400 前终止、totals 全 0） |
| SMOKE-REPORT-2.md 落盘 / bus 已发 / key 零回显零落盘 | ✅ |

**结论**：指派根因（YAML 键损坏 → adapter 未注册）已修复并经握手验证；复跑暴露下一链路 BLOCKER（thinking 参数不匹配）。按「复跑仍失败即停止」纪律停止，待协调者决策第五节修复方向后再点火。
