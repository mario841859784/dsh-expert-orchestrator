# capability-ab 握手 Smoke 报告 5 — expert 臂实跑：boot 链贯通，preset 变量在 trial 路径零可辨差异
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **执行者**：DevOps 自动化师（coordinator 委派）
- **日期**：2026-10-19
- **前档**：SMOKE-REPORT-4.md（baseline 臂 PASS 全证据，run 20261019-060008-llpf）、SMOKE-REPORT-3.md、ROUTE-B-SETUP.md（双臂/evalHome/鉴权全景）
- **任务**：expert 臂最小 smoke——恰 1 trial（z0_env_smoke × **expert 臂** × repeats 1），验证 expert-orchestrator preset boot 链在 trial runtime 端到端跑通

## 结论一览

| 判定项 | 结果 |
|---|---|
| 恰 1 trial / CLI_EXIT=0 / verdict+ledger 落盘 | ✅ run **20261019-102731-3cym**（runs/ 计数 4→5，本次仅新增此 1 个） |
| ledger totals>0（真实 token 用量） | ✅ **miss=29874, output=1036**（hit=0, reasoning=0, usd=0/unpriced） |
| verdict | ✅ **`{"ok": true, "detail": "env probe ok"}`**，progress done/completed=1/failed=0 |
| expert 臂 boot 链（compose→mounted→runs 三闸） | ✅ `compose: ok · 1 variable(s)` → `mounted: ok`（2 rows，均两臂共享）→ `runs: ok`，`expert loads and runs` |
| effort=max 在 expert 臂生效 | ✅ header `config.reasoningEffort="max"`＋resolvedEffort=max＋4/4 assistant 带 reasoning 块＋零 disabled/零 400 |
| **观察① preset 注入生效证据** | ⚠️ **不可辨**——两臂 systemPrompt 逐字节相同（唯一差异 message UUID）、工具面 26 个逐字一致；preset 变量在单 turn SDK trial 路径无行为出口（详见第三节） |
| **端到端 smoke 判定** | **PASS——expert 臂 boot 链实跑证据补齐；但 preset 变量零差异升格为 A/A 点火前首要风险** |

## 一、trial 记录（恰 1 次）

- **执行命令**（key 打码，同前档形态；DEEPSEEK_API_KEY 与 NEWAPI_API_KEY 从宿主 `/vol2/@appshare/Harness/.dsh/.credentials.yaml` refs 运行时读取、同一 bash 命令 inline 注入，**key 值零回显零落盘**）：
  ```bash
  cd capability-ab-eval
  DEEPSEEK_API_KEY="$(python3 -c '...refs.DEEPSEEK_API_KEY...')" \
  NEWAPI_API_KEY="$(python3 -c '...refs.NEWAPI_API_KEY...')" \
  node ../dsh-eval-infra/lib/cli.js preflight expert --scenario z0_env_smoke
  ```
- **CLI 输出全文**：`compose: ok · 1 variable(s)` → `mounted: ok` → `✓ z0_env_smoke/expert#1 · $0.0000 · 4 steps · 36s` → 三闸 `OK compose/mounted/runs` → `row agent-preset-registry: mounted · ALSO in the baseline…`、`row preset-standard: mounted · ALSO…` → `~ row agent-preset-registry: config` → `tools available to the agent: 26` → **`expert loads and runs`**；**CLI_EXIT=0**。
  （`1 variable(s)` 与 REPORT-4 的 `0 variable(s)` 并非不一致：preflight 以 baseline 臂为参照，跑 baseline 时 diff 为空、跑 expert 时恰 1 变量，两侧与 `diff` 输出 `~ row agent-preset-registry: config` 同源。）
