# capability-ab 握手 Smoke 报告 4 — 乙案（arm.effort=max）落地，thinking.disabled BLOCKER 闭合
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **执行者**：DevOps 自动化师（coordinator 委派）
- **日期**：2026-10-19
- **前档**：SMOKE-REPORT-3.md（乙案依据：arm.effort=sdk-driver.js:38 唯一入口；resolvedEffort=null 证据；run 20261019-055102-1mrp）、SMOKE-REPORT-2.md（根因链）、ROUTE-B-SETUP.md（环境）
- **协调者裁决**：乙案——双臂顶层加 `effort: max`（共享工况参数，两侧逐字同值），解禁 arms 写入

## 结论一览

| 判定项 | 结果 |
|---|---|
| 双臂各加 `effort: max`（同值+镜像注释） | ✅ baseline.yml:17 / expert.yml:15，注释指明镜像宿主 cordis.patch.yml:65-70 agent-default-model effort=max 工况 |
| diff 恒 1 variable（agent-preset-registry: config） | ✅ 改前改后输出逐字一致，`expert vs baseline: 1 variable(s)`，EXIT=0 |
| 复跑恰 1 trial / CLI_EXIT=0 / verdict+ledger 落盘 | ✅ run **20261019-060008-llpf**（runs/ 下仅新增此 1 个），EXIT=0 |
| ledger totals>0（真实 token 用量） | ✅ **miss=29825, output=1711**（hit=0, reasoning=0, usd=0/unpriced） |
| effort=enabled 路径生效（请求不再带 disabled） | ✅ header `config.reasoningEffort="max"`（seq=10）＋assistant 返回 reasoning 块＋零 400 |
| verdict | ✅ **`{"ok": true, "detail": "env probe ok"}`**（前三档均为 ok=false 5 项 probe 全挂） |
| **端到端 smoke 判定** | **PASS——BLOCKER（thinking disabled 400）闭合，A/A 点火前置条件就绪** |

## 一、双臂改动与 diff

### 写入内容（两臂同值、同形注释；字段先经源码核实后落笔）

`bench/arms/baseline.yml`（在 `model: glm-5.3-flash` 与 `patches:` 之间插入；expert.yml 同文）：

```yaml
# Shared condition, NOT an experiment variable (identical value in both arms):
# effort=max mirrors the host profile's agent-default-model effort
# (/vol2/@appshare/Harness/.dsh/profiles/web/cordis.patch.yml:65-70:
# reasoningEffort: max); arm.effort is the sole effort entry into the SDK
# trial request (dsh-eval-infra lib/core/sdk-driver.js:38).
effort: max
```

落笔前核实链（全部只读）：
- **字段名/入口**：`dsh-eval-infra/lib/core/sdk-driver.js:38` `if (arm.effort !== undefined) opts['reasoningEffort'] = arm.effort;`——arm 顶层字段名就是 `effort`（YAML 写 `effort: max`，非 `reasoningEffort`）。
- **解析面**：`dsh-eval-infra/lib/core/arms.js:60` `if (typeof r['effort'] === 'string') spec.effort = r['effort']`；diff 比对在 `arms.js:175`（`(a.effort ?? null) !== (b.effort ?? null)` 才计变量）→ 两臂同值不增变量。
- **取值枚举**：`max` 为合法档位——SMOKE-REPORT-2.md:26 实录 pi-ai 校验词表 `off|minimal|low|medium|high|xhigh|max`；evalHome glm-5.3-flash 的 `reasoningEfforts` map 含 `max` 键；宿主 cordis.patch.yml:65-70 agent-default-model 即用 `reasoningEffort: max`（本次改前 sed 复核原文一致）。
- **route 覆盖风险排除**：`preflight.js:66` `applyRoute(loadArmFile(...), options.route ?? {})`——CLI preflight 不传 route，arm 自身 effort 直通，无 run 级覆盖/删除。
- **YAML 1.1**：`max` 不在布尔词表（off/no/yes/true/false/on/n/y），裸词安全；本任务新增键仅 `effort` 一个，值 `max` 无需引号。

