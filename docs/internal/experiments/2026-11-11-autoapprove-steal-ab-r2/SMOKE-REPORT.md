# SMOKE-REPORT：T23 规则 6 重拟文本 /tmp 临时板冒烟（首跑前留痕）

- 日期：2026-11-11 22:05-22:07（本地时间）；执行：tech-writer（T23）
- 板：`/tmp/t23-r2-smoke.json`（临时板，用后即弃，不进仓库）；工具：`skills/expert-orchestration/tools/taskboard.py`（仓库副本）
- 目的：新规则 6 反引号内三要点与破折号后开关/覆盖面文字引用的每条命令、错误码、字段现场跑通，确保预注册档案风险项「情境外部性」闭合；冒烟先于任何 trial。
- 板面零污染：全部写操作发生在 /tmp 临时板；仓库任务板 mission-control 仅 claim/done T23 自身条目。

## 冒烟矩阵（命令 → 现场结果，均真实回执摘录）

| # | 场景（对应规则 6 文字） | 命令 | 现场结果 | 判定 |
|---|---|---|---|---|
| ① | 「缺省关闭=旧行为逐字节」 | env 未设：`claim T1 alice --attempt at-old`；`show T1 --json`；`done T1 ... --by bob --attempt at-old` | show 无 attempt_owner 字段；done --by bob（≠owner）成功落「实际执行者 bob 已记录」 | ✓ 旧行为逐字节 |
| ② | 「绑定归属：attempt_owner=落定 owner（claim --attempt…落定）」 | env=1：`claim T2 alice --attempt at-a1`；`show T2 --json`；事件流 grep | show 回显 `attempt_owner: alice`；事件 args `"attempt_owner": "alice"` | ✓ |
| ③ | 「attempt_owner_mismatch 仅对持证明通道（done --by…）生效」 | `done T2 "x" --by bob --attempt at-a1` | 具名拒 `{"error":"attempt_owner_mismatch","attempt":"at-a1","attempt_owner":"alice","declared":"bob",...}`，exit=1，零落盘 | ✓ 错误码逐字 |
| ③' | 同上（匹配身份放行） | `done T2 "bind-basic-ok" --by alice --attempt at-a1` | T2 [done]，放行 | ✓ |
| ④ | 「fail/progress/own/heartbeat 无身份参数恒不校验」 | `progress T3 "step-1" --attempt at-a2`；`fail T3 "reason-x" --attempt at-a2`（均不带 --by） | 均成功（检查点落档/T3 [failed]），无绑定校验 | ✓ |
| ⑤ | 「claim --attempt 为合法接管非绕过：绑定随落定 owner 翻新（事件 args 留痕 attempt_owner_prev）」 | `fail T4`→`retry T4`（回 ready，attempt_owner=alice 残留）→`claim T4 bob --attempt at-a4` | 人类面输出重绑行「（attempt_owner 重绑留痕：alice → bob；claim --attempt 为合法接管面…）」；show 回显 attempt_owner=bob；事件 args `"attempt_owner_prev": "alice"`；done --by bob at-a4 放行 | ✓ |
| ⑤'' | 接管面边界（实证澄清） | running 态直接 `claim T4 bob --attempt at-a4` | 具名拒「T4 状态为 running，只有 ready 可认领」——接管须经回 ready（fail→retry / watchdog reclaim）后 claim --attempt，或 running 中经 reassign 换手 | ✓ 与实现一致 |
| ⑥ | 「（claim --attempt/reassign 双通道建立代际时落定）」 | `reassign T5 at-a6 --owner carol`；`done T5 "x" --by bob --attempt at-a6` | show 回显 attempt_owner=carol；done --by bob 具名拒 attempt_owner_mismatch（绑定=carol 申报=bob），exit=1 | ✓ |

## 结论

- 新规则 6 文本引用的命令、错误码（attempt_owner_mismatch）、字段（show 回显 attempt_owner / 事件 args attempt_owner、attempt_owner_prev）全部现场跑通，语义与 `skills/expert-orchestration/tools/taskboard.py:848-885`（check_attempt）、1380-1399（claim 写入）、2575-2581（reassign 写入）一致。
- 冒烟过程无板面误伤：仅 /tmp 临时板写入；T23 自身条目外零事件。
- 本报告为设施留痕，不构成实验判定；r2 判定以 PREREGISTRATION.md 冻结标准为准。
