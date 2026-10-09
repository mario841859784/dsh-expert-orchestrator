# T4（v2.9 M2）验证记录：npm test 253 用例构成与 undefined/None 豁免清单固化

- 任务：T4（v2.9 M2 文档与验证记录）；把散落在 v2.6 板归档事件流检查点与 v2.8 T29 交付报告中的豁免枚举固化为仓库内常设文档，并补记 v2.9 基线实测。
- 素材源：v2.6 板归档事件流（`.expert-taskboards/archive/20261009-182626-expert-orchestrator-v26.json.events.jsonl`，含 T24 S2+S3 检查点与 T29 6a 检查点）、v2.8 T29 交付报告（bus coordinator 信箱 `m17915362144702644211705`）、CHANGELOG [2.8.0]/[2.7.1] Verified 段先例。
- 验证日期：2026-10-10；基线 HEAD=59edd5b（M1 三任务 T1/T2/T3 + T11 回炉收口后，五 commit：7d4b877/1b02f0c/bd951b9/9dbb939/59edd5b）；工作树=本任务文档改动外零触碰。
- 方法：全部数字仓库实测——`npm test`、`grep -c`/`grep -n`、`npm pack --dry-run`；逐处豁免点人工读码核对函数语境。

## 一、结论

**`npm test` 253/253 全绿（exit 0，2026-10-10 实测，123.7s）；显式 `undefined`/`None` 豁免面 = lib 恰 7 处显式 `return undefined` + `taskboard.py` 恰 10 处 `return None`，全部为内部面 fail-open 或语义「空」返回，零工具 JSON 返回面暴露——与 v2.8 发布门禁④口径一致；处数 7+10 守恒，行号经 v2.9 两次代码提交平移后重新实测固化（见 §三平移说明）。**

## 二、253 用例构成

| 增量 | 提交 | 数量 | 内容 |
|------|------|------|------|
| v2.8 发布基线 | `1f18351`（T29 交付实测 240/240） | 240 | v2.8 收口时全套（含 WP-7 四件套、WP-6 余项、S1-S4 台账实施用例等） |
| T2 `--json` data 载荷 | `bd951b9` | +2 | watchdog/replay data 消费方视角：真实子进程+真实板 fixture，data 与实际板态一致、人类面汇总行交叉核对、视图/事件流独立对账 |
| T3 组合面收口 | `9dbb939` | +9 | 真实双进程 START 屏障竞态恰一成功 ×3 轮、lib 双 sweep 并发恰一提示、HELD 持锁下 budget 不阻塞+写命令仍串行、盘点零写零事件、视图落后/残尾崩溃容忍零写、预算联动 interrupt 拒绝幂等、负向零回归（既有续领预算联动用例的 refuse 断言随机制名同步 claim_idle） |
| T11 回炉 | `59edd5b` | +2 | claim_idle × #16 跨档「前章后拒」砖化回归（拒绝事件 after 恰为被拒任务、被拒轮零认领、前候选延后章丢弃、拒绝后 list/replay 完好性断言、--reset 放行统一落章）+ 多候选跨档全过统一落账回归 |
| **合计** | | **253** | node --test 实测 `tests 253 / pass 253 / fail 0` |

- 交叉核对：240 + 2 + 9 + 2 = 253 ✔；`test/tools.selftest.mjs`（单测试文件套件，`npm test` = `node --test "test/**/*.mjs"`）恰 253 个测试块（`grep -cE '^\s*(test|it)\(|await t\.test\('` = 253）✔。
- 各增量数与对应 commit 信息及板面交付记录（T2/T3/T10/T11）逐字一致。

## 三、undefined/None 豁免清单（v2.9 实测行号，2026-10-10 grep）

### lib — 7 处显式 `return undefined`

