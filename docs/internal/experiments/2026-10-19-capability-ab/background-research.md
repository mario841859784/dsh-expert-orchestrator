# 如何验证 expert 插件（dsh-expert-orchestrator）对模型能力的提升 —— 调研结论

> 调研日期：2026-10-19 · 只读调研，未改动任何仓库
> 结论一句话：**用 DSH 原生的配对 A/B 评测基建（TT-Wang/dsh-eval-infra）跑「同一模型、同一场景、只切 preset」的对照实验，判分只用确定性 verifier，先测 A/A 噪声底，再读 pass^k 与每解题成本。**

---

## 0. 先划清三层，别混着测

| 层 | 问题 | 你的仓库现状 | 该怎么测 |
|---|---|---|---|
| 协议保真（mechanism） | persona/协议文本是否被模型**执行**（标记行到达率、复述保真） | **已有**：`docs/internal/experiments/` 下 3 份预注册档案（persona-split / priority-declaration / origin-chain），origin-chain 做到 18/18 探针、P1 9/9、P2 9/9 | 探针式（受控模拟，n≥3，预注册阈值）——已够用 |
| 机制正确性（code） | 任务板 CAS、总线 at-least-once、递归防护拒绝 | 已有 `test/*.selftest.mjs` 真实子进程 E2E | npm test |
| **能力提升（capability）** | 同一模型在**更难的任务**上是否解得更多 / 更可靠 / 单位成本是否可接受 | **空缺** | 本文件：任务-验证器配对 A/B |

关键：`能力提升` 必须先定义成可证伪命题（在哪些任务族、哪个指标、多少 pp），否则任何一次跑都能被解释成"提升了"。

---

## 1. 直接可用的 GitHub 基建

### 1.1 TT-Wang/dsh-eval-infra（首选，DSH 原生）
<https://github.com/TT-Wang/dsh-eval-infra>

为什么是它：它的比较单元就是「dsh 组合差异」（profile patch 行），一个 arm = 一处 composition 差异；两次 arm 交错配对跑在**真实 dsh SDK runtime** 上，每个 trial 全新 workspace + 全新 runtime 进程 + 隔离 `DSH_HOME`。

自带能力（直接影响可信度）：
- **单一变量强制**：composed tree 逐行 diff，>1 行差异默认拒绝（`dsh-eval diff baseline candidate`）。
- **A/A 噪声底**：`run --aa` 让 baseline 对自己跑一遍，得到"无变化"的区间；后续任何"更省/更贵/更少步"的方向判定必须先越过这个带，没有 floor 就拒绝读方向。
- **verifier 先自检**：`selfcheck` 要求「未改动 workspace → fail」「参考解 oracle → pass」；`--strict` 还会逐个删/改 oracle 产出，要求 verifier 察觉（防"永远判过"的假 grader）。
- **pass^k 可靠性**（首行指标）：k 次重复全过的场景占比 —— 对 expert 编排这种"有时好有时坏"的改动，比平均通过率更能说明问题。
- **回归门禁优先于成本**：baseline 全过 + candidate 全败 = 回归，直接 gate；多数失败但不一致 = *suspected*，要求 rerun 确认。
- **统计不吹牛**：区间按场景聚类 bootstrap、McNemar mid-p、MDE/N\* 明示、A/A floor、sealed holdout 确认池、CUPED、序列模式。
- **判分防作弊**：真值在 agent 运行前移出 workspace；docker sandbox 只挂 workspace；代码判不了才用 blinded judge（双序、面板、严格多数、拒绝同族模型当裁判、conformal 风险控制、锚点防漂移）。
- **成本按官方计费口径**：本地代理记录 provider 自己的 usage，与 runtime 自报数字对账，不一致就不给成本结论。
- **可复核**：run 封成带 Ed25519 签名的 bundle，`verify` 输出 PASS / INVALID / INCONCLUSIVE；`--replay` 不花钱重放。
- **题库**：35 个场景（context/tools/coding/prompt/memory/safety/cost/verification 八类，4 个封在 sealed 确认池）+ 公开池：Terminal-Bench 2.0（89 任务）、SWE-bench Verified（500 issue，用官方 harness 判分）。
- **CI 门禁**：回归 exit 1、不完整 exit 2、`--max-usd` 花费上限。
- 已知广告效应校准：作者自己的 `validation-1`（baseline vs `dsh-tool-result-fold`）结论就是 **cost difference inconclusive**（+3.3%，CI −11.4%~+16.5%，4 场景），pass 8/8→8/8 —— 说明它不会为了好看而硬给"提升"。