- **run id**：`20261019-102731-3cym`（目录 `.dsh-eval/runs/20261019-102731-3cym/`；plan.json：baseline.name=expert、candidates=[]、label=`preflight:expert`、repeats=1——preflight 机制即以被测臂作 plan baseline 单臂跑，REPORT-4 的 baseline 臂 run 同构）。
- **ledger**（`ledgers/z0_env_smoke/expert/rep1.json`）：provider=newapi, model=glm-5.3-flash, resolvedEffort=max, turns=1（end=completed）, steps=4, wallMs=36073。
- **steps 证据**：4 步 11 次真实工具调用，形态与 baseline 臂逐位同构——step1 bash(`python3 tools_probe.py`)+grep(needle-xq91)+glob(*.cfg)+read+read；step2 write×4（answers/probe.md、grep.md、glob.md、lines.md）+edit(a.cfg alpha=1→2)；step3 read 复核；step4 收尾文本 519 字符。reasoningChars=977/492/157/197。

## 二、与 baseline 臂对比（观察② token、观察③ wall time）

| 指标 | expert（20261019-102731-3cym） | baseline（20261019-060008-llpf） | Δ |
|---|---|---|---|
| totals.miss | **29874** | **29825** | +49（+0.16%） |
| totals.output | **1036** | **1711** | −675（−39.5%） |
| totals.hit / reasoning / usd | 0 / 0 / 0（unpriced） | 0 / 0 / 0（unpriced） | 同 |
| steps / 工具调用数 | 4 / 11 | 4 / 11 | 0 |
| reasoningChars 合计 | 1823（977+492+157+197） | 4184（3157+768+215+44） | −2361 |
| turn wallMs | **35913**（ledger 顶层 36073；progress 36073） | 75796（ledger 顶层 75970） | **−52%** |
| verdict | ok=true "env probe ok" | ok=true "env probe ok" | 同 |
| 工具面 | 26 个 | 26 个 | 0 |

- **miss 几乎相同（+49）**与第三节「两臂 systemPrompt/工具面逐字一致」互证：前缀内容同构，差异仅会话/工作目录元数据（本次 workdir `dsh-eval-z0_env_smoke-expert-U1Ot4s`）。
- **output/wall 差异是单样本噪声级**：两臂 prompt 同构、步态同构，−39.5% output 与 −52% wall 不能归因于臂变量（模型侧延迟/生成长度波动）；A/A 排期仍按慢界 ~76s 估算。

## 三、观察①：preset 注入生效证据——**不可辨**（本报告最重要发现）

**实测（两 run events 全量比对，事件类型分布逐类一致：15 类同数）**：

1. **systemPrompt 逐字节相同**：`system/message`（seq=7）message.content 两臂均为 2804 字符、difflib 零差异段；payload sha1 差异仅来自 message.id（UUID，易变字段）。step/turn/source/role 全同。
2. **两臂 system 均含 expert-orchestrator 痕迹**：`## 专家召唤模式（expert-orchestrator）` 段在 **baseline 臂同样存在**。注入源为 plugin 的 profile 级无条件注入——`dsh-expert-orchestrator/lib/tools.js:1868`（该文本在 evalHome 任何文件中 grep 零命中），非 preset 变量所致。plugin 在两臂均 profile 级激活（`bench/arms/baseline.yml` 头注与 ROUTE-B §2 设计如此）。
3. **工具面逐字一致**：request/header（seq=10）tools 数组 26 个，名称+schema+description 逐条 diff 零差异（含 summon_expert/summon_experts/list_experts/subagent/workflow 等）；config（provider/model/reasoningEffort=max/maxTokens）与 adapterDefaults 亦逐字一致。
4. **request/context 两臂同 sha1**（74 字符）。
5. **组合树内唯一差异确实存在**：CLI diff `~ row agent-preset-registry: config`（expert 侧 config.default=expert-orchestrator vs baseline 侧 standard）——**变量已正确进入组合树，但在 turn 行为面无任何事件级体现**。

**机制解释（源码级，全部只读）**：registry `defaultId = config.selectedDefault ?? config.default`（`@deepseek-ai/dsh-agent-preset-registry/lib/index.js:463-464`），但其消费面在 SDK trial boot 路径为零——`dsh` core、`dsh-sdk-jsonrpc-server`、`dsh-headless`、`dsh-api-session-controller/lib`、`dsh-tool-subagent/lib` 的 lib 代码 grep `defaultId/resolvePreset/presetRegistry` 均**零命中**（仅 package.json 依赖声明与 client-UI/inventory 包引用）。即 preset-registry default 是 web 会话控制器侧设置，SDK 单 turn trial 不经它组会话。

