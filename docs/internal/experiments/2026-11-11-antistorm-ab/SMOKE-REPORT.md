# SMOKE-REPORT：首跑前工具面-协议文本冒烟核对（antistorm-ab）

- 日期：2026-11-11；执行：tech-writer（T10，commit afc7e60）——预注册风险节要求的「首跑前按 §3.2 对 taskboard.py 当前实现做一次冒烟核对并留痕」。
- 方式：/tmp 临时板逐条实证协议文本与工具实现一致性（防协议-实现脱节，2.13.7 教训）。
- 核对项与结果（详见 T10 交付摘要与 bus m17943895095271677274442 前后记录）：
  1. M1 校验链：create --created-by/--of 成对/非空 scope/draft 强制/kind 互斥/owner 自建自领，7 具名错误码逐条触发验证 ✓
  2. 互派通道：reassign <id> auto --attempt <当前代际> 双条件；at-<16hex> 工具生成并回显；stale_proof/no_attempt/attempt_source_conflict 具名拒 ✓
  3. tags：create --tags 落数组；claim --tags 交集门 tag_mismatch；claim_idle --tags 逐候选跳过 ✓
  4. open-counts：人读 + --json（全局旗标须置子命令前——冒烟中发现并已修正协议文本表述）✓
- 后续工具面变更：T12 跟进修复（0cb1414，评审 🟡/🟢）不改变上述口径，npm test 551/549/0 fail/2 skipped 持平。
- 结论：实验首跑时工具面与协议文本对齐，冒烟通过。
