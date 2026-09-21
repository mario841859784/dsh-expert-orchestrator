# persona 方法论深读区（expert-methods）

本目录为运行时用户数据（USER_DATA 类）：插件升级/重装只补缺、**永不覆盖**已存在文件。

- 用途（P2 persona 方法论分层）：persona frontmatter 可选键 `method: expert-methods/<slug>.md` + 正文 `<!-- methods-cut -->` 标记 → 召唤时子代理 persona 只注入标记之前部分，尾部追加 method 文件绝对路径指针行，任务复杂或触及清单场景时由子代理先 read 再动手。
- fail-safe：无标记 / 无 method 键 / method 文件缺失 → 全文注入（向后兼容）。来源包专家不带 method 键 = 行为零变化。
- 现状：目录仅本占位说明；**Top-5 methods 内容由 T4（技术文档工程师）填充**，本任务不写任何 methods 内容。
