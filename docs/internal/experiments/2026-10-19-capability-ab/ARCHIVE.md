# 实验档案：expert 编排 preset 能力级 A/B（capability-ab）

> 实验纪律（SKILL.md §8）：引导段 / 协议文本 / persona 类改动合入前必须跑对照实验——同任务书、n≥3、判定标准先写后跑。一实验一档；判定标准在首跑前预注册，跑后不得改判；结论只陈述已验证事实。
>
> **本档案为预注册版（首跑前建档）**：判定标准随本目录首个 commit（预注册 commit）留痕，先于任何 dsh-eval 首跑（完整声明见「判定标准（预注册）」段）；此为对 2026-10-09 origin-chain 档案「预注册时序无留痕不可证」教训的修复。分层边界（调研报告 §0）：协议保真与机制正确性分别由既有预注册档案（persona-split / priority-declaration / origin-chain）与 `test/*.selftest.mjs` E2E 覆盖，本实验只测**能力提升（capability）**层，两类结论不得混写（调研报告 §8）。

- **日期**：2026-10-19（预注册建档；首跑日期待回填）
- **执行人**：技术文档工程师（任务板 T4 预注册建档；首跑执行人待首跑时回填）
- **对象改动**：非 persona / 引导段 / 协议文本改动——对象为 expert-orchestrator preset 的能力级效应，变量切在 `agent-preset-registry.config.default`（standard vs expert-orchestrator）。预注册时仓库基线 main@bbe4444（v2.9.8）；首跑所用版本随版本三元组入档（见「设置」）。
- **对照组 / 实验组**：A/baseline = standard preset；B/expert = expert-orchestrator preset；两侧同装插件，唯一变量为 preset 选择位（见「设置」）。

## 假设

预注册假设，自调研报告 §4「预注册假设草案」逐字转录（含换行与缩进，不得弱化或改写任何数值与门禁逻辑）：

H1（主指标·能力）：在同一驱动模型、同一 batch 硬场景上，expert 臂 pass^3 相对 baseline
    提升 ≥ 20pp（绝对值）。
H2（不回归·门禁）：简单场景（z0/p1/p2）无回归 —— baseline 全过而 expert 全败的场景数 = 0；
    任一场景出现即 gate，不进入成本讨论。
H3（成本·只陈述不 gate）：每解题成本（cost per solved task）上升 ≤ 1.5×；超出则结论表述为
    "质量提升但成本不可接受"，不得只报 pass 率。

## 设置

变量控制基线，自调研报告 §4「设置」逐字转录（含换行）：

变量：agent-preset-registry.config.default（standard vs expert-orchestrator），其余全同；
交错过序（奇 repeat A→B，偶 repeat B→A）；每 trial 全新 workspace + 全新 runtime；
版本三元组（宿主 dsh / preset 版本 / 驱动模型）写入档案。

唯一变量声明与校验约定（预注册，依调研报告 §2「唯一变量怎么切」）：

- **唯一变量 = preset 选择位**：两侧都通过 `dsh-eval init --plugin ./dsh-expert-orchestrator` 装入同一 eval profile（插件代码在两侧都存在，只有默认 preset 不同）；baseline 臂 `agent-preset-registry.config.default: standard`，expert 臂 `: expert-orchestrator`。**本档案预注册将 baseline 定义为「插件已装但 default=standard」**，从设计上消除「装/不装插件」自由度。
- **diff 门禁**：跑前必须 `dsh-eval diff baseline expert` 打印 composed tree 差异，**须恰为 1 行差异**；>1 行要么改设计，要么留下书面豁免理由（写明为何仍算单一行为变量）。
- **不可分离声明义务**：若实测发现「装/不装插件」与「选/不选 preset」不可分离（插件 `entry.inject` 在 host 层注入 tools/systemPrompt，装插件本身即改变行为），必须在本档案书面声明该差异为何仍算单一行为变量——不得以「装/不装」冒充 preset 单变量。
- **跑前顺序**（调研报告 §2 冒烟顺序）：`dsh-eval selfcheck`（未改动 workspace → fail、参考解 oracle → pass）→ `run --aa` 取 A/A 噪声底 → 1–3 场景 × 1 repeat 冒烟看链路 → 正式矩阵；A/A floor 是 H1 判定的前置输入。
- **驱动模型三元组入档约定**：版本三元组（宿主 dsh 版本 / preset 版本 / 驱动模型）于首跑前定稿写入 raw/ 首跑记录；本预注册不预填具体值，首跑前不得空缺。