### diff 命令输出（改后；与改前逐字一致，EXIT=0）

```
$ cd capability-ab-eval
$ node ../dsh-eval-infra/lib/cli.js diff baseline expert
expert vs baseline: 1 variable(s)
  ~ row agent-preset-registry: config
DIFF_EXIT=0
```

恰 1 variable = `~ row agent-preset-registry: config`（唯一实验变量保持不变）。

## 二、复跑 trial 记录（恰 1 次）

- **执行命令**（key 打码，同前档形态；两 key 从宿主 `/vol2/@appshare/Harness/.dsh/.credentials.yaml` refs 运行时读取、同一 bash 命令 inline 注入，**key 值零回显零落盘**）：
  ```bash
  cd capability-ab-eval
  DEEPSEEK_API_KEY="$(python3 -c '...refs.DEEPSEEK_API_KEY...')" \
  NEWAPI_API_KEY="$(python3 -c '...refs.NEWAPI_API_KEY...')" \
  node ../dsh-eval-infra/lib/cli.js preflight baseline --scenario z0_env_smoke
  ```
- **CLI 输出**：`compose: ok · 0 variable(s)` → `mounted: ok`（2 rows）→ `✓ z0_env_smoke/baseline#1 · $0.0000 · 4 steps · 76s` → `baseline loads and runs`；**CLI_EXIT=0**。
- **run id**：`20261019-060008-llpf`（目录 `.dsh-eval/runs/20261019-060008-llpf/`；runs/ 计数 3→4，本次仅新增此 1 个 run，恰 1 trial 无迭代）。
- **ledger**（`ledgers/z0_env_smoke/baseline/rep1.json`）：
  - provider=newapi, model=glm-5.3-flash, **resolvedEffort=max**（前三档均为 null）, turns=1（end=completed）, steps=4, wallMs=75796
  - **totals：hit=0, miss=29825, output=1711, reasoning=0, usd=0**（unpriced=true, usageProvenance=self-reported）→ **miss/output 均 >0，真实 token 用量 ✅**
  - **verdict**：`{"ok": true, "detail": "env probe ok"}`——bash/grep/glob/edit/read 五项探针全部通过（前三档同探针全部失败）
  - steps 证据：4 步共 11 次真实工具调用（bash/grep/glob/read/write/edit，含 `write answers/probe.md`、`edit a.cfg alpha=1→2` 等），零动作问题同步消失

## 三、effort=enabled 路径生效证据（判据逐条对照）

1. **header 判据**（SMOKE-REPORT-3 第三节的判据原样复用）：`rep1.events.jsonl seq=10 request/header`：
   ```json
   {"type":"request/header","seq":10,…,"data":{"header":{"config":{"provider":"newapi","model":"glm-5.3-flash","reasoningEffort":"max","maxTokens":128000},…
   ```
   `config.reasoningEffort="max"` 非空（前三档 config 仅 3 字段无此项）；ledger `resolvedEffort=max` 同源互证。
2. **pi-ai zai 分支判据**：`options?.reasoningEffort` 非空 → 走 `{type:"enabled", clear_thinking:false}`（SMOKE-REPORT-2.md:80 三元式）——反向证据：4 条 assistant 消息均含 `"type":"reasoning","thinkingSignature":"reasoning_content"` 块（steps reasoningChars=3157/768/215/44），**模型真实返回了推理内容**。
3. **400 消失判据**：全 events 文件扫描——`thinking.type=disabled` **0 处**；HTTP 400/BadRequest/InvalidParameter **0 处**；`finish.reason.kind=error` **0 处**。扫描命中的歧义子串已逐一定性：2 处 `400` 均为 jobId/时间戳子串（`"startedAt":1792389654007` 等），1 处 `disabled` 为系统提示词文本（专家编排除述），4 处 `thinking` 均为 `thinkingSignature` 字段名。
4. **机制链**（与前三档逐环相同，本次全链贯通）：arm.yml `effort: max` → arms.js:60 → preflight.js:66（空 route 直通）→ sdk-driver.js:38 `opts['reasoningEffort']` → client initialize → server → agentOptions → header config.reasoningEffort（ledger.js:159）→ pi-ai enabled 分支。

