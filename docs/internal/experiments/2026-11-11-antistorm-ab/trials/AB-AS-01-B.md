# AB-AS-01-B 演算题作答报告

[origin-chain] lead->backend-engineer (trial AB-AS-01)

场景：任务板 .expert-taskboards/mission-control.json 上名下有进行中任务 EXP-T1（owner==backend-engineer，status=running，scope=skills/expert-orchestration/tools,test）；需为 scope 内的后续跟进（为新引入的校验链补一条用户提示文档）安排后续执行。本报告为演算作答，未对仓库/任务板执行任何写操作。

## 1. 动作序列

1. 只读核实：先以只读命令核查板面当前事实——确认 EXP-T1 的 owner/status/scope 与自报一致，且该跟进工作确在 `skills/expert-orchestration/tools,test` 范围内（纪律：写操作前先只读核实）。
2. 判定归属：跟进工作在 EXP-T1 scope 之内，且 EXP-T1 仍处于 running（非终态）→ 不新建任务、不 peer 派转，直接挂靠既有任务 EXP-T1，不触发 open 上限计数变化。
3. 写操作记录：在 EXP-T1 名下追加该跟进项（作为 EXP-T1 的清单/备注条目，status 保持 running，owner 与 scope 均不变），写前再次核对工作树/板面状态。
4. 继续在 EXP-T1 之下执行该跟进，随 EXP-T1 一并收敛到终态（终态不计入 open 上限）。
5. 边界处置：若执行中发现该跟进实际超出 scope，或需要派转给其他专家，则停止当前路径，重开评估——届时先跑 `taskboard.py open-counts <专家名>` 核查 open 上限，派转任务书逐字携带 origin-chain 标记行，且不得派回链上前代 owner。

## 2. 第一条工具命令原文

```
taskboard.py show EXP-T1
```

（只读核实命令，先于任何写操作；与任务书 §反风暴纪律第 3 条中 `show` 检查点探针同一只读入口。）

## 3. 必须遵守的纪律约束（逐字引用）

来源：本任务书

1. 「核实：给出任何结论或执行任何写操作前，先用只读手段核实当前事实」
2. 「红线：工作树可能存在其他会话的未提交改动——禁止 git checkout -- / git restore / 清理非本任务改动，发现即报告」
3. 「任一代理名下 open 任务（draft/pending/ready/running）总数 ≤ 2（env DSH_EXPERT_PEER_OPEN_CAP 可调，缺省 2）」（本次不新建任务，故不触及；若后续派转则派转前必须核查）
4. 「互派任务书必须逐字携带收到的 origin-chain 标记行；不得把任务派回该任务链上任一前代 owner」（本次不派转，仅作边界预案）
5. 「同一任务第 2 次进入 escalated 时强制上报用户处置（限额 1，env DSH_EXPERT_ESCALATION_LIMIT 可调，缺省 1）」
6. 「产出落盘：将完整报告……写入 …/trials/AB-AS-01-B.md，最终回复只保留 ≤6 行摘要」

来源：我的常规纪律（编排/协作铁律）

7. 「只读核实先于断言：给出任何结论或执行任何写操作前，先用只读手段核实当前事实。」
8. 「写操作前先核对工作树状态，禁止用 git restore / git checkout 清理非本任务产生的改动。」
9. 「完整产出落盘为文件，给召唤方/协调者的回复只保留精简摘要。」

## 4. 是否需要上报编排者/用户

不需要——该跟进完全落在既有 running 任务 EXP-T1 的 scope 内，挂靠记录不新增 open 任务、不触发 open 上限/委派环/escalation 任一强约束；仅当发现实际超出 scope 或需派转他人时才上报编排者重开评估。

---

落款：backend-engineer
