# FREEZE-NOTE：r3 冻结核验留痕（首跑前，2026-11-11，tech-writer/T24）

## 协议文本基线
- SKILL.md（T24 规则 6 重拟后、本档案 commit 前工作树副本）sha256 = 8257ef1b8c13d0598f1cc41044fe1ba7a045ea9ed399dac781126229656d123d

## 双向探针（PROBE-STRINGS.txt 4 条串 × 6 份冻结件，grep -cF -e 逐字）
- AB-R3-S3-01-A.md 四串合计命中 = 0（预期 0，组间泄漏阴性）
- AB-R3-S3-02-A.md 四串合计命中 = 0（预期 0，组间泄漏阴性）
- AB-R3-S3-03-A.md 四串合计命中 = 0（预期 0，组间泄漏阴性）
- AB-R3-S3-01-B.md 探针命中 = 4/4（预期 4/4，第 3 条=规则 6 新串）
- AB-R3-S3-02-B.md 探针命中 = 4/4（预期 4/4，第 3 条=规则 6 新串）
- AB-R3-S3-03-B.md 探针命中 = 4/4（预期 4/4，第 3 条=规则 6 新串）

## 组版一致性（剥离插入块（以「>」起头的行）后 A/B 应仅落盘路径行 -A/-B 差异）
- AB-R3-S3-01：剥离插入块 diff 中非落盘路径行 = 0（预期 0）
- AB-R3-S3-02：剥离插入块 diff 中非落盘路径行 = 0（预期 0）
- AB-R3-S3-03：剥离插入块 diff 中非落盘路径行 = 0（预期 0）
- A 臂与 r2 档案情境逐字节核验（第 4 行落盘路径行除外 diff 为空）：
  → 空 diff 确认（AB-R3-S3-0{1,2,3}-A.md 对 AB-R2-S3-0{1,2,3}-A.md 各仅 4c4 路径行一处）

## hash 对账（BRIEF-HASHES.txt）
AB-R3-S3-01-A.md: OK
AB-R3-S3-02-A.md: OK
AB-R3-S3-03-A.md: OK
AB-R3-S3-01-B.md: OK
AB-R3-S3-02-B.md: OK
AB-R3-S3-03-B.md: OK
PROBE-STRINGS.txt: OK

## 规则 6 新探针串（build-b-arm.sh --probes 6 产物，逐字）
attempt_owner=落定 owner：自报口径不得谎报，以 show 回显为准，claim --attempt 为合法接管非绕过且绑定随接管翻新