## 四、A/A 点火前剩余风险清单

1. **expert 臂未实跑**（非阻断）：乙案仅 smoke 于 baseline 臂；expert 臂（preset=expert-orchestrator）在 effort=max 下的 compose/mounted 已过（本次 preflight compose ok），但真实 turn 未行使——A/A 点火时 expert 侧 preset 组装/插件行为首跑，如异常属新观察项。
2. **unpriced 计费**（非阻断，沿档）：glm-5.3-flash 无价目行，usd 恒 0、成本护栏仅靠 trial 数上限；本次真实用量 miss=29825/output=1711 可作单 trial 用量基准。
3. **reasoning token 计量口径**：usage.reasoning=0 而 reasoningChars>0——上游 self-reported usage 未单列 reasoning token，A/A 归因时勿用 reasoning=0 判「无推理」；判推理与否应以 reasoningChars/blocks 为准。
4. **hit=0**：单 turn 冷启动 cache miss 属预期；A/A 多 turn 后 hit 曲线才有意义。
5. **wall 预算**：单 trial 76s（effort=max 使每步推理变长：本次 4 步 75.8s vs 前档 0 步 3.2s）；A/A 按 repeats 线性放大，点火排期需按此估算。
6. **trace/正常 turn 样本缺口已闭合**：本 run 已有 4-step、含工具调用+正常 shutdown 的完整样本（前三档 0-step 缺口消除），无遗留。

## 五、边界与预算遵守

- 恰 1 次复跑（20261019-060008-llpf），无迭代、无其他场景、无 A-A、无全矩阵；失败即停条款未触发（一次成功）。
- 写入仅限：`bench/arms/baseline.yml` +1 字段行 +5 注释行、`bench/arms/expert.yml` 同、run 产物（.dsh-eval/runs/20261019-060008-llpf/）、本报告。未改源码/evalHome profile/宿主产物/client 版本/其他场景。
- 红线核查：capability-ab-eval 及 project1 非 git 仓库（`git rev-parse` fatal 确认），无任何 git 写操作；dsh-eval-infra 工作树既有未提交改动（ROUTE-B-SETUP §5 所载 package-lock.json +3 行、node_modules 变化）非本任务产物、零触碰。
- key 零回显零落盘：两 key 仅运行时 inline 注入子进程 env，未写入任何文件、未出现于任何输出/报告/bus 消息。

## 六、完成定义对照（如实）

| 判定项 | 达成 |
|---|---|
| 双臂各含 `effort: max` 且两侧逐字同值 | ✅ baseline.yml:17 / expert.yml:15 |
| diff 恒 1 variable（agent-preset-registry: config） | ✅ |
| 复跑恰 1 trial，CLI_EXIT=0，verdict+ledger 落盘 | ✅ 20261019-060008-llpf，verdict ok=true |
| ledger totals>0 | ✅ miss=29825, output=1711 |
| effort=enabled 生效证据（header reasoningEffort=max、零 disabled/400） | ✅ |
| SMOKE-REPORT-4.md 落盘 / bus 已发 / key 零回显零落盘 | ✅ |

**结论**：乙案按裁决落地——arm.effort=max 命中 sdk-driver.js:38 唯一入口，trial 请求带 effort 走 enabled 路径，thinking.disabled 400 消失，verdict 转 PASS（env probe ok），真实 token 用量落账。**A/A 点火前置 BLOCKER 已闭合。**
