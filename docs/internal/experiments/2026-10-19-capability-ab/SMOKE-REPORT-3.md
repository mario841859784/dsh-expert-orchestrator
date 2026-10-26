# capability-ab 握手 Smoke 报告 3 — 方案 B（agent-default-model 补 effort）复跑：前提证伪，BLOCKER 未闭合
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **执行者**：DevOps 自动化师（coordinator 委派）
- **日期**：2026-10-19
- **前档**：SMOKE-REPORT-2.md（run 20261019-035551-2vyq：adapter 缺口已闭合、鉴权已通、剩 `thinking.type=disabled` 400）与 SMOKE-REPORT.md（命令形态、run 目录结构）
- **指派方案 B**：evalHome profile 的 agent-default-model 行补 `reasoningEffort: max`，使 trial 请求带 effort、走 zai 分支 enabled 路径
- **范围**：恰 1 个复跑 trial（z0_env_smoke × baseline × repeats 1），run id **20261019-055102-1mrp**

## 结论一览

| 判定项 | 结果 |
|---|---|
| 方案 B 第 1 步（profile 行补 effort） | **改前即已满足——目标行本就存在且逐字镜像宿主，本任务对该文件零写入** |
| 复跑恰 1 trial / CLI_EXIT=0 / verdict+ledger 落盘 | ✅（run 20261019-055102-1mrp，EXIT=0） |
| ledger 出现真实 token 用量（totals>0） | ❌ **totals 全 0**——400 原样复现，生成前被拒 |
| zai enabled 路径生效证据（请求不带 disabled） | ❌ **不存在**——header 仍无 reasoningEffort，仍走 disabled 分支 |
| **端到端 smoke 判定** | **FAIL——方案 B 的前提与机制双重不成立（下述源码级+实证），BLOCKER 未闭合，按「失败即停」纪律停止** |

## 一、改动 diff：宿主行 vs evalHome 行（改前/改后）

**关键事实：evalHome 目标行在改前就已存在，与本任务执行前一致——无「补」可做，未做任何写入。**

宿主 `/vol2/@appshare/Harness/.dsh/profiles/web/cordis.patch.yml:65-70`：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: newapi
    model: glm-5.3-flash
    reasoningEffort: max
```

evalHome `capability-ab-eval/.dsh-eval/home/profiles/eval/cordis.patch.yml:63-68`（改前 = 改后，逐字段一致；缩进差异源于其行嵌套在顶层 `insert:` 下，单双引号为等价 YAML）：

```yaml
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: newapi
        model: glm-5.3-flash
        reasoningEffort: max