**定性**：expert 臂 preset boot 链「装载不报错、trial 能跑通」（观察④零 warning 佐证），但「default preset=expert-orchestrator」这一预注册唯一变量在 z0_env_smoke 单 turn SDK trial 路径**测不出任何差异**——若按现设计点火 A/A，两臂将测量纯噪声（REPORT-4 风险 1 的具体化证实）。

## 四、观察④：preset 装载 warning/error——零

- events 全文件扫描：`"level":"warn"/"error"`、`warning`、`deprecat` **0 处**（排除 assistant/user 文本后）；`thinking.type=disabled` 0 处；HTTP 400/BadRequest 0 处；`finish.reason.kind=error` 0 处；`turn/end` `{"reason":{"kind":"completed"}}`。
- `rep1.trace.jsonl` 3 处关键词命中均为良性 `"isError":false` 字段。
- CLI stderr 干净，无 preset 装载告警；progress.json `failed=0`。

## 五、A/A 点火前剩余风险清单（更新版）

1. **【升格为首要】preset 唯一变量在 trial 路径零行为出口**（第三节）：现两臂在单 turn SDK trial 下可辨差异为空，A/A 将测得纯噪声。需协调者裁决：改用 registry 消费面可达的探针（如多 turn + summon/subagent 流、或 web 会话侧验证），或将实验变量重设计为 trial 路径可观测的注入面。
2. **unpriced 计费**（沿档非阻断）：glm-5.3-flash 无价目行，usd 恒 0，护栏仅 trial 数上限；expert 臂单 trial 基准 miss=29874/output=1036。
3. **reasoning 计量口径**（沿档）：usage.reasoning=0 而 reasoningChars>0，判推理以 reasoningChars/blocks 为准（本次 expert 臂 4 块 1823 字符）。
4. **hit=0**（沿档）：单 turn 冷启动预期；A/A 多 turn 后才有意义。
5. **wall 预算**（沿档）：单样本 36–76s 区间，排期按 ~76s 慢界 × repeats 估算。
6. **baseline 臂既有样本仍有效**：本 run 与 llpf run 的 header/systemPrompt 逐字比对基线已建立（本报告第二、三节），A/A 点火后可用同一比对法快速判「变量是否产生任何事件级差异」。

## 六、边界与预算遵守

- 恰 1 次执行（20261019-102731-3cym），无迭代、无其他场景、无 A-A、无全矩阵；失败即停条款未触发（一次成功）。
- 写入仅限：run 产物（.dsh-eval/runs/20261019-102731-3cym/）+ 本报告。未改源码/arms/evalHome/宿主产物/client 版本/其他场景。
- 红线核查：capability-ab-eval 及 project1 非 git 仓库，零 git 写操作；dsh-eval-infra 既有未提交改动（ROUTE-B §5 所载）零触碰；宿主 `.credentials.yaml` 全程只读。
- key 零回显零落盘：两 key 仅运行时 inline 注入子进程 env，未写入任何文件、未出现于任何输出/报告/bus 消息。

## 七、完成定义对照（如实）

| 判定项 | 达成 |
|---|---|
| expert 臂 1 trial 实跑（CLI_EXIT=0） | ✅ 20261019-102731-3cym |
| verdict+ledger 落盘 ∧ totals>0 | ✅ verdict ok=true；miss=29874/output=1036 |
| SMOKE-REPORT-5.md 落盘 | ✅ 本文件 |
| bus 已发 | ✅（发送记录见 bus） |
| key 零回显零落盘 | ✅ |
| 观察项①②③④逐条 | ✅（①不可辨+机制解释；②对比表；③ 36s vs 76s；④零告警） |

**结论**：expert 臂端到端实跑 PASS——preset 装载零告警、trial 真实完成（4 步 11 工具调用、verdict ok、真实 token 落账），expert-orchestrator boot 链（preset 装载/插件行/工具注册）在 trial runtime 可用。**但预注册唯一变量（preset-registry default）在 SDK trial 路径无行为出口（源码级+双 run 实证），A/A 点火前需协调者对变量设计作出裁决。**
