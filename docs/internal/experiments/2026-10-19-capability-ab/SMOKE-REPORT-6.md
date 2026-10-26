# SMOKE-REPORT-6 — 双臂重接线（amendendum 落地）+ baseline 臂 boot 复验
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **日期**：2026-10-19
- **执行**：DevOps 自动化师（coordinator 委派）
- **规格来源**：预注册 amendendum `dsh-expert-orchestrator@ea7f46a`，`docs/internal/experiments/2026-10-19-capability-ab/ARCHIVE.md:96-110`（本任务即其第 2 点落地）
- **结论**：✅ 全部完成定义满足。变量已从死代码（agent-preset-registry.config.default）重接线为「插件有/无」，diff 恰为 3 条插件源行，baseline 臂 vanilla boot 复验 1 trial 通过（totals>0）。

---

## 1. 两臂改动前后 diff 摘要

### baseline.yml（`bench/arms/baseline.yml`）
| 项 | 改前 | 改后 |
|---|---|---|
| header 注释 | 述旧设计（插件两臂均在位，唯一变量=config.default） | 述新设计：amendendum 变量=插件有/无；插件 3 行以 `disabled: true` 臂层中和；引用 loader 跳过证据行 |
| description | `plugin installed, default preset = standard (stock agent)` | `vanilla harness (plugin rows disabled) + preset-standard` |
| provider/model/effort | `newapi` / `glm-5.3-flash` / `max` | **逐字未动** |
| patches.insert | agent-preset-registry(config.default: standard) + preset-standard(@deepseek-ai/dsh-agent-preset, {id: standard, plugins: []}) | **逐字未动**（preset-standard 源行指向宿主官方包 `@deepseek-ai/dsh-agent-preset`，不指向插件仓库 → 保留） |
| 新增 | — | 3 条 target 覆写行（patch 机制无删除 op，`disabled: true` 即臂层移除；dsh-app-boot `lib/index.js:2341` 与 cordis-plugin-loader `:363` 均在模块解析前跳过 disabled 行）：`- id: dsh-expert-orchestrator / name: dsh-expert-orchestrator / disabled: true`；`- id: expert-sources-remote / name: 'file://capability-ab-eval/.dsh-eval/home/profiles/eval/node_modules/dsh-expert-orchestrator/lib/remote.js' / disabled: true`；`- id: preset-expert-orchestrator / name: '@deepseek-ai/dsh-agent-preset' / disabled: true`（name 为 composed 行逐字节断言，mismatch 会 warn+skip 并被 diff 门捕获） |

### expert.yml（`bench/arms/expert.yml`）
| 项 | 改前 | 改后 |
|---|---|---|
| header 注释 / description | 唯一变量=config.default→expert-orchestrator；`default preset = expert-orchestrator` | 唯一差异=插件行在位（baseline 侧 disabled）；`default preset = standard` |
| agent-preset-registry `config.default` | `expert-orchestrator` | **`standard`**（amendendum 第 2 点：两臂对齐） |
| 插件源行 | 3 条（随共享 evalHome profile bundle 注入） | **全部保留、未动** |
| provider/model/effort | `newapi` / `glm-5.3-flash` / `max` | **逐字未动** |

YAML 纪律：新写字符串值加引号；`disabled: true` 为有意布尔值（loader 判 `row.disabled === true`）。

## 2. diff 验证（预期差异=恰好插件源行）

```
$ node ../dsh-eval-infra/lib/cli.js diff baseline expert
expert vs baseline: 3 variable(s)
  ~ row dsh-expert-orchestrator: disabled
  ~ row expert-sources-remote: disabled
  ~ row preset-expert-orchestrator: disabled
CLI_EXIT=1
```

- **差异行数量 = 3**，恰为 3 条插件源行（dsh-expert-orchestrator / expert-sources-remote / preset-expert-orchestrator），**无任何其他差异行**；agent-preset-registry、preset-standard、route（provider/model/effort）两侧全同。
- `CLI_EXIT=1` 说明：`cmdDiff` 仅在 variables==1 时 exit 0（one-variable gate）。amendendum 有意将变量重定义为「插件有无」，其 composed 树表现恰为 3 行，故 exit 1 属预期行为，非遗漏；后续任何依赖 diff exit 0 的门禁需知悉此语义。
- disabled 补丁生效旁证：3 行出现在 diff 中=覆写已落（若 name 断言 mismatch 会 warn+skip，行将不出现在 diff）。

## 3. baseline 臂 boot 复验（恰 1 trial：z0_env_smoke × baseline × repeats 1）

命令形态同 SMOKE-REPORT-5（`DEEPSEEK_API_KEY`/`NEWAPI_API_KEY` 于同一 bash 命令内自宿主 `/vol2/@appshare/Harness/.dsh/.credentials.yaml` refs 读取、inline 注入；**key 零回显零落盘**）：

