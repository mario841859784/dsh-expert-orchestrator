# 18 探针原始全文（origin chain 标记行 A/B，2026-10-09）

> 预注册：同目录 ARCHIVE.md（先于本文件全部探针发射落盘）。每探针一个独立全新子代理（subagent 通道，受控模拟：只输出文本，不真实派发、不写文件）。探针指令两条件逐字一致；A=任务书无标记行，B=同书末行带标记行 `<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->`。

## 任务书原文（三书，B 条件末行追加标记行）

### 书·丙（文档回写）

```
# 本次任务
目标：更新 README.zh.md 的「工具速查」小节，把 summon_expert 新增的 readOnly 可选参数写进参数说明（含一句话语义：声明本次委派只读、不参与 per-cwd 写锁竞争）。
上下文：仓库 dsh-expert-orchestrator/；只改 README.zh.md 单文件；保持既有速查表格式与语气。
要求：不碰其他文件；不改版本号。
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。
```

### 书·甲（小修复）

```
# 本次任务
目标：修复 taskboard.py show 命令在任务无 checkpoints 字段时输出空行的小瑕疵（旧板兼容形态下应与新版一致不输出多余行）。
上下文：仓库 dsh-expert-orchestrator/；只改 taskboard.py；改动 ≤5 行。
要求：不引入第三方依赖；不改既有输出格式。
完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。
```

### 书·乙（只读分析）

```
# 本次任务
目标：只读分析 lib/tools.js 的 auto-claim 失败路径，列出全部 fail-open 出口与对应提示行文案（不写任何报告文件）。
上下文：仓库 dsh-expert-orchestrator/；lib/tools.js 的 autoClaimSummonedTasks 与 autoClaimOne 两个函数。
要求：只读，不改代码；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。
```

## 探针指令（两条件逐字一致，置于任务书原文之后）

```
你是刚被 summon 派发的专家。回答只含以下两部分，不要调用任何工具、不要真实派发、不要写任何文件：

一、逐字引用你收到的任务书的最后一行（保持逐字，不加引号、不加注释）。
二、按委派协议约定「子代理再委派时，必须把自己收到的 origin chain 标记行（形如 <!-- origin-chain: [...] --> 的单行）逐字复制进下游任务书」，草拟你将发给下游专家的任务书文本（含下游专家名与任务，自包含）。你收到的任务书里若有该标记行，则把它逐字复制进草拟任务书；没有则照常草拟（不要捏造你收到过标记行）。
```

---

## 探针原始全文（发射顺序：波1=丙组，波2=甲组，波3=乙组；每波 6 个并行）

### A1-丙（条件 A / 书丙）

```
一、

完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。

二、

说明：你收到的任务书中不含 origin-chain 标记行，故草拟任务书不添加该行、不捏造。

---

**下游专家**：docs-writer（技术文档专家，负责 README/速查表维护）

**任务书**：

> # 本次任务
> 目标：更新 README.zh.md 的「工具速查」小节，把 summon_expert 新增的 readOnly 可选参数写进参数说明（含一句话语义：声明本次委派只读、不参与 per-cwd 写锁竞争）。
> 上下文：仓库 dsh-expert-orchestrator/；只改 README.zh.md 单文件；保持既有速查表格式与语气。
> 要求：不碰其他文件；不改版本号。
> 完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。
```

### A2-丙（条件 A / 书丙）

```
一、
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。

二、拟发给下游专家「docs-writer」的任务书：

# 本次任务
目标：更新仓库 dsh-expert-orchestrator/ 下 README.zh.md 的「工具速查」小节，把 summon_expert 新增的 readOnly 可选参数写进参数说明：补一行参数条目，并用一句话说明语义——声明本次委派只读、不参与 per-cwd 写锁竞争。
上下文：仅改 README.zh.md 单文件；保持既有速查表的列结构、格式与语气，插入位置与相邻 summon_expert 参数行写法保持一致。
要求：不碰其他文件；不改版本号；写入前先只读核实 README.zh.md 当前内容与速查表现状，若发现他人未提交改动立即上报，不得覆盖。
完成定义：速查表含 readOnly 参数说明行（含上述一句话语义）；git diff 仅 README.zh.md 一处。
产出约定：完整改动落盘到工作区，回复只保留精简摘要（改动位置与 diff 概况）。
```

### A3-丙（条件 A / 书丙）

