# capability-ab 握手 Smoke 报告 — z0_env_smoke × baseline × 1 trial
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **执行者**：DevOps 自动化师（coordinator 委派）
- **日期**：2026-10-19
- **范围**：恰 1 个 trial（非 dry preflight 机制：scenarios=[z0_env_smoke]、candidates=[]、repeats=1）。未跑任何其他场景、无 A/A、无全矩阵。
- **目标**：验证 client 0.1.2-rc.1 ↔ 宿主 dsh 0.2.1-rc.2 的 JSON-RPC wire 握手 + newapi/glm-5.3-flash 鉴权 + oracle 判分链路端到端。

## 结论一览

| 链路段 | 结论 |
|---|---|
| runtime boot（client spawn dshBin） | **OK** |
| JSON-RPC wire 传输 + initialize 请求-响应往返 | **OK**（结构化错误正常返回，无协议/传输层错误） |
| newapi/glm-5.3-flash 鉴权 | **NOT EXERCISED**（在 adapter 注册关前终止，未发起任何 LLM API 调用） |
| oracle 判分链路 | **机制 OK**（verdict 产出 + ledger 落盘）；trial 结果全 FAIL（agent 零动作） |
| **端到端 smoke 判定** | **FAIL（基建错误）** |
| 硬闸门（版本接缝停止条件） | **未触发**——已源码级排除版本接缝（见下），未改装 client、未做任何变通 |

## 实际执行命令（key 打码）

```bash
cd capability-ab-eval

DEEPSEEK_API_KEY="$(python3 -c 'import yaml;print(yaml.safe_load(open("/vol2/@appshare/Harness/.dsh/.credentials.yaml"))["refs"]["DEEPSEEK_API_KEY"])')" \
NEWAPI_API_KEY="$(python3 -c 'import yaml;print(yaml.safe_load(open("/vol2/@appshare/Harness/.dsh/.credentials.yaml"))["refs"]["NEWAPI_API_KEY"])')" \
node ../dsh-eval-infra/lib/cli.js preflight baseline --scenario z0_env_smoke
```

- 上行为**打码示意**（结构忠实）：两个 key 经 python3+yaml 从宿主 `.credentials.yaml` refs 运行时读取、同一 bash 命令内 inline 注入子进程 env；**key 值零回显、零落盘**，不存在于任何输出/文件/bus 消息。
- CLI 前段输出：compose OK（0 variable）→ mounted OK（2 rows：llm-pi-ai、agent-default-model）→ runs **FAIL**。
- **CLI_EXIT = 1**。

## Trial 结果

- **run id**：`20261019-032141-h4qz`
- **run 目录**：`capability-ab-eval/.dsh-eval/runs/20261019-032141-h4qz/`
- **ledger**：`capability-ab-eval/.dsh-eval/runs/20261019-032141-h4qz/ledgers/z0_env_smoke/baseline/rep1.json`
- **progress.json**：`status=done, total=1, completed=1, failed=1, usd=0`
- **错误原文**：`no adapter registered for provider "newapi"`
- **verdict 原文**：
  ```json
  {"ok": false, "detail": "FAILS: bash: probe output missing (bash tool did not execute); grep: wrong/missing file name; glob: wrong/missing count; edit: a.cfg not edited or b.cfg touched; read: wrong/missing line count"}
  ```
- **turns/usage**：`turns=[]`、`steps=[]`、`tools=[]`、`totals` 全 0（hit/miss/output/reasoning/usd=0）、`wallMs=2999`、`unpriced=true`、`usageProvenance={source: "self-reported"}`
- **events/trace**：`rep1.events.jsonl`、`rep1.trace.jsonl` 均 0 字节（agent 未启动，无事件流）
- **workdir**：`capability-ab-eval/.dsh-eval/work/dsh-eval-z0_env_smoke-baseline-Wk6Mmc`（场景物料 setup.py 产出正常：a.cfg/b.cfg/c.cfg/data/tools_probe.py）
- **trial 覆盖层**：`runs/20261019-032141-h4qz/arms/baseline.patch.yml`（agent-preset 注入）、`_base-network.patch.yml`（telemetry/title-llm disabled）——均不含 provider 配置（provider 来自 client initialize 参数）。

## wire 握手与鉴权结论

- **wire 握手：OK**。证据链：client（`dsh-eval-infra/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js:163-194` resolveDshLaunch）spawn `node <dshBin> --profile eval --patch <overlay...>` 且 `DSH_HOME=evalHome` → runtime 正常 boot（未触发 fail-loud）→ initialize 载荷 `{cwd, provider:"newapi", model:"glm-5.3-flash"}`（client :634-667）成功送达并被服务端处理 → 服务端返回**结构化 JSON-RPC 错误**（语义拒绝，非协议错误）。传输层与请求-响应契约已验证。
- **鉴权：FAIL（准确说：NOT EXERCISED）**。错误发生在服务端 LLM adapter 查找阶段，先于任何 HTTP 鉴权调用；NEWAPI_API_KEY 注入路径、baseURL（http://<NEWAPI_LAN_HOST>:3000/v1）连通性、glm-5.3-flash 可用性**均未获得任何验证信号**。

