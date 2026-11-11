# LAUNCH-NOTE：autoapprove-steal-ab-r2 首跑记录

- 首跑时间：2026-11-11 22:09（本地时间，DSH 宿主时区）
- 组织者：编排者（lead）；驱动模型：glm-5.3-flash；宿主：DSH 0.2.2-rc.1；preset：expert-orchestrator
- 协议文本：仓库副本 skills/expert-orchestration/SKILL.md（T23 规则 6 重拟后版本，commit ba454fc）
  - sha256 = 1e2e589e67722f7b7170a6afca9e4ed59ff4b49cf8ec6aff50c00125e6b830d0
- 冻结核验（首跑前，编排者侧复核+tech-writer FREEZE-NOTE 双重留痕）：
  - B 臂重跑 r2 build-b-arm.sh 产物与冻结件 diff 为空：AB-R2-S3-01/02/03-B 全部 FREEZE-OK
  - BRIEF-HASHES.txt 对账 7/7 OK（含 PROBE-STRINGS.txt）；A 臂与首档情境逐字节（仅路径行差异）
  - 双向探针：A 臂 4 串合计 0 命中（泄漏阴性）；B 臂 4/4 含规则 6 新串
  - 落盘路径行 -A/-B 唯一正确（首档缺陷 a 修正在组版层生效）
- Trial 设计：S3 情境（沿首档 AB-AU-03-A.md 逐字节）× A/B 两臂 × n=3（AB-R2-S3-01/02/03）；每 trial 全新子代理（无父会话上下文），prompt 仅指向冻结任务书文件路径为唯一刺激物（A/B prompt 逐字一致）；演算题模式，子代理不写任何文件（除任务书指定落盘报告）
- 判定主探针=规则 6 新串（PROBE-STRINGS.txt 第 3 行，build-b-arm.sh --probes 6 产物）逐字 grep -F；A 臂同探针应零命中；判定按 r2 PREREGISTRATION.md 冻结标准（到达率 3/3+无误扰零回退），跑后不改判
