# Issue #1 跟进评论稿（中文）

> 跟进对象：[issue #1 — 目前不能给expert的专家指定模型，只能用主会话的模型](https://github.com/mario841859784/dsh-expert-orchestrator/issues/1)（@XSANElimos）
> 勘误对象：本 issue 已发布评论 [6730390548](https://github.com/mario841859784/dsh-expert-orchestrator/issues/1#issuecomment-6730390548) 中「专家档案项目层文件为 `<当前工作目录>/.dsh/expert-profiles.json`」的表述。
> 状态：草稿，待编排者审后发布（发布时剥离本稿头）。修复生效版本 v2.13.6（下期发布，v2.13.5 未包含）。

---

勘误一处：上一条评论里「专家档案项目层文件为 `<当前工作目录>/.dsh/expert-profiles.json`」的说法不准确——这里的「工作目录」不应理解为宿主进程的当前目录，而应理解为 **summon 会话的工作目录**。

## 准确语义

项目层档案（`expert-profiles.json` 与文件层专家定义 `~/.dsh/experts/*.md` 的项目层同理）的路径锚定的是**每次 summon 现场解析的会话 cwd**，解析优先级为：

1. summon 时显式传入的 `cwd` 参数；
2. 宿主会话的工作目录（含你在会话中 `cd` 过的目录）；
3. 配置项 `config.expertTools?.cwd`；
4. 以上均无时回落宿主进程当前目录（与旧版行为一致）。

实际影响：宿主进程从哪里启动，不再决定项目层档案的位置——只要 summon 发生在带工作目录的会话里，项目层档案就读会话目录下的 `.dsh/expert-profiles.json`；在会话中切换过工作目录后，新 summon 会跟随会话 cwd。此前版本把锚点固化在宿主进程 cwd，属于实现缺陷。

该修复随 **v2.13.6** 发布（本 issue 对应的 v2.13.5 未包含）。