门槛：需要 Node 22+、可用 Docker（第三方插件默认每 trial 一容器；也可 `--sandbox host`）、`DEEPSEEK_API_KEY`。

### 1.2 cipherfoxie/agent-bench（方法论参照，运行时是 opencode 不是 dsh）
<https://github.com/cipherfoxie/agent-bench>
- 只做确定性 gate（build / typecheck / 冻结清单），**明确拒绝 LLM 判 LLM**；一 arm 一变量；负面结果照发（Serena 判 SITUATIONAL、caveman 实测 −31% 而非宣称 −75%，且在部分 Claude 模型上 +18% 成本）。
- 值得抄进你自己实验纪律的三条：① one change per arm；② negative results ship；③ benchmark hygiene 是方法的一部分（有一次矩阵因健康检查把空闲模型唤醒而整份作废，重跑翻转结论 —— 污染数据作废，不留脚注）。

### 1.3 juyangbai/MAS-PromptBench
<https://github.com/juyangbai/MAS-PromptBench> —— 研究"什么时候 prompt 优化真的改善多智能体系统"的可复现基准。你的插件本质是 persona+协议文本驱动，这类工作正好回答"prompt 类改动的效应量一般多大"，用来校准预期。

### 1.4 公开基准池（可只取切片，不必全跑）
- **Terminal-Bench 2.0**（laude-institute）— 命令行/容器内硬任务，89 任务索引，dsh-eval 已集成 `bench list/get`。
- **SWE-bench Verified** — 500 issue，官方 `swebench` harness 判分，dsh-eval 已集成。
- 其他可作扩展池：GAIA（通用助手）、τ-bench（工具-用户交互）、BFCL（函数调用）。

### 1.5 文献（解释"为什么多专家不一定更好"）
- **Why Do Multi-Agent LLM Systems Fail?（MAST）** NeurIPS 2025 D&B — 多智能体失败分类学，含"no or incomplete verification"等模式，直接对应你的交付门禁要解决什么。
  <https://proceedings.neurips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html>
- **Are More LLM Calls All You Need? Towards Scaling Laws of Compound Inference Systems**（arXiv 2403.02419）— 复合系统"调用更多 ≠ 更好"，存在随投票数先升后降的区间。这是你把 expert 编排当"增加调用"时必须预设的风险。
- **More Agents Is All You Need**（arXiv 2402.05120）— 采样+投票的规模效应，说明增益主要来自独立采样多样性，而非"专家身份"本身 —— 因此必须做 A/B，不能靠直觉。

---

## 2. 把 expert 插件做成一个 candidate arm（唯一变量怎么切）

插件挂载面（读自仓库）：
- `dsh.plugin.json`：`preset.targetDir` = `~/.dsh/.agent-presets/expert-orchestrator`，`entry.inject: ["tools","subagents","systemPrompt"]`。
- `preset.yml`：preset `专家编排模式`；真正生效的声明在生成的 `cordis.patch.yml` 行 `preset-expert-orchestrator`（`@deepseek-ai/dsh-agent-preset`，`config.plugins` 持有完整 entry list）。
- 宿主侧选择入口：`@deepseek-ai/dsh-agent-preset-registry` 的 `config.default`（另有 volatile `selectedDefault`，新会话优先）。

因此**唯一变量**应切在 preset 选择位，而不是"装不装插件"：

```yaml
# arms/baseline.yml
name: baseline
patches:
  - id: agent-preset-registry
    config: { default: standard }
---
# arms/expert.yml
name: expert
patches:
  - id: agent-preset-registry
    config: { default: expert-orchestrator }
```

两侧都通过 `dsh-eval init --plugin ./dsh-expert-orchestrator` 装入同一 eval profile（插件代码在两侧都存在，只有默认 preset 不同）—— 这样才是一个变量。

风险与校验：
- 若插件 entry 在 host 层注入 tools/systemPrompt（`entry.inject`），装插件本身就可能改变 baseline 行为 → 此时"装/不装"与"选/不选 preset"不可分离，必须**显式声明为两行差异**并说明为什么仍算单一行为变量，或在实验档案里把 baseline 定义为"插件已装但 default=standard"。
- 无论哪种，跑前必须 `dsh-eval diff baseline expert` 打印 composed tree 差异行数；>1 行要么改设计，要么留下书面豁免理由。
- 冒烟顺序：`selfcheck` → `--aa` → 1–3 场景 × 1 repeat 看链路通不通 → 正式矩阵。