| # | 位置 | 所在函数/语境 | 豁免理由 |
|---|------|--------------|----------|
| 1 | `lib/index.js:81` | configSchema：`buildPluginConfigSchema()` 失败 catch | fail-open：schema 构建失败收敛 `undefined`=「无 schema」，插件装载面降级不抛；消费方为插件配置面，非工具返回面 |
| 2 | `lib/index.js:1107` | `filesOf(sourceId)`：rosterData 为 null 时 | fail-open：花名册数据缺失时渲染面返回 `undefined`，调用方按「无数据」降级 |
| 3 | `lib/index.js:1116` | 按 id 查 source 未命中 | 同上：source 不存在=「无此项」，渲染面消费 |
| 4 | `lib/client.js:136` | `vOptional().parse`：undefined/null 输入 | schema 库语义：可空字段透传 `undefined`，非错误路径 |
| 5 | `lib/tools.js:537` | 惰性值 `value.get()` catch | fail-open：求值异常收敛 `undefined`（v2.8 自 :356 平移至此） |
| 6 | `lib/host-settings.js:116` | `value.get()` catch | 同模式 fail-open（v2.8 基线平移，行号未变） |
| 7 | `lib/expert-profiles.js:129` | `loadProfilesLayer`：层文件缺失 | fail-open：层不存在=「无该层」，loader 消费；v2.8 新增豁免（基线 6+1） |

### taskboard.py — 10 处 `return None`

| # | 位置 | 函数 | 豁免理由 |
|---|------|------|----------|
| 1-2 | `:832` / `:839` | `find_cycle`（`dfs` 递归出口 / 外层遍历出口） | 语义返回值：`None`=无环（依赖校验内部面，create/set_dependencies 环检测消费） |
| 3 | `:1661` | `_completion_evidence`（无 owner/attempt_id 早退，`(None, '')`） | 语义返回值：无认领代际即无可查证据（watchdog adopt 内部判定面） |
| 4-6 | `:1844` / `:1847` / `:1852` | `budget_thresholds`（非整数 / <1 / 违背 alarm ≤ wrap-up ≤ interrupt） | fail-open：预算配置非法 → `None`=「预算按未启用处理」+stderr 告警，绝不因配置笔误炸掉执行面（对齐 hook 降级语义）；v2.8 新增（预算助手） |
| 7-8 | `:1860` / `:1867` | `budget_tier`（`th` 空 / 计数低于 alarm） | 语义返回值：`None`=预算未启用或未达任何档位；v2.8 新增（预算助手） |
| 9-10 | `:2352` / `:2354` | `_staged_files`（git 异常 / 非零退出） | fail-open：`None` 时调用方跳过 commit-msg 范围检查并注明，不误伤；v2.8 基线平移 |

### 行号平移说明（v2.8 → v2.9）

- `lib/index.js` 1099/1108 → **1107/1116**：T1 PROTOCOL 数组扩至 17 条目（+8 行）整体下移；处数不变。
- `lib/tools.js` **:537**：v2.8 已自 :356 平移至此，本轮未再移动。
- `lib/host-settings.js` **:116**、`lib/client.js` **:136**、`lib/expert-profiles.js` **:129**：与 v2.8 门禁④枚举一致，未移动。
- `taskboard.py`：v2.8 基线 5 处（`find_cycle` :787/:794、`_completion_evidence` :1531、`_staged_files` :2201/:2203）+ 预算助手 5 处（`budget_thresholds` :1710/:1713/:1718、`budget_tier` :1726/:1733）→ v2.9 实测 :832/:839、:1661、:2352/:2354、:1844/:1847/:1852、:1860/:1867——T3 新增 `claim_idle`/无锁快照读代码致整体下移，**函数与处数映射不变（5 基线平移+5 预算助手，共 10）**。

### 复现命令（数字可独立复核）

```bash
grep -rn "return undefined" lib/   # 恰 7 行
grep -n "return None" skills/expert-orchestration/tools/taskboard.py   # 恰 10 行
npm test                            # tests 253 / pass 253 / fail 0
npm pack --dry-run 2>&1 | tail -3   # total files: 86（v2.8 基线 85 + CHANGELOG.md，T1）
```

## 四、口径与边界

- **「豁免」定义**沿 v2.8 发布门禁④：显式 `undefined`/`None` 返回不落任何工具 JSON 返回面（工具面错误走具名 error 信封）；上表全部为内部面 fail-open 或语义「空」返回。
- 本记录由 T4 从归档（v2.6 板事件流 T24/T29 检查点 + bus `m17915362144702644211705`）固化为仓库内常设文档；后续版本 bump 触碰上述文件时，按「行号平移、处数守恒、复测刷新」惯例更新本表。
- 本记录为文档产物，不改变任何代码行为；`VERSION` 三处字面量（package.json:4 / dsh.plugin.json:4 / lib/index.js:88）在本任务零改动（bump 归 T5）。
