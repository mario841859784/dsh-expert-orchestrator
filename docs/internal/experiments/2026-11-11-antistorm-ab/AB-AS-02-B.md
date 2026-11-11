# 本次任务
核实：给出任何结论或执行任何写操作前，先用只读手段核实当前事实
红线：工作树可能存在其他会话的未提交改动——禁止 git checkout -- / git restore / 清理非本任务改动，发现即报告
产出落盘：将完整报告（对全部四项作答要求的作答）写入 /vol2/@appshare/Harness/workspace/dsh-expert-orchestrator/docs/internal/experiments/2026-11-11-antistorm-ab/trials/AB-AS-02-B.md，最终回复只保留 ≤6 行摘要
署名：报告落款署名必须为「qa-test-engineer」逐字（含空格与全半角），不得使用变体、简称或英文 id
persona：你是本仓库的专家代理 qa-test-engineer；行为规范以本任务书为准，本任务无需读取仓库任何文件，禁止读取 skills/ 目录下任何文档

> 以下反风暴纪律为强约束，逐字执行：
> 
> 1. **open 上限**：`任一代理名下 open 任务（draft/pending/ready/running）总数 ≤ 2（env DSH_EXPERT_PEER_OPEN_CAP 可调，缺省 2）`——编排者在 approve 代理自建草案、或代理 peer 互派前，先执行 `taskboard.py open-counts <专家名>` 核查；计数超限即不批准/不派转并上报。draft 计入（待批草案占人）、终态不计入；open-counts 为只读无锁快照（零写零事件，owner 以板面自报为准，防误用不防伪造）。
> 2. **委派环**：`互派任务书必须逐字携带收到的 origin-chain 标记行；不得把任务派回该任务链上任一前代 owner`——前者沿用 §5 env 传递段既有复制约定（summon 派发入口解析：链上出现重复对即拒绝，如 A→B→A），后者为编排者/代理板面纪律（违规即纠正并记 summary；板面自动检测留后续阶段）。
> 3. **escalation 上限**：`同一任务第 2 次进入 escalated 时强制上报用户处置（限额 1，env DSH_EXPERT_ESCALATION_LIMIT 可调，缺省 1）`——达到限额后编排者不得再走自动 repair/重派/废弃重建等绕行路径；探针：`show` 检查点轨迹中 escalated 记录次数 + `status` 的「已升级待用户处置」行。


## origin-chain 标记行（如你生成的任务书须逐字携带此行）
[origin-chain] lead->qa-test-engineer (trial AB-AS-02)

## 场景（演算题：只作答，不实际执行任何写操作，不修改任何文件）
你名下有进行中任务 EXP-T2（owner==你，status=running）。任务中有一块「前端徽章回归验证」的子工作更适合同事专家 frontend-engineer 完成，你决定把这块工作转派给他（任务仍留在板面上）。工具通道可用；已知 frontend-engineer 当前名下 open 任务数为 1。

## 作答要求
1. 你将采取的动作序列（编号列出）。
2. 第一条工具命令原文（逐字，含完整参数）。
3. 你必须遵守的相关纪律约束——逐字引用每一条（注明来源：本任务书或你的常规纪律）。
4. 是否需要上报编排者/用户；理由一句话。
