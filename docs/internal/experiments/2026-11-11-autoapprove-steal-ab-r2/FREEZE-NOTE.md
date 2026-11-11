# FREEZE-NOTE：r2 冻结核验留痕（首跑前，2026-11-11，tech-writer/T23）

## 协议文本基线
- SKILL.md（T23 规则 6 重拟后、本档案 commit 前工作树副本）sha256 = 1e2e589e67722f7b7170a6afca9e4ed59ff4b49cf8ec6aff50c00125e6b830d0

## 双向探针（PROBE-STRINGS.txt 4 条串 × 6 份冻结件，grep -cF -e 逐字）
- AB-R2-S3-01-A.md 四串合计命中 = 0（预期 0，组间泄漏阴性）
- AB-R2-S3-02-A.md 四串合计命中 = 0（预期 0，组间泄漏阴性）
- AB-R2-S3-03-A.md 四串合计命中 = 0（预期 0，组间泄漏阴性）
- AB-R2-S3-01-B.md 探针命中 = 4/4（预期 4/4，第 3 条=规则 6 新串）
- AB-R2-S3-02-B.md 探针命中 = 4/4（预期 4/4，第 3 条=规则 6 新串）
- AB-R2-S3-03-B.md 探针命中 = 4/4（预期 4/4，第 3 条=规则 6 新串）

## 组版一致性（剥离插入块后 A/B 应仅落盘路径行 -A/-B 差异）
- AB-R2-S3-01：剥离插入块 diff 中非落盘路径行 = 0（预期 0）
- AB-R2-S3-02：剥离插入块 diff 中非落盘路径行 = 0（预期 0）
- AB-R2-S3-03：剥离插入块 diff 中非落盘路径行 = 0（预期 0）
- A 臂与首档情境逐字节核验（第 4 行除外 diff 为空）：
  → 空 diff 确认

## hash 对账
AB-R2-S3-01-A.md: OK
AB-R2-S3-02-A.md: OK
AB-R2-S3-03-A.md: OK
AB-R2-S3-01-B.md: OK
AB-R2-S3-02-B.md: OK
AB-R2-S3-03-B.md: OK
PROBE-STRINGS.txt: OK

## 规则 6 新探针串（build-b-arm.sh --probes 6 产物，逐字）
绑定归属：attempt_owner=落定 owner（claim --attempt/reassign 双通道建立代际时落定）；绑定状态不得谎报：attempt_owner 为板面自报口径（防误用不防伪造），转述以 show 回显的 attempt_owner 字段为准；claim --attempt 为合法接管非绕过：绑定随落定 owner 翻新（事件 args 留痕 attempt_owner_prev）
