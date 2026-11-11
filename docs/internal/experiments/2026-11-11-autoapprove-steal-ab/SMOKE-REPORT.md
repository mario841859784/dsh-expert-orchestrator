# SMOKE-REPORT — autoapprove-steal-ab 首跑前工具面冒烟（T17）

- 日期：2026-11-11；执行人：tech-writer（T17 协议面）；对象：T17 协议改版后 SKILL.md §3.2 规则行 4-7 与 §9 两处新说明所引用的**每条命令/错误码**。
- 方法：/tmp 临时板（`/tmp/t17smoke/board.json`，与本仓任务板隔离），脚本逐条执行并按输出子串断言；判定先于报告（脚本 exit=0 才视为通过）。完整逐条转写见文末。
- 结果：**31/31 PASS，0 FAIL**（脚本退出码 0）。

## 冒烟矩阵与结论

| 组 | 覆盖项（SKILL.md 引用面） | 结果 |
| --- | --- | --- |
| A1/A1b/A2 | --auto-ready 入口约束：缺 --created-by/--of 拒（`--auto-ready 仅支持代理自建路径`）；与 --draft 互斥 | PASS |
| B1/B2 | 免审通过面：--auto-ready 直达 ready；created_by 落档；checkpoint 注记「免审批创建（--auto-ready）」；事件 args auto_ready:true+open_count | PASS |
| B3/B4/B5 | ⑥ open 上限恒生效：cap=2 已满拒 `agent_create_open_cap`；hint 指路 `open-counts` 探针；open-counts 输出 `专家甲: 2 个开放任务` | PASS |
| B6 | ⑧' dep 未全 done 拒 `agent_create_dep_open` | PASS |
| B7 | ⑧ dep 跨 owner 拒 `agent_create_dep_cross_owner` | PASS |
| B8 | ⑧' dep 全 done → 免审通过直达 ready | PASS |
| B9 | ⑦ 父任务非 open 拒 `agent_create_parent_closed` | PASS |
| B10 | --kind review 同传永不免审拒 `agent_create_kind_rejected` | PASS |
| C1/C1b | 上限 env 非法值宁拒勿猜：`DSH_EXPERT_PEER_OPEN_CAP=0` → `须为正整数` 拒绝 | PASS |
| D1/D2 | claim_idle --steal 窃取成功面：stolen_from=上一手 owner+checkpoint「让渡」注记+事件 args steal:true/previous_owner | PASS |
| D3 | 反回摆：候选 stolen_from==本人拒 `steal_ping_pong`（fail→retry 回 ready 后窃回被拒） | PASS |
| D4/D4b/D5 | 双侧空闲闸：claimant 侧有 running 拒（`"side": "claimant"`）；被窃 owner 侧有 running 拒（`"side": "owner"`） | PASS |
| D6 | 不带 --steal 全板空闲闸逐字节不变（`board_not_idle`） | PASS |
| E1/E2 | T13 开关对照：缺省关闭时超限 claim 成功；`DSH_EXPERT_ANTISTORM_ENFORCE=1` 时拒 `open_cap_exceeded` | PASS |
| F1/F2/F3 | escalation 上限：m 票评审 3 轮双 fail 票 → escalated+escalation_count=1 落档；用户 retry 解除升级（count 不清零）后 reassign 拒 `escalation_limit_exceeded` | PASS |
| G1/G2/G3 | T14 绑定：`DSH_EXPERT_ATTEMPT_BIND_OWNER=1` 时代际落 attempt_owner=落定 owner；done --by 他人拒 `attempt_owner_mismatch`；本人汇报通过 | PASS |
| H1 | 执法关闭回归对照：同场景 claim 成功（缺省零行为变化） | PASS |

## 冒烟中发现并处置的问题（均在首跑前）

1. **build-b-arm.sh 计数锚 bug（工具面，非判定标准）**：用法 1 的规则行计数 grep 锚写成无前缀形态（`^[4-7]\. `），对已加 "> " 前缀的插入块恒为 0 → 误报「未提取到规则行」。修复：锚改为 `^> [4-7]\. `（修复随 T17 协议改版 commit 落盘，先于任何 trial 启动）。提取语义（awk 块锚定+反引号内原文）未变，--probes 产物与修复前逐字一致（PROBE-STRINGS.txt 冻结件可复核）。
2. **冒烟脚本自身两处口径修正**（不影响被测对象）：① done 仅对 running 生效（创建后须先 claim）；② 反回摆探针 claimant 名须与 stolen_from 逐字一致（专家丙 vs 丙）。
3. **实现面零改动**：冒烟未发现 SKILL.md 新文本与 taskboard.py 行为的任何脱节；无协议文本回退。

## 关联门禁留痕

- 全量 selftest：22 个套件，**574 pass / 0 fail / 2 skipped**（基线 536 套件口径上 T13-T16 新增套件后全绿）。
- §5 任务书模板（SKILL.md:124-148）：git diff 零触碰（本次 SKILL.md 改动仅 §3.2 规则行块、§9 create/claim_idle 行尾与 env 速查表两行）。
- B 臂冻结件 AB-AU-0{1,2,3}-B.md 与 PROBE-STRINGS.txt 已程序化生成并冻结 hash（BRIEF-HASHES.txt）；双向 grep 留痕：B 臂 4/4 逐字命中、A 臂 0 命中、除插入块外 B 与 A 逐字节一致（三组均过）。

## 完整逐条转写

```
== A. --auto-ready 入口约束 ==
PASS [A1] 非零退出（拒绝）
PASS [A1b] --auto-ready 仅支持代理自建路径
PASS [A2] --draft 与 --auto-ready 互斥
== B. 免审链 ⑥⑦⑧⑧' 逐错误码 ==
PASS [B3] agent_create_open_cap
PASS [B4] open-counts
PASS [B5] 专家甲: 2 个开放任务
PASS [B1] ready
PASS [B2] happy path: status=ready + created_by + checkpoint 免审注记 + 事件 args auto_ready/open_count
PASS [B6] agent_create_dep_open
PASS [B7] agent_create_dep_cross_owner
PASS [B8] ready
PASS [B9] agent_create_parent_closed
PASS [B10] agent_create_kind_rejected
== C. _env_positive_int 宁拒勿猜 ==
PASS [C1] 非零退出（拒绝）
PASS [C1b] 须为正整数
== D. claim_idle --steal 双侧闸/反回摆/留痕 ==
PASS [D1] running
PASS [D2] steal 留痕：stolen_from + checkpoint 让渡注记 + 事件 args steal/previous_owner
PASS [D3] steal_ping_pong
PASS [D4] steal_owner_active
PASS [D4b] "side": "claimant"
PASS [D5] "side": "owner"
PASS [D6] board_not_idle
== E. 写面执法（T13）缺省关/开启对照 ==
PASS [E1] 缺省（执法关）：超限 claim 成功
PASS [E2] open_cap_exceeded
== F. escalation 上限（T13）==
PASS [F1] escalated
PASS [F2] escalation_count=1 落档
PASS [F3] escalation_limit_exceeded
== G. attempt 绑 owner（T14）==
PASS [G1] attempt_owner=落定 owner 落档
PASS [G2] attempt_owner_mismatch
PASS [G3] 本人汇报通过
== H. 既有语义回退对照（缺省零行为变化） ==
PASS [H1] 执法关闭时超限 claim 成功（缺省零行为变化）

冒烟结果：PASS=31 FAIL=0
```