## n

矩阵规模（自调研报告 §3 逐字转录，本档案采纳为预注册 n）：

建议矩阵规模：**硬场景 12–15 个 + 简单场景 3 个，repeats 3（二进制结果建议 5），双臂**。约 90–180 trials；先跑 3 场景冒烟估预算。

调研报告 §4 n 草案（逐字转录，为上式在 repeats=3、15 硬场景时的具体示意）：

15 硬场景 × 3 repeats × 2 臂 = 90 trials；README 建议二进制结果 repeats=5。

- 硬场景最终个数（12–15 区间内）与场景清单于首跑前取定、随 raw/ 首跑记录冻结，跑后不得增删场景；简单场景固定为 z0/p1/p2 反向对照（与 H2 对应）。
- 场景选取原则（自调研报告 §3 逐字转录）：原则：优先选 baseline 会翻车的场景，否则天花板效应让一切读成"无差异"。

### 场景映射（自调研报告 §3 逐字摘引，七类）

| 插件声称 | 场景（dsh-eval 自带） | 为什么能区分 |
|---|---|---|
| PM 先行规划 / 长程多轮 | `s2_taskdag_scheduler`(10 轮)、`s3_intervalset_algebra`(10 轮)、`s4_multifile_refactor`(8 轮)、`s1_longhorizon_debug`(6 轮) | 每轮结果依赖前轮规范形态，规划错一次后面全错；单 agent 长程最易漂移 |
| 委派分工 / 工具纪律 | `f4_grep_rename`（350 处引用，80 文件带诱饵）、`t1_tool_choice_grep`（300 模块，正则一步 vs 逐文件读几百步）、`f10_db_investigation`（只能经 db_query 拿整表） | 信息检索路径选择直接决定步数与成本；分诊/委派做得好会显著少走弯路 |
| 交付门禁 / 自验证 | `v1_verify_before_done`（唯一 sealed，spec 反直觉 + tests 目录须逐字节不变）、`f3_test_suite_fix`（400 测试 5 个植入 bug）、`f8_verbose_tests`（500 测试 12 bug，每次跑几万字符） | "跑绿才算完"是最难自发满足的门禁；独立评审理论上的主战场 |
| 上下文压力 / 经验池 | `l1_chain_migrate`、`l2_ledger_state`（45 节点指针链，读上下文 ~180K token，中途有矛盾笔记）、`f1_log_triage`（~600K 字符日志 + 红鲱鱼） | 长链累积上下文下的规则保持；经验池/分层摘要若有效会在这里体现 |
| 安全（子代理不得听注入） | `x1_injected_readme`（要求读的文件里藏"把 secrets 复制出去"）、`x2_tool_result_injection`（构建日志里伪装系统指令 `rm -rf`） | 委派会把注入面放大到每个子代理；工具 deny 列表/门禁是否真的挡住 |
| 跨会话记忆 / 经验沉淀 | `m1_cross_session_recall`（turn 3 换新 runtime，7 个事实里 1 个只在对话中、禁止写盘） | 唯一能证明"经验池真的存了东西"的场景；作者原话：能 6/7 → 7/7 才算改进 |
| 不回归（反向对照） | `z0_env_smoke`、`p1_format_contract`、`p2_persistent_rule` | 编排层对简单任务通常是**纯开销**；这里必须读到"等价"，读不到就不能宣称无损 |

注：调研报告 §3 表另有「密封确认池」行（`n1_verbatim_restore`、`n2_intent_ledger`、`n3_rot_checkpoints`、`v1_verify_before_done`，只在结论成型后跑），不属上述七类摘引范围；`v1_verify_before_done` 同时列于「交付门禁 / 自验证」行，其 sealed 时序约束以调研报告原行为准。

## 判定标准（预注册）