## 根因（源码级，已核实）

1. **SDK initialize 的 provider 白名单硬编码**：`/vol2/@appdata/Harness/server/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js:127-130`
   ```js
   if (!this.hasAdapterFor(provider)) {
       if (provider !== "deepseek-official") throw new Error(`no adapter registered for provider "${provider}"`);
       this.llmFiber = await this.ctx.plugin(LlmDeepSeek);
   }
   ```
   非 `deepseek-official` 的 provider 必须在 initialize 时已有已注册 adapter。
2. `hasAdapterFor`（同文件 :341-343）= `ctx.get("llm")?.listProviders().some(entry => entry.id === provider)`——eval SDK boot 的 llm 服务 provider 列表里没有 `newapi`。
3. adapter 注册唯一入口 `ctx.llm.registerAdapter(providers, adapter)`（`dsh-llm/lib/index.js:1842`）；`dsh-llm/lib/index.js:2264` 有同文案 NO_ADAPTER 错误。全 node_modules grep 无任何包按名引用 `dsh-llm-pi-ai`——插件加载只走 composed 树 row 的 `name` 字段。
4. **row 在树里、插件已加载，但 adapter 未注册**：`dsh/lib/profile-boot-C14i-8IN.js` 确认所有 surface（含 SDK）都叠 bundles + profile `cordis.patch.yml` + `--patch` overlays 且 fail-loud——boot 未炸说明 llm-pi-ai row 加载未失败；但 `listProviders()` 无 newapi。eval profile bundles 仅 3 包（dsh-base、dsh-sdk-app、dsh-expert-orchestrator）；宿主 web profile bundles 同样不含 dsh-llm-pi-ai 但宿主 newapi 可用。**宿主与 eval SDK boot 在 adapter 注册机制上的确切差异未定位**（grep dsh-web-app 与 dsh 主包 lib 均无 pi-ai 引用，排除「web-app 显式实例化」假设）——此为移交协调者的核心未解问题。

### 已排除假设
- ~~版本接缝 client 0.1.2-rc.1 ↔ server 0.2.1-rc.2~~：错误由服务端 adapter 注册态决定，与 client 版本无关；**换 client 0.2.1-rc.2 不会修复此错**（JSON-RPC 往返本身已成功）。
- ~~compose/mounted 层配置缺失~~：dump-config EXIT=0、mounted OK(2 rows)、宿主 llm-pi-ai row 与 eval 镜像结构一致。
- ~~场景物料/判分器问题~~：workdir 物料完整，oracle 正常执行并产出 verdict。

## 硬闸门判定说明

initialize() 虽返回错误，但触发原因是**服务端 provider-adapter 注册缺失**，非版本接缝（闸门括号条件「版本接缝 client 0.1.2-rc.1 ↔ 宿主 dsh 0.2.1-rc.2 不兼容」不成立，已源码级验证）。按闸门意图执行：**未改装 client、未做任何变通**；run 尝试就此停止（恰好 1 trial 约束已耗尽），交协调者决策。

## A/A 与全矩阵点火前剩余风险清单

1. **BLOCKER——newapi adapter 注册缺失**：必须先定位宿主/SDK boot 注册机制差异并修复 eval 侧（可能涉及 profile bundles 或注册触发条件，超出本任务写入边界），然后**重跑本 smoke 直到鉴权真正被行使**，才可点火更大规模。
2. **鉴权链路零验证**：key 注入→runtime→baseURL→模型的完整路径无任何成功信号；首次真实 trial 可能暴露新的鉴权/网络错误。
3. **计费护栏缺失**：glm-5.3-flash 在 pricing 表缺失（unpriced=true，totals.usd 恒 0），`--max-usd` 对 unpriced 模型可能不生效；全矩阵成本仅能靠 trial 数量上限控制。
4. **trace/events 管线未验证**：本次 0 字节是失败 trial 的合理表现，但正常 agent trial 的 trace 产出格式与落盘规模尚无样本。
5. **会话期协议未验证**：client 0.1.2-rc.1 ↔ server 0.2.1-rc.2 的 initialize 之后链路（turn 流式、工具调用、shutdown 契约）无任何覆盖。
6. **A/A 特有风险**：两臂同 provider 同 model，一切差异只能来自 overlay（本次 baseline.patch.yml 仅注入 agent-preset）；若修复后两臂行为仍无差异，需检查 overlay 是否真正生效。

## 边界遵守

- 未改任何源码、arms、profile、client 版本；写入仅限 run 产物（runs/、work/、tmp-arms）与本报告。
- key 零回显零落盘：仅运行时 inline 注入子进程 env，未写入任何文件（含 shell history 规避）、未出现在任何输出/报告/bus 消息。
- 恰 1 个 trial：`20261019-032141-h4qz`，无其他场景/A-A/全矩阵点火。