```
$ node ../dsh-eval-infra/lib/cli.js preflight baseline --scenario z0_env_smoke
compose: ok · 0 variable(s)
mounted: ok
running z0_env_smoke on baseline…
✓ z0_env_smoke/baseline#1 · $0.0000 · 5 steps · 35s
  OK   compose  the tree builds (this arm is the baseline, so there is nothing to diff)
  OK   mounted  2 row(s) present and enabled in the composed tree
       row agent-preset-registry: mounted
       row preset-standard: mounted
       tools available to the agent: 23 (bash, create_goal, edit, …)
baseline loads and runs
CLI_EXIT=0
```

| 判据 | 值 | 判定 |
|---|---|---|
| CLI_EXIT | 0 | ✅ |
| run id | **20261019-112320-rm97** | ✅ |
| verdict | `{"ok": true, "detail": "env probe ok"}` | ✅ |
| ledger 落盘 | `.dsh-eval/runs/20261019-112320-rm97/ledgers/z0_env_smoke/baseline/rep1.json`（+ rep1.events.jsonl / rep1.trace.jsonl） | ✅ |
| totals>0 | `miss=33040, output=819, steps=5, turns=1`（hit/reasoning/usd=0，unpriced 通道） | ✅ |
| progress | `status=done, total=1, completed=1, failed=0`（wallMs=34845） | ✅ |

**vanilla 旁证（插件缺席的实证）**：
- baseline 工具面 23 个，为纯 vanilla 清单；expert 臂（3cym ledger）26 个，差集恰为插件 3 件：`list_experts, summon_expert, summon_experts`；baseline 无任何独有工具。
- 两臂 ledger 的 model/provider/effort 完全一致（`glm-5.3-flash` / `newapi` / `max`）——共同工况未动，变量唯一。
- 注：两臂 ledger 的 `systemPromptChars=0 / systemPromptSha=null`（3cym 同样为 0/null）——系 trial 路径 ledger 未填该字段的既有行为，非本次改线引入（见 §5 风险 6）。

## 4. expert 臂不重跑依据（注记）

- boot 已证：SMOKE-REPORT-5 expert 臂 run `20261019-102731-3cym`（CLI_EXIT=0，verdict ok，4 步 11 工具调用，36s）。
- 本次 expert.yml 唯一功能改动为 `config.default: expert-orchestrator → standard`，该字段属 `agent-preset-registry` 行——SMOKE-REPORT-4/5 已三条证据确立其在 SDK trial 路径为**零消费死位**（registry defaultId 从不被 sdk-driver 消费；REPORT-5 中两臂 config.default 不同而 systemPrompt/行为全同；effort 唯一入口为 arm.effort→sdk-driver.js:38）。
- 故该改动不可能改变 boot 行为；重跑仅消耗额度不增信息。插件源行、provider/model/effort 均未动，3cym 的 boot 证据继续有效。

## 5. A/A 点火前剩余风险清单

1. **diff 门语义**：`diff` exit 1（variables=3）是新常态；任何以 exit 0 为通过条件的既有门禁/脚本须按 amendendum 语义更新，否则会误报。
2. **config.default 双臂同为 standard**：A/A 期间该字段不再区分任何东西；变量唯一为插件有无。任何期待 config.default 差异的分析假设必须废弃。
3. **共享 evalHome 依赖**：插件 3 行源自共享 profile bundle（`profiles/eval/package.json` dsh.profile.bundles，禁区）。若 evalHome 重建/重装致行 id 或锚定 URL 变化，baseline 的 disabled 覆写将 warn+skip（行静默回活）——变更后必须重跑 §2 diff 门确认仍恰 3 行。
4. **expert-sources-remote 的 name 断言为逐字节 file URL**：evalHome 路径迁移即失配 → warn+skip；同样依赖 diff 门捕获。
5. **场景-插件耦合**：baseline 工具面无 `summon_expert` 等 3 件插件工具；凡假设插件工具可用的场景在 baseline 臂将按设计失败/降级，场景集需插件无关或臂感知。
6. **ledger 不含 prompt 指纹**：`systemPromptChars/Shas` 在 trial 路径恒 0/null（两臂皆然，既有行为）；两臂 systemPrompt 实际必不同（插件 persona 段），prompt 级差异监控需另行手段，勿依赖 ledger 该字段。
7. **计费通道 unpriced**：usd 恒 0，成本对比只能用 token totals（miss/output）。
8. **boot smoke 覆盖有限**：本次仅 1 trial × z0_env_smoke；vanilla 臂在 23 场景全量下的稳定性未验，A/A 全矩阵前建议先小规模 n 试运行。

## 6. 完成定义逐条对照

| 完成定义 | 状态 |
|---|---|
| 双臂接线符合 amendendum | ✅ §1 |
| diff 恰为插件源行差异（3 行，无其他） | ✅ §2 |
| baseline 臂复验 1 trial 且 totals>0 | ✅ §3（rm97，miss=33040/output=819） |
| SMOKE-REPORT-6.md 落盘 | ✅ 本文件 |
| bus 已发 | ✅（见 bus 记录） |
| key 零回显零落盘 | ✅（inline 命令替换注入，未在任何输出/文件出现） |

红线遵守：未动源码/evalHome/宿主产物/client 版本/其他场景；未执行任何 git checkout/restore/清理；dsh-eval-infra 未提交改动原样未碰。写入仅限：两个 arms yml、复验 run 产物（CLI 自动）、本报告。