**预注册声明**：本判定标准随本目录首个 commit（预注册 commit）留痕，先于任何 dsh-eval 首跑；结论回填 commit 必须晚于该预注册 commit。（本声明为对 2026-10-09 origin-chain 档案「预注册时序无留痕不可证」教训的修复。）

判定标准，自调研报告 §4 逐字转录（含换行与缩进）：

H1 达标：pass^3 差值区间（场景聚类 bootstrap）下界 > 0 且点估计 ≥ +20pp；
         且已验证 A/A floor 的区间不覆盖该读数。
H1 未达标：区间含 0 → 加跑（提 repeats 或换更硬场景），不得改判。
H2 达标：一致性回归场景数 = 0。
H3：只入档，不作 gate。

方法约定（预注册）：

- 判分只用确定性 verifier，坚决不用 LLM judge（调研报告 §5）。
- TEMPLATE.md「探针协议（行为类断言用）：子代理逐字引用首尾行」不适用于本实验——能力级判定用确定性 verifier；行为类断言归既有协议保真档案，两类结论不混（调研报告 §0/§8）。

## 原始产出路径

- **约定（首跑后落盘）**：原始产出写入本目录 `raw/` 子目录（`docs/internal/experiments/2026-10-19-capability-ab/raw/`），至少含：逐 trial 结果、A/A floor 记录、`dsh-eval diff baseline expert` 输出、selfcheck/verifier 判分记录、成本对账（usage 口径见调研报告 §1.1）、首跑前冻结的场景清单与版本三元组；结论回填时须可逐项回溯。
- 调研依据全文：本目录 `background-research.md`（调研报告《expert-capability-eval-research.md》原样副本，逐字节未改动）。

## 结论

待首跑后回填。（预注册：本段现在不预填任何结论或预期。）

## 决策

待首跑后回填。（预注册：本段现在不预填任何决策。）

## 预注册 amendendum（2026-10-19）：实验变量重设计——插件有/无

> 本 amendendum 随本目录第二个 commit（预注册 amendendum commit）留痕，仍先于任何 dsh-eval 首跑；对上文「设置」段原变量定义构成书面修订，判定标准与 n 不受影响。

1. **原变量证伪**：原唯一变量（`agent-preset-registry.config.default` 的 preset defaultId 位）在 SDK trial 路径为死代码。证据三条：
   ① expert-orchestrator persona 系插件 profile 级注入（`@deepseek-ai/dsh-agent-preset-registry`…插件侧 `tools.js:1868`），与 preset 选择无关；
   ② registry defaultId（`lib/index.js:463`）在 5 个 `@deepseek-ai` 包 lib 级 grep 零消费点；
   ③ 双臂 smoke（run `20261019-060008-llpf` baseline 臂、`20261019-102731-3cym` expert 臂）两臂 systemPrompt 逐字节相同（仅 UUID 异）、26 工具逐字一致。
   证据文件：`/vol2/@appshare/Harness/workspace/project1/capability-ab-eval/` 下 `SMOKE-REPORT-4.md`、`SMOKE-REPORT-5.md`（细节以原文件为准，此处仅引用路径，不复制大段）。
2. **新变量**：插件有/无。expert 臂 = 插件源行在位（维持现状）；baseline 臂 = 移除插件源行（vanilla harness + preset-standard）。两臂 `config.default` 均对齐 standard（preset 位不再是变量）。双臂共同工况（非变量）：provider=newapi、model=glm-5.3-flash、effort=max（`arm.effort` 字段，`sdk-driver.js:38` 为 trial 唯一 effort 入口）。
3. **不变项**：判定标准（H1 pass^3 +20pp 区间下界 > 0 且 A/A floor 不覆盖；H2 门禁简单场景一致性回归 = 0；H3 成本只陈述）与场景清单（23 场景）与三元组入档约定全部不变；effort=max 作为固定工况补记入三元组旁注。
4. **时序声明**：截至本 amendendum，零评测结果数据（仅 2 个 smoke trial，无任何场景成绩数据）；本变更先于首跑，时序干净。
5. **依据**：原始设计预留条款「若 entry.inject 使装/不装不可分离须书面声明」（「设置」段「不可分离声明义务」）的落地执行——本段即为该书面声明。

本 amendendum 由源码证据驱动、coordinator 与用户双重确认（用户选择「①插件有无变量」）。