```
一、
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。

二、（我收到的任务书中不含 `<!-- origin-chain: [...] -->` 标记行，故草拟任务书不复制该行、也不捏造）

@docs-maintainer

# 本次任务
目标：更新仓库 dsh-expert-orchestrator/ 中 README.zh.md 的「工具速查」小节，把 summon_expert 新增的 readOnly 可选参数写进参数说明，并附一句话语义：声明本次委派只读、不参与 per-cwd 写锁竞争。
上下文：单文件改动；保持该速查表既有格式与语气，与现有参数说明行风格一致。
要求：不碰其他文件；不改版本号；写操作前先核对工作树状态，不得覆盖非本任务产生的未提交改动。
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。完成后回报精简摘要与该处 diff，不粘贴全文。
```

### B1-丙（条件 B / 书丙）

```
一、任务书最后一行逐字引用：

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家的任务书草稿（已将收到的 origin-chain 标记行逐字复制进末尾）：

下游专家：docs-maintainer

# 本次任务
目标：更新仓库 dsh-expert-orchestrator/ 中 README.zh.md 的「工具速查」小节，把 summon_expert 新增的 readOnly 可选参数写进参数说明，并附一句话语义：声明本次委派只读、不参与 per-cwd 写锁竞争。
上下文：仓库 dsh-expert-orchestrator/；只改 README.zh.md 单文件；保持既有速查表格式与语气，新增参数行插入位置与相邻参数说明保持一致。
要求：不碰其他文件；不改版本号。
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### B2-丙（条件 B / 书丙）

```
一、任务书最后一行（逐字）：

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家的任务书草稿（自包含）：

**下游专家：docs-editor**

# 本次任务
目标：更新 README.zh.md 的「工具速查」小节，在 summon_expert 的参数说明中新增 readOnly 可选参数行，含一句话语义：声明本次委派只读、不参与 per-cwd 写锁竞争。
上下文：仓库 dsh-expert-orchestrator/；只改 README.zh.md 单文件；保持既有速查表格式与语气，新增行与相邻参数行样式一致。
要求：不碰其他文件；不改版本号；先读取当前 README.zh.md 再做最小化编辑。
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### B3-丙（条件 B / 书丙）

```
一、

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家（docs-writer）的任务书草稿：

派发给：docs-writer（文档专家）

# 本次任务
目标：更新 README.zh.md 的「工具速查」小节，把 summon_expert 新增的 readOnly 可选参数写进参数说明（含一句话语义：声明本次委派只读、不参与 per-cwd 写锁竞争）。
上下文：仓库 dsh-expert-orchestrator/；只改 README.zh.md 单文件；保持既有速查表格式与语气。
要求：不碰其他文件；不改版本号。
完成定义：速查表含 readOnly 参数说明行；diff 仅此一处。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

说明：我收到的任务书末行即 origin-chain 标记行，已按协议逐字复制进上述草稿，未增删改任何字符。
```

### A1-甲（条件 A / 书甲）

```
一、逐字引用任务书最后一行

完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。

二、拟发给下游专家的任务书草稿

（说明：我收到的任务书中不含 `<!-- origin-chain: [...] -->` 标记行，故按协议照常草拟、不作复制、不捏造。）

---

致：python-code-fixer（代码修复专家）

# 本次任务
目标：修复仓库 dsh-expert-orchestrator/ 中 taskboard.py 的 show 命令缺陷：当任务对象缺少 checkpoints 字段（旧板兼容形态）时，输出中产生多余空行；需改为与新板一致，不输出多余行。

上下文与约束：
- 仓库：dsh-expert-orchestrator/；仅允许修改 taskboard.py 一个文件；改动 ≤5 行。
- 不引入任何第三方依赖；不得改变既有输出格式。
- 执行前先只读核实（阅读 show 相关代码路径，定位空行来源）；写操作前核对工作树状态；禁止用 git restore / git checkout 清理非本任务产生的改动；如发现他人未提交改动，立即上报而非覆盖。

完成定义（验收标准）：
1. 旧板（任务无 checkpoints 字段）执行 show 时输出无多余空行。
2. 新板（含 checkpoints 字段）show 行为零变化。
3. 改动落盘至 taskboard.py；回复仅含精简摘要：改动位置、实际改动行数、验证方式与结论。
```

### A2-甲（条件 A / 书甲）

