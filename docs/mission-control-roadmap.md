# 任务板 mission-control 模式：现状核实与演进路径（权威上下文）

> 本文是「代理自主写任务板」议题的权威上下文文档：第一部分记录对现有实现的可写面核实结论（file:line 精确引用），第二部分归纳六个提升维度，第三部分给出三阶段演进路径。后续规划与实施均以本文为基线引用，不推翻既有存储模型。

## 现状核实

**已有代理可写面（治理件完备）：**

- `claim_idle` 原子拉式认领：代理可安全认领空闲任务，无快照/认领窄窗竞态（skills/expert-orchestration/tools/taskboard.py:1163）。
- `done --verdict needs_revision` 自动生成 repair 任务并做下游 DAG 重排——repair 的来源是「工具自动编排而非人工规划」，不经 draft 直接 ready，repair_of 字段回指原任务（taskboard.py 头部注释 21-31 行）。
- `vote` m 票互评：每票落账后按票箱即时评估，≥m 张同向布尔票且零反向票才生效（taskboard.py:1536）。
- budget / watchdog / heartbeat / replay / own / origin-chain（lib/origin-chain.js）等治理件已就位。
- 全程 CAS（`--expected-revision`）并发保护，事件流可追溯。

**仍是 lead 特权的写操作（代理不可触达）：**

- `create`：无来源者字段，无法区分任务由谁创建（taskboard.py:1020）。
- `reassign`：attempt_id 注释明说「新派工代际 attempt_id（编排者生成）」，代际生成是编排者职责，代理不能自行建立（taskboard.py:2127 与 2735 行）。
- `approve`：PM 规划草案批准，draft → ready 的唯一入口（taskboard.py:1233）。

结论：代理侧「读与认领」已是原子、可审计的；但「建任务、派任务、批任务」三件事被刻意收在 lead 手中——当前模式是「半自治」：代理执行与互评自由，编排与审批集中。

## 提升维度

1. **写权限分级**：代理 scoped 自建——代理创建 follow-up/repair 任务时 write_scopes ⊆ 自身任务 scope，委派深度由 origin-chain 链长推导；复用既有 draft→approve 审批流；互派 reassign 的 attempt_id 改为 capability token 化。
2. **身份与信任**：`--by` 落款即身份在开放写路径下不足，需 attempt token 与 owner 绑定、代际校验；深度/权限一律由链长或服务端推导，不信任代理自报计数字段。
3. **自组织调度**：任务声明能力标签，claim_idle 按能力匹配过滤；budget 计数与 heartbeat 作负载信号，可加优先级 / work-stealing。
4. **协议层**：expert-orchestration skill 增补代理自建 / 互派纪律与反风暴规则——每代理 open 任务上限、委派环检测、escalation 上限沿用 REVIEW_ROUND_LIMIT 范式（taskboard.py:193）。
5. **护栏与失控防护**：全局 open 任务 caps；mission-control 按板 opt-in 开关；用户随时否决（archive/escalate）；审计面复用 replay。
6. **UI 配套**：代理创建任务加来源标注（created-by）；「提议待批准」做成一等交互；origin chain 可视化复用 ownerNames 分组布局。

## 演进路径

三阶段递进，各阶段均搭在既有 CAS / 事件流 / replay 之上，不推翻存储模型。

- **阶段一（低风险高复用）**：代理 scoped 自建任务 + 强制 draft→approve 审批；UI 加来源标注与待批收件箱。只放宽「建」，保留「批」在用户/PM 手中，风险最低、复用度最高。
- **阶段二**：peer 互派（attempt capability 化）+ 能力标签匹配认领 + skill 协议改版 + 反风暴规则。放宽「派」，以 capability token 与协议纪律兜底。
- **阶段三**：全自动自组织（受限免审批创建、work-stealing），依赖前两阶段的身份、预算、环检测全部就位。

每一阶段以成熟的前一阶段治理件为前提，逐步把「编排与审批集中在 lead」过渡到「受治理的代理自治」。
