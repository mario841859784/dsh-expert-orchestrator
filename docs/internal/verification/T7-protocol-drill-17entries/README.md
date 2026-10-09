# T7（v2.9 M1）T1 发布面漂移收口沙箱演练证据归档

- 任务：T7（T1 联动）；归档 T1 沙箱演练产物（原 /tmp/t1-drill/，易失，先复制后提交），沿 T41 v2.8 演练法。
- 演练口径：真实 `apply()` 路径（`lib/index.js` 默认导出，非刷新逻辑复刻），`config.targetDir` 指向 /tmp 沙箱；stale marker `2.7.1+sources1` 触发刷新；VERSION 字面量零改动（版本 bump 属 T5）；真实部署目录全程只读对照（`.deployed-version` 前后一致 `2.8.0+sources1`）；二刷幂等（第二次 `apply()` 零刷新、marker 不动）。
- 证据结论（refresh-drill.out）：17 条 PROTOCOL 条目（14 旧 + 新增 README.md/README.zh.md/CHANGELOG.md）展开 60 文件 sha256 与包内逐字节全一致，USER_DATA 零触碰、刷新目录内用户附加文件不删除 → ALL PASS（exit 0）。
- 产物：refresh-drill.mjs（演练脚本）+ refresh-drill.out（完整输出，24 行）；验证日期 2026-10-09 21:01，基线=T1 工作树（T1 改动落地后、提交 7d4b877 前，同一工作树）。