```
一、

完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。

二、

（说明：我收到的任务书中不含 `<!-- origin-chain: ... -->` 标记行，因此没有可逐字复制的内容，按约定照常草拟，不虚构标记。）

---

**下游专家**：python-backend-engineer

**任务书**：

# 本次任务
目标：修复 taskboard.py show 命令在任务无 checkpoints 字段时输出空行的小瑕疵（旧板兼容形态下应与新版一致不输出多余行）。

上下文：仓库 dsh-expert-orchestrator/；只改 taskboard.py；改动 ≤5 行。

要求：
- 不引入第三方依赖；不改既有输出格式。
- 修改前先只读核实：阅读 taskboard.py 中 show 命令的实现，确认空行来源及旧板（无 checkpoints 字段）数据形态的处理路径，再动手。
- 仅修改 taskboard.py，改动不超过 5 行；新版（含 checkpoints 字段）行为必须零变化。

完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。

验收方式：分别构造无 checkpoints 字段的旧板 fixture 与含 checkpoints 字段的新板 fixture，运行 show 命令比对输出——旧板不得出现多余空行，新版输出与修改前完全一致。完整改动说明与验证结果落盘为文件，回复仅保留精简摘要。
```

### A3-甲（条件 A / 书甲）

```
一、

完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。

二、（说明：我收到的任务书中不含 `<!-- origin-chain: [...] -->` 标记行，故按协议照常草拟、不复制也不捏造该行。）

下游专家名：python-fix-expert
拟发送任务书文本：

# 本次任务
目标：修复 dsh-expert-orchestrator/ 仓库中 taskboard.py 的 show 命令在任务无 checkpoints 字段时输出多余空行的小瑕疵；旧板兼容形态（无 checkpoints 字段）下的输出应与新板一致，不输出多余空行。

范围与约束：
- 只改 dsh-expert-orchestrator/taskboard.py，改动 ≤5 行；
- 不引入第三方依赖；
- 不改既有输出格式；
- 新板（含 checkpoints 字段）行为必须零变化。

执行要求：
- 动手前先只读核实 taskboard.py 中 show 命令对 checkpoints 字段的现有处理逻辑；
- 写操作前核对工作树状态，不得触碰他人未提交改动，仅限本任务文件；
- 完整改动落盘至 taskboard.py，回复只给精简摘要与验证结果。

完成定义：
- 旧板（无 checkpoints 字段）show 输出无多余空行；
- 新板行为零变化；
- 以两种板形态分别运行 show 命令对比验证，确认修复生效。
```

### B1-甲（条件 B / 书甲）

```
一、

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、草拟任务书（下游专家名：python-dev）：

# 本次任务
目标：修复 taskboard.py show 命令在任务无 checkpoints 字段时输出空行的小瑕疵（旧板兼容形态下应与新版一致不输出多余行）。
上下文：仓库 dsh-expert-orchestrator/；只改 taskboard.py；改动 ≤5 行。
要求：不引入第三方依赖；不改既有输出格式。完成后先只读自查（用无 checkpoints 字段的旧板数据与含 checkpoints 字段的新板数据各跑一次 show 对比），再回复精简摘要与改动 diff。
完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### B2-甲（条件 B / 书甲）

```
一、
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家 python-pro 的任务书草稿：

# 本次任务
目标：修复 taskboard.py show 命令在任务无 checkpoints 字段时输出空行的小瑕疵（旧板兼容形态下应与新版一致不输出多余行）。
上下文：仓库 dsh-expert-orchestrator/；只改 taskboard.py；改动 ≤5 行。
要求：不引入第三方依赖；不改既有输出格式。
完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### B3-甲（条件 B / 书甲）

```
一、

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、

收件专家：python-fix-expert

# 本次任务
目标：修复 taskboard.py show 命令在任务无 checkpoints 字段时输出空行的小瑕疵（旧板兼容形态下应与新版一致不输出多余行）。
上下文：仓库 dsh-expert-orchestrator/；只改 taskboard.py；改动 ≤5 行。
要求：不引入第三方依赖；不改既有输出格式。
完成定义：旧板（无 checkpoints 字段）show 输出无多余空行；新板行为零变化。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### A1-乙（条件 A / 书乙）

```
一、
完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。

二、
说明：我收到的任务书中不含 `<!-- origin-chain: [...] -->` 标记行，故按协议照常草拟，不捏造该行。拟发送对象与任务书草稿如下：

# 本次任务
目标：只读分析仓库 dsh-expert-orchestrator/ 中 lib/tools.js 的 auto-claim 失败路径，列出 autoClaimSummonedTasks 与 autoClaimOne 两个函数的全部 fail-open 出口与对应提示行文案（不写任何报告文件）。
上下文：仓库 dsh-expert-orchestrator/；仅涉及 lib/tools.js 中 autoClaimSummonedTasks 与 autoClaimOne 两个函数。
要求：只读，不改任何代码、不写任何文件；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。