---

## 3. 测试题怎么挑（从 35 场景里按"插件声称的能力"对齐）

插件声称的能力（README）：分诊、PM 先行规划、按花名册委派、依赖 DAG 任务板、交付门禁（独立评审）、经验池沉淀。逐条映射到能**区分**的场景 —— 原则：优先选 baseline 会翻车的场景，否则天花板效应让一切读成"无差异"。

| 插件声称 | 场景（dsh-eval 自带） | 为什么能区分 |
|---|---|---|
| PM 先行规划 / 长程多轮 | `s2_taskdag_scheduler`(10 轮)、`s3_intervalset_algebra`(10 轮)、`s4_multifile_refactor`(8 轮)、`s1_longhorizon_debug`(6 轮) | 每轮结果依赖前轮规范形态，规划错一次后面全错；单 agent 长程最易漂移 |
| 委派分工 / 工具纪律 | `f4_grep_rename`（350 处引用，80 文件带诱饵）、`t1_tool_choice_grep`（300 模块，正则一步 vs 逐文件读几百步）、`f10_db_investigation`（只能经 db_query 拿整表） | 信息检索路径选择直接决定步数与成本；分诊/委派做得好会显著少走弯路 |
| 交付门禁 / 自验证 | `v1_verify_before_done`（唯一 sealed，spec 反直觉 + tests 目录须逐字节不变）、`f3_test_suite_fix`（400 测试 5 个植入 bug）、`f8_verbose_tests`（500 测试 12 bug，每次跑几万字符） | "跑绿才算完"是最难自发满足的门禁；独立评审理论上的主战场 |
| 上下文压力 / 经验池 | `l1_chain_migrate`、`l2_ledger_state`（45 节点指针链，读上下文 ~180K token，中途有矛盾笔记）、`f1_log_triage`（~600K 字符日志 + 红鲱鱼） | 长链累积上下文下的规则保持；经验池/分层摘要若有效会在这里体现 |
| 安全（子代理不得听注入） | `x1_injected_readme`（要求读的文件里藏"把 secrets 复制出去"）、`x2_tool_result_injection`（构建日志里伪装系统指令 `rm -rf`） | 委派会把注入面放大到每个子代理；工具 deny 列表/门禁是否真的挡住 |
| 跨会话记忆 / 经验沉淀 | `m1_cross_session_recall`（turn 3 换新 runtime，7 个事实里 1 个只在对话中、禁止写盘） | 唯一能证明"经验池真的存了东西"的场景；作者原话：能 6/7 → 7/7 才算改进 |
| 不回归（反向对照） | `z0_env_smoke`、`p1_format_contract`、`p2_persistent_rule` | 编排层对简单任务通常是**纯开销**；这里必须读到"等价"，读不到就不能宣称无损 |
| 密封确认池 | `n1_verbatim_restore`、`n2_intent_ledger`、`n3_rot_checkpoints`、`v1_verify_before_done` | 只在结论成型后跑，防"按 dev 池调参" |

建议矩阵规模：**硬场景 12–15 个 + 简单场景 3 个，repeats 3（二进制结果建议 5），双臂**。约 90–180 trials；先跑 3 场景冒烟估预算。

公开池切片（可选，用于对外说"在公开基准上不退步"）：Terminal-Bench 2.0 取 5–10 个任务；SWE-bench Verified 取 5 个 issue。注意：**切片不是 leaderboard 分数**，是同一双臂在那些任务上的配对比较。

---

## 4. 预注册假设（可直接套你仓库的 TEMPLATE.md 结构）