```

**时间线实证**：该文件 mtime=2026-10-19 11:51:46（前会话 YAML 键修复写入），run 2vyq 启动于 11:55:51（run id 时间戳为 UTC：035551Z=本地 11:55:51+0800；progress.startedAt=05:51:02.220Z 同理）——即 **run 2vyq 时该行已带 `reasoningEffort: max`，而 2vyq ledger resolvedEffort=null、header 无 effort**。方案 B 隐含前提「行缺失导致 trial 不带 effort」与事实不符。

**镜像一致性复核**：id/name/provider/model/reasoningEffort 五字段与宿主逐字一致；`max` 为裸词字符串（YAML 1.1 布尔词表不含 max，无键损坏风险）。本任务对该文件**零写入**（写相同内容只会制造无意义的 mtime 变化）。

## 二、复跑 trial 记录（恰 1 次，失败即停）

- **执行命令**（key 打码，同前档形态；两 key 从宿主 `.credentials.yaml` refs 运行时读取、同一 bash 命令 inline 注入，**key 值零回显零落盘**）：
  ```bash
  cd capability-ab-eval
  DEEPSEEK_API_KEY="$(python3 -c '...refs.DEEPSEEK_API_KEY...')" \
  NEWAPI_API_KEY="$(python3 -c '...refs.NEWAPI_API_KEY...')" \
  node ../dsh-eval-infra/lib/cli.js preflight baseline --scenario z0_env_smoke
  ```
- **CLI_EXIT = 0**；闸门：compose OK → mounted OK（2 rows）→ runs OK（scenario result 层面）。
- **run id**：`20261019-055102-1mrp`（目录 `.dsh-eval/runs/20261019-055102-1mrp/`；runs/ 下本次仅新增此 1 个 run，恰 1 trial 无迭代）
- **ledger**（`ledgers/z0_env_smoke/baseline/rep1.json`）：
  - provider=newapi, model=glm-5.3-flash, **resolvedEffort=null**, turns=1, steps=0, tools=26, wallMs=3190
  - **totals：hit=0, miss=0, output=0, reasoning=0, usd=0**（unpriced=true, usageProvenance=self-reported）
  - **verdict**：`{"ok": false, "detail": "FAILS: bash: probe output missing (bash tool did not execute); grep: wrong/missing file name; glob: wrong/missing count; edit: a.cfg not edited or b.cfg touched; read: wrong/missing line count"}`（与 2vyq 完全同文——agent 零动作）
- **错误原文**（rep1.events.jsonl seq=13/15，与 2vyq 同文案、新上游 Request id）：
  `finish.reason.kind=error … "400: {\"message\":\"thinking.type `disabled` is not supported by this model Request id: 021792389064969e4d5e3acd6b6d5c09c835e2d36b9596cab0ffa\",\"type\":\"BadRequest\",\"param\":\"\",\"code\":\"InvalidParameter\"}", code=INVALID_REQUEST`

## 三、zai enabled 路径生效证据：不存在（判据如实呈现）

**判据应为**：request/header 事件的 `config.reasoningEffort` 非空，且 pi-ai `openai-completions.js:625` 三元式走 `{type:"enabled", clear_thinking:false}` 分支、400 消失、totals>0。

**实测判据（本次 run，seq=10）**：

```json
{"type":"request/header","seq":10,…,"data":{"header":{"config":{"provider":"newapi","model":"glm-5.3-flash","maxTokens":128000},…
```

`config` 仅 3 字段，**无 reasoningEffort** → pi-ai（宿主 0.2.1-rc.2 node_modules，唯一含 zai 分支的副本，zai@623）`:625` `options?.reasoningEffort` 为 falsy → 发送 `{type:"disabled"}` → glm-5.3-flash 400。enabled 路径未被行使。

## 四、根因（源码级）：agent-default-model 行的 effort 在 SDK trial 路径不可达

1. **插件消费面**：`AgentDefaultModelConfig.currentSelection()` 全仓消费方仅 `dsh-api-session-controller/lib/index.js:285,528,563,882`（web HTTP 会话）与 `dsh-headless/lib/index.js:303`——**不含 SDK jsonrpc 路径**。
2. **SDK server 只认 client initialize params**：`dsh-sdk-jsonrpc-server/lib/index.js:121-126` 从 `params.reasoningEffort` 取值（无任何 profile/settings 回退），`:140` 存 `this.reasoningEffort`，`:320-326 createSession` 的 agentOptions 仅在非空时携带 effort。
3. **trial 请求的唯一 effort 入口在 arm 定义**：`dsh-eval-infra/lib/core/sdk-driver.js:38` `if (arm.effort !== undefined) opts['reasoningEffort'] = arm.effort;` → client `dsh-sdk-client/lib/index.js:636,667`（initialize 载荷）→ server `:126,:140,:324` → agentOptions → header `config.reasoningEffort`（eval-infra `lib/core/ledger.js:159`）→ pi-ai `:625` enabled 分支。**而 `bench/arms/baseline.yml` 无 `effort` 字段**（expert.yml 亦无）。
4. **双重不成立的闭环**：行已在（第一节时间线）+ 行不达请求（上述 1-3）⇒ 无论该行在否，trial 请求都不带 effort。run 2vyq 与本次 run 1mrp 的 header/400 完全同构即为实证。

## 五、A/A 点火前剩余风险清单（如实：非空，仅 1 条 BLOCKER + 2 条边界内修复路径）

1. **BLOCKER（唯一阻断项，未变）**：trial 请求注定携带 `thinking.type=disabled` → glm-5.3-flash 400 → 零生成零 token。点火任何规模前必须先闭合。**边界内修复路径二选一，供协调者决策（本任务均未执行、未越界）**：
   - **路径甲（profile 级，改 evalHome 1 处，与本次写入边界同性质）**：glm-5.3-flash 模型条目 `reasoningEfforts` 改为 `false`——机制已源码复核：`dsh-llm-pi-ai/lib/index.js:587` `if (efforts === false) return { reasoning: false };` → pi-ai `:623` 条件 `model.reasoning` 为假 → zai 分支整体跳过、**不发 thinking 字段**（服务端默认）。代价：该模型声明为非推理模型（smoke/A-A 无 effort 请求，无实际影响）。
   - **路径乙（arm 级，需协调者解除 arms 禁令）**：`bench/arms/baseline.yml`（及后续各臂）增加 `effort: max` 一行——直接命中 sdk-driver.js:38 唯一入口，trial 请求带 effort 走 enabled 路径，且使 A/A 处于「推理开启」的更真实工况。
2. **次级观察项（非阻断）**：glm-5.3-flash unpriced（totals.usd 恒 0），成本护栏仅能靠 trial 数上限；trace 管线在 0-step trial 下仍无样本；正常完成 turn（含工具调用+shutdown）尚无样本。
3. A/A 特有：两臂同 provider/model，差异只能来自 overlay——修复后若仍无差异需查 overlay 生效性。

## 六、边界与预算遵守

- 恰 1 次复跑（20261019-055102-1mrp），失败即停，零迭代、零模型侧额外调用。
- 写入仅限：本报告 + run 产物。**evalHome profile 文件本任务零写入**（目标行改前即存在，见第一节）；未改源码/arms/宿主产物/client 版本/其他场景。
- key 零回显零落盘：仅运行时 inline 注入子进程 env；未写入任何文件，未出现于任何输出/报告/bus 消息。

## 七、完成定义对照（如实）

| 判定项 | 达成 |
|---|---|
| 复跑恰 1 trial，CLI_EXIT=0，verdict+ledger 落盘 | ✅ |
| ledger 出现真实 token 用量（totals>0） | ❌（400 前终止，totals 全 0） |
| SMOKE-REPORT-3.md 落盘 / bus 已发 / key 零回显零落盘 | ✅ |
| 方案 B 使 trial 请求带 effort | ❌（前提证伪：行已存在且在 SDK 路径不可达） |

**结论**：方案 B 经源码级+双 run 实证证伪——agent-default-model 行的 `reasoningEffort: max` 在 evalHome 早已存在、且该行 effort 根本不进入 SDK trial 请求（唯一入口是 arm.effort）。BLOCKER（thinking disabled 400）未闭合。请协调者在第五节两条边界内路径（甲：profile `reasoningEfforts: false`；乙：arm `effort: max`，需解禁 arms）中裁决后，再行第 4 次 smoke 复跑。
