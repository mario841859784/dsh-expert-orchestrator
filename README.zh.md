<div align="center">

# DSH Expert Orchestrator（专家编排模式）

**PM 先行规划 · Agency 专家优先委派 · 门禁交付 · 经验沉淀**

一个 DeepSeek Harness（DSH）**agent preset 插件**：安装后 DSH 即获得一个「首席编排者」会话模式——
不亲自写码，而是分诊任务、请项目管理专家规划、把实施委派给最合适的领域专家，并以门禁保证交付质量。

[安装](#-安装) · [工作流](#-工作流) · [五大机制](#-五大机制) · [自定义](#-自定义) · [License](#license)

</div>

---

## ✨ 它做什么

| 场景 | 行为 |
|------|------|
| 收到任务 | 每轮**强制重新分诊**（三级：大型 / 小型实施 / 只读），杜绝"上一轮在做就直接续"的漂移 |
| 大型任务 | **先召唤 PM 专家**（高级项目经理 / 项目推进专员）产出结构化计划，再逐项委派 |
| 实施改动 | **一律委派专家执行**（Agency 花名册优先，无匹配时回退自带专家库）；协调官只做只读验证 |
| 并行协作 | 专家产出走**文件消息总线**落盘，协调官只读摘要不转述全文 |
| 交付前 | **独立评审专家**（评审者 ≠ 实现者，回炉 ≤2 轮）+ **PM 检查点**，双门禁放行 |
| 任务收尾 | 提炼 ≤3 条教训写入**经验池**，下次同类任务自动注入 |

## 🧭 工作流

```
用户请求 → 分诊（每轮重做）
  ├─ 只读操作 → 协调官亲自做
  ├─ 小型实施 → 免 PM，直接委派 1 名执行专家 → 验收
  └─ 大型任务 → PM 规划召唤（高级项目经理）
        → 任务板建档（依赖 DAG）→ 逐子任务委派专家
        → 并行专家产出落盘消息总线 → 协调官只读摘要整合
        → 独立评审（回炉 ≤2）→ PM 检查点 → 交付
        → 经验沉淀（lessons.md）
每步行动前过五锚自检：回顾｜收敛｜反跑题｜协作｜资源
```

## 🧩 五大机制

| 机制 | 说明 |
|------|------|
| 🎯 **每轮分诊 + 五锚自检** | 三级分诊 + 五项显式自检（含"连续 2 轮无进展→换策略或召 PM 重排"），跨轮不漂移 |
| 📋 **任务板 taskboard.py** | 文件任务板：pending→ready→running→done/failed 状态机，`--dep` 依赖 DAG（done 自动解锁下游），崩溃 `recover` |
| 💬 **消息总线 bus.py** | 信箱式落盘消息：`send/read/ack/broadcast/stats`，并行专家零转述协作，省协调官上下文 |
| 🛡️ **交付门禁** | 独立评审（同意/部分同意/反对+理由，回炉上限 2 轮）→ PM 检查点，commit 前强制 |
| 💾 **经验池** | 全局 `lessons.md` + 项目级 `.expert-lessons.md` 双层沉淀，委派任务书自动注入相关教训 |

## 📦 安装

> 前置：Node.js 22+ 的 DSH 环境；`python3`（任务板与消息总线）；可选安装 [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents)（Agency 花名册，不装则自动走自带专家库）。内置 `trim-cli` 技能的 scripts wrapper 与 bin 二进制不在本包内（files 白名单不含），需按 trim-cli skill 文档另行获取。

### 方式 A：DSH 插件管理器（推荐）

```bash
dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator
```

### 方式 B：手动安装

```bash
git clone https://github.com/mario841859784/dsh-expert-orchestrator.git
mkdir -p ~/.dsh/.agent-presets/expert-orchestrator
cp -r dsh-expert-orchestrator/{agent.cordis.yml,preset.yml,skills} \
      ~/.dsh/.agent-presets/expert-orchestrator/
# 重启 DSH Web，在预设选择器里选「专家编排模式」
```

### 部署策略（与其他 preset 插件不同）

- **从不删除**目标目录里的任何文件（你加的技能、自定义专家都安全）；
- 协议文件（persona/技能/工具脚本）按版本标记刷新，本地手工修改在重启后保留，插件升级时才更新；
- `lessons.md` 与 `experts/*.md` 属于运行时用户数据——**只增不覆盖**。

### 本地源码自部署（可选）

插件管理器安装（`dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator`）会经 bundle patch 自动挂载部署器，无需任何手工 composition 条目。

仅当想从本地源码 checkout 加载插件时，才往宿主层 patch（与 dsh-onebot 同款机制）：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中插入以下片段：

```yaml
- insert:
    - id: expert-orchestrator-deploy
      name: '/绝对路径/dsh-expert-orchestrator/lib/index.js'
```

升级语义：插件 `VERSION` 变更时会用安装包内容覆盖 PROTOCOL 文件（`agent.cordis.yml`、`preset.yml`、`skills/expert-orchestration/SKILL.md`、`skills/expert-orchestration/routing.md`、`skills/expert-orchestration/tools/taskboard.py`、`skills/expert-orchestration/tools/bus.py`、`skills/trim-cli/SKILL.md`、`skills/trim-cli/manifest.json`、`skills/trim-cli/entries`、`skills/trim-cli/reference`，共 10 项）；USER_DATA（`experts/`、`lessons.md`）只缺才补。宿主层本地挂载不受该覆盖影响。

存量迁移提示：若此前在 `agent.cordis.yml` 中手工加过 `expert-orchestrator-deploy` 条目，升级前应先迁移到宿主层 `cordis.patch.yml`，否则 VERSION 变更刷新会用出厂版覆盖该条目、静默断掉本地链路。

## 🚀 使用

1. 安装并重启 DSH，会话选择「专家编排模式」预设（或设为默认）。
2. 直接交代任务即可：编排者自动分诊、请 PM 规划、委派专家。
3. 大型任务可随时插话调整；里程碑与 commit 前会自动过评审 + PM 检查点。

## 📚 专家库与来源声明

本插件分发的专家提示词按来源分为四部分（每个专家文件 frontmatter 的 `来源` 字段标注出处，完整清单见 [EXPERTS.md](EXPERTS.md)）：

| 来源 | 数量 | 内容 |
|---|---|---|
| 本项目自建 | 11 | 编排协议配套的中文兜底专家（generalist、PM、前后端、审查、测试、安全、数据、运维、文档、设计） |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents)（MIT） | 62 | 技术栈专项：语言/框架（Rust、Go、Swift、Kotlin…）、基础设施（K8s/Terraform…）、数据与 AI（LLM 架构、MLOps…）、质量调试（混沌/性能/调试）、开发者体验、垂直栈（区块链/支付/医疗合规…）、架构模式（微服务/GraphQL…） |
| [wshobson/agents](https://github.com/wshobson/agents)（MIT） | 4 | 独有技术栈：Julia、ARM Cortex 嵌入式、NVIDIA DGX 运维、LLM 微调 |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh)（MIT） | 1 | 中文生态增量：搜索增长编排器 |

以上上游项目均为 MIT 许可证，专家正文版权归各自作者所有，本仓库的分发遵循 MIT 并在此声明致谢。

## 🛠️ 自定义

- **专家提示词库**：`skills/expert-orchestration/experts/*.md`，直接增删改，格式照现有文件（头部「适用任务」供分诊匹配）；Agency 花名册无匹配领域时自动回退到这里。
- **经验池**：全局 `skills/expert-orchestration/lessons.md` + 各工作区 `.expert-lessons.md`。
- **编排协议**：`agent.cordis.yml`（persona 铁律与循环）+ `skills/expert-orchestration/SKILL.md`（完整协议）。

## ✅ 兼容性说明

本 preset 不硬编码任何特定部署的工具名（搜索/浏览器/外部 API），所有机制基于 DSH 标准工具 + 两个零依赖 Python 脚本，可直接跨环境使用。

## 🤝 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 核心框架
- [MichengAI/dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) — Agency 专家花名册（本 preset 的专家来源）
- [Asher-2000/dsh-expert-mode](https://github.com/Asher-2000/dsh-expert-mode) — 五锚自检 / 经验池 / 独立评审 / 任务板 / 消息总线五个机制的灵感来源
- [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) · [wshobson/agents](https://github.com/wshobson/agents) · [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) — 专家库引用来源（MIT）

## License

[MIT](LICENSE) © mario841859784