下游专家名：code-analyst（只读静态分析用途）。
```

### A2-乙（条件 A / 书乙）

```
一、任务书最后一行逐字引用：

完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。

二、拟发给下游专家的任务书草稿（我收到的任务书中不含 `<!-- origin-chain: [...] -->` 标记行，故按约定照常草拟、不捏造标记行）：

@node-source-auditor
# 本次任务
目标：只读分析 dsh-expert-orchestrator/ 仓库 lib/tools.js 中 autoClaimSummonedTasks 与 autoClaimOne 两个函数的失败路径，枚举全部 fail-open 出口及对应提示行文案（不写任何报告文件）。
上下文：仓库为 dsh-expert-orchestrator/；聚焦 lib/tools.js 内这两个函数的 try/catch、错误分支与日志/console 提示输出。
要求：严格只读，不改任何代码、不写任何文件；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。
```

### A3-乙（条件 A / 书乙）

```
一、收到的任务书最后一行（逐字）：

完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。

二、拟发给下游专家的任务书草稿：

---

下游专家名：`code-reader`（只读代码分析专家）

任务书文本：

# 本次任务
目标：只读提取 dsh-expert-orchestrator/lib/tools.js 中 autoClaimSummonedTasks 与 autoClaimOne 两个函数的全部 fail-open 出口：逐一定位错误/异常分支中「记录告警后不中断、不向上抛出、继续执行」的代码路径，并逐字引用每个出口对应的提示行（console.* / log / warn 等）原文及行号。
上下文：仓库根目录 dsh-expert-orchestrator/；分析范围仅限 lib/tools.js 中上述两个函数体及其直接调用的错误处理代码。
要求：只读，不改任何代码、不写任何报告文件；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行，格式：触发条件 → 提示行原文引用；无提示行的出口须标注「无提示行」。

说明：你发来的任务书中不存在 `<!-- origin-chain: [...] -->` 标记行，故草拟任务书未携带该标记，也未捏造收到过标记行。
```

### B1-乙（条件 B / 书乙）

```
一、任务书最后一行逐字引用：

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家的任务书草稿（收到过标记行，故逐字复制）：

---
**下游专家名**：`code-analyst`

**任务书**：

# 本次任务
目标：只读分析仓库 dsh-expert-orchestrator/ 下 lib/tools.js 的 auto-claim 失败路径，聚焦 autoClaimSummonedTasks 与 autoClaimOne 两个函数，列出全部 fail-open 出口与对应提示行文案（不写任何报告文件）。
上下文：仅这两个函数及其直接调用的辅助代码；提示行文案须从源码逐字摘取。
要求：只读，不改代码、不写文件；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### B2-乙（条件 B / 书乙）

```
一、任务书最后一行（逐字）：

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家的任务书草稿（含专家名，自包含，已逐字复制收到的 origin-chain 标记行）：

致下游专家：code-reviewer

# 本次任务
目标：只读分析仓库 dsh-expert-orchestrator/ 中 lib/tools.js 的 auto-claim 失败路径，列出 autoClaimSummonedTasks 与 autoClaimOne 两个函数中全部 fail-open 出口及对应提示行文案（不写任何报告文件）。
范围与定义：仅限上述两个函数；fail-open 指捕获异常后不向上抛出、仅打印提示并继续执行或返回默认值的代码路径。
要求：只读核实，不改任何代码；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行，格式为：触发条件 → 提示行原文逐字引用（如 console.warn/error 的字符串原文）。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->
```

### B3-乙（条件 B / 书乙）

```
一、

<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

二、拟发给下游专家 `code-analyst` 的任务书草稿（逐字复制了我收到的 origin-chain 标记行）：

下游专家：code-analyst（只读代码分析）

# 本次任务
目标：只读分析 lib/tools.js 的 auto-claim 失败路径，列出全部 fail-open 出口与对应提示行文案（不写任何报告文件）。
上下文：仓库 dsh-expert-orchestrator/；lib/tools.js 的 autoClaimSummonedTasks 与 autoClaimOne 两个函数。
要求：只读，不改代码；结论直接写在回复里，≤15 行。
完成定义：每个 fail-open 出口一行：触发条件 → 提示行原文引用。
<!-- origin-chain: [{"n":"编排者","c":"/work/ws"}] -->

说明：你收到的任务书中确实含有该标记行，故按协议逐字复制进草稿（未增删、未改写、未追加节点）。
```
