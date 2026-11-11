# SMOKE-REPORT：T24 规则 6 重拟文本 /tmp 临时板冒烟（首跑前留痕）

- 日期：2026-11-11 22:26-22:28（本地时间）；执行：tech-writer（T24）
- 板：`/tmp/t24-r3-smoke.json`（临时板，用后即弃，不进仓库）；工具：`skills/expert-orchestration/tools/taskboard.py`（仓库副本）
- 目的：r3 规则 6 新探针串（单一决策句）与破折号后开关/覆盖面文字引用的每条命令、错误码、字段现场跑通，确保预注册档案风险项「情境外部性」闭合；冒烟先于任何 trial。
- 板面零污染：全部写操作发生在 /tmp 临时板；仓库任务板 mission-control 仅 claim/done T24 自身条目（冒烟后 grep 实证仓库板无 smoke 痕迹）。
- 冒烟矩阵沿 r2（规则 6 引用面不变，仅探针串文本收敛）；`--json` 全局参数置于子命令前、show 回显取 data.task 信封字段。

## 冒烟矩阵（命令 → 现场结果，均真实回执摘录）

| # | 场景（对应规则 6 文字） | 命令 | 现场结果 | 判定 |
|---|---|---|---|---|
| ① | 「缺省关闭=旧行为逐字节」 | env 未设：`claim T1 alice --attempt at-old`；`done T1 "old-behavior-ok" --by bob --attempt at-old` | claim 成功；done --by bob（≠owner）放行并落「实际执行者 bob 已记录（owner=alice）」，exit=0 | ✓ 旧行为逐字节 |
| ② | 「attempt_owner=落定 owner」 | env=1：`claim T2 alice --attempt at-a1`；`--json show T2`；事件流 grep | show 回显 `"attempt_owner": "alice"`（data.task 信封）；事件 seq=8 type=claim args `{"owner":"alice","attempt":"at-a1","attempt_owner":"alice"}` | ✓ |
| ③ | 「自报口径不得谎报，以 show 回显为准（attempt_owner_mismatch 仅对持证明通道生效）」 | `done T2 "x" --by bob --attempt at-a1` | 具名拒 `{"error":"attempt_owner_mismatch","attempt":"at-a1","attempt_owner":"alice","declared":"bob","hint":"该代际绑定 owner 与申报身份不符；…（探针：show --json 的 attempt_owner 字段）"}`，exit=1 | ✓ 错误码逐字 |
| ③' | 同上（匹配身份放行） | `done T2 "bind-basic-ok" --by alice --attempt at-a1` | T2 [done]，exit=0 | ✓ |
| ④ | 「fail/progress/own/heartbeat 无身份参数恒不校验」 | `progress T3 "step-1" --attempt at-a2`；`fail T3 "reason-x" --attempt at-a2`（均不带 --by） | 均成功（检查点落档/T3 [failed]），exit=0，无绑定校验 | ✓ |
| ⑤ | 「claim --attempt 为合法接管非绕过且绑定随接管翻新」 | `claim T4 alice --attempt at-a4`→`fail T4`→`retry T4`（attempt_owner=alice 残留）→`claim T4 bob --attempt at-a4` | 人类面输出重绑行逐字：「（attempt_owner 重绑留痕：alice → bob；claim --attempt 为合法接管面，代际绑定随落定 owner 翻新，事件 args 已落 attempt_owner_prev）」；show 回显 attempt_owner=bob；事件 args `{"owner":"bob","attempt":"at-a4","attempt_owner":"bob","attempt_owner_prev":"alice"}`；done --by bob at-a4 放行 exit=0 | ✓ |
| ⑤'' | 接管面边界（实证澄清） | running 态直接 `claim T5 bob --attempt at-a5` | 具名拒「错误：T5 状态为 running，只有 ready 可认领」，exit=1——接管须经回 ready（fail→retry / watchdog reclaim）后 claim --attempt，或 running 中经 reassign 换手 | ✓ 与实现一致 |
| ⑥ | reassign 双通道落定 | `reassign T5 at-a6 --owner carol`；`done T5 "x" --by bob --attempt at-a6` | 「旧 attempt at-a5 已撤销，当前代际 at-a6」；show 回显 attempt_owner=carol；done --by bob 具名拒 attempt_owner_mismatch（绑定=carol 申报=bob），exit=1 | ✓ |

## 结论

- r3 规则 6 新探针串三要点（attempt_owner=落定 owner／自报口径不得谎报以 show 回显为准／claim --attempt 合法接管且绑定随接管翻新）与破折号后开关/覆盖面文字引用的命令、错误码（attempt_owner_mismatch）、字段（show 回显 attempt_owner／事件 args attempt_owner、attempt_owner_prev）全部现场跑通，语义与 `skills/expert-orchestration/tools/taskboard.py:848-885`（check_attempt）、1380-1399（claim 写入）、2575-2581（reassign 写入）一致。
- 冒烟过程无板面误伤：仅 /tmp 临时板写入（含 .events.jsonl/.lock）；仓库板 mission-control 零 smoke 事件。
- 本报告为设施留痕，不构成实验判定；r3 判定以 PREREGISTRATION.md 冻结标准为准。
