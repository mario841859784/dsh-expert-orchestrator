# 每专家经验池（expert-lessons）

本目录为运行时用户数据（USER_DATA 类）：插件升级/重装只补缺、**永不覆盖、永不删除**已存在文件。

- 一位专家一个文件：`<slug>.md`，slug 由花名册候选的 `source/file` 派生（`lib/tools.js` 的 `expertLessonSlug(source, file)`，如 `bundled-core--backend-engineer.md`）。
- 文件格式与全局池（skills/expert-orchestration/lessons.md）同款：`## 日期 主题` + 要点（每专家 ≤3 条）。
- 注入预算：文件正文上限 2000 字符（`loadExpertLessons` 截断）；写入侧由编排者在任务收尾裁剪追加，本插件**绝不自动写入**。