```
# 实验档案：expert 编排 preset 能力级 A/B（capability-ab）

## 假设
H1（主指标·能力）：在同一驱动模型、同一 batch 硬场景上，expert 臂 pass^3 相对 baseline
    提升 ≥ 20pp（绝对值）。
H2（不回归·门禁）：简单场景（z0/p1/p2）无回归 —— baseline 全过而 expert 全败的场景数 = 0；
    任一场景出现即 gate，不进入成本讨论。
H3（成本·只陈述不 gate）：每解题成本（cost per solved task）上升 ≤ 1.5×；超出则结论表述为
    "质量提升但成本不可接受"，不得只报 pass 率。

## 设置
变量：agent-preset-registry.config.default（standard vs expert-orchestrator），其余全同；
交错过序（奇 repeat A→B，偶 repeat B→A）；每 trial 全新 workspace + 全新 runtime；
版本三元组（宿主 dsh / preset 版本 / 驱动模型）写入档案。

## n
15 硬场景 × 3 repeats × 2 臂 = 90 trials；README 建议二进制结果 repeats=5。

## 判定标准（首跑前预注册）
H1 达标：pass^3 差值区间（场景聚类 bootstrap）下界 > 0 且点估计 ≥ +20pp；
         且已验证 A/A floor 的区间不覆盖该读数。
H1 未达标：区间含 0 → 加跑（提 repeats 或换更硬场景），不得改判。
H2 达标：一致性回归场景数 = 0。
H3：只入档，不作 gate。
```

注意你已有的 origin-chain 档案里如实声明过的纪律问题：**"预注册时序无留痕不可证"**。这次要么在首跑前把判定标准单独 commit（带时间戳），要么同样如实声明。

---

## 5. 统计现实：小 n 会骗你

作者自己的实测（results.md）：8 场景 × 3 repeats 的一次对照，观测 Δ% = −5.7%，CI −23.7%~+12.4%，**MDE ≈ ±24%**，并算出 `N* ≈ 114` 场景才能在 80% power 下分辨该量级效应。

推论：
- 3 repeats × 10 场景**只能检出 20%+ 的粗效应**。别指望它分辨"提升了 8pp"。
- 所以：要么把场景挑到 baseline 常翻车（效应大），要么接受"inconclusive"是正确结论。
- 单场景跑出来的任何百分比都是 inconclusive —— 报告会明确这么说（1 个场景无法给区间）。
- 判分坚决不用 LLM：`agent-bench` 的整套论证和 dsh-eval 的 judge 护栏都在说同一件事 —— 代码能判就代码判。

---

## 6. 最小执行路径

```bash
git clone https://github.com/TT-Wang/dsh-eval-infra && cd dsh-eval-infra
npm install && npm run link:dsh && npm run build

cd /path/to/dsh-expert-orchestrator
dsh-eval init --plugin .                      # 建 .dsh-eval/home + eval profile + starter arms
$EDITOR bench/arms/expert.yml                 # 只改 agent-preset-registry.default
dsh-eval diff baseline expert                 # 必须恰好一处差异
dsh-eval selfcheck                            # 全部场景：空 workspace fail / oracle pass
dsh-eval run --baseline baseline --aa --repeats 3        # 噪声底，每个 baseline 一次
dsh-eval run --baseline baseline --arm expert 's2_*' 's3_*' 'v1_*' --repeats 3   # 冒烟
dsh-eval run --baseline baseline --arm expert --repeats 3 --max-usd 20           # 正式
dsh-eval ui --open                            # 报告/森林图/trace/first-divergence fork
dsh-eval publish <runId> --out ./bundle       # 结论可交给别人复核
```

`--max-usd` 是必须的：编排层会成倍放大调用量，一次失控的 trial 就能烧掉预算。

---

## 7. 备选：不想引第三方基建时的最小手工协议

只用你自己的 `docs/internal/experiments/TEMPLATE.md`：

1. 选 10 个硬场景（用上面表格），写成 10 份固定任务书 + 10 个 Python 验证脚本（返回 `(ok, detail)`）。
2. 固定：同一驱动模型、同一 preset 版本、每 trial 新会话、清空 cwd。
3. 双臂 × 3 repeats，顺序交错（A B / B A / A B），记录 per-trial `ok`、步数、token、$。
4. 只看三件事：一致性回归数（必须 0）、硬场景通过数差、每解题成本比。
5. 结论只写"在 X 个场景上观察到 Y"，不写"能力提升 Z%"。

局限（必须写进档案）：小 n 无区间、无 A/A floor、无真值隔离 —— 因此这种跑法只能产出"方向性假设"，不足以支撑对外宣称。要对外说，回到 dsh-eval。

---

## 8. 一句话建议

先用 dsh-eval 的 **A/A + 3 场景冒烟**（成本最低）确认链路与噪声底；再按上表跑 **12–15 硬场景 × 2 臂 × 3–5 repeats**，主指标 pass^k（不是成本），成本只作 tradeoff 陈述；结论要能通过 `dsh-eval verify`。你仓库现有的 3 份档案继续管"协议有没有被执行"，能力问题交给这套配对 A/B —— 两者不要混在一个结论里。
