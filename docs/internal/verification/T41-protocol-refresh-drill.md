# T41（v2.8 M8-3）PROTOCOL 整目录刷新演练验证记录

- 任务：T41（T29 v2.8 发布收口 6a 联动）；发布门禁第③项。
- 范围：模拟 VERSION bump（`2.7.1+sources1` → `2.8.0+sources1`）经**真实 `apply()` 路径**（`lib/index.js` 默认导出，非刷新逻辑复刻）对沙箱 `config.targetDir` 验证 14 条 PROTOCOL 条目全量覆盖、本轮 v2.8 SKILL.md 新文本不被回滚、USER_DATA 零触碰；**真实部署目录全程零触碰**（6a 阶段红线，6b 才刷新）。
- 先例：v2.7.0 全量演练（T16，13→14 条目）与 v2.7.1 lite 演练（T24，14 条目 sha256 级）。
- 方法与脚本：`/tmp/t29-drill/refresh-drill.mjs`（零第三方依赖；沙箱 `/tmp/t29-drill/target`；输出留档 `/tmp/t29-drill/refresh-drill.out`）。演练前置：预置 marker=`2.7.1+sources1`、14 条目全部写入 `STALE-2.7.1` 哨兵内容（含 3 个目录条目递归预置）、USER_DATA 三处哨兵、bundled `experts/` 内一枚非核心文件（迁移语义）、`skills/expert-gestures/` 内一枚用户附加文件（刷新不删除语义）。
- 验证日期：2026-10-09；基线 HEAD=533ae96（版本 bump 至 2.8.0 后、同一工作树）。

## 一、结论

**演练全 PASS（exit 0）：14 条 PROTOCOL 条目（展开 57 个文件）经真实 `apply()` 全部被出厂内容覆盖且 sha256 与包内逐字节一致；marker 由 `2.7.1+sources1` 推进到 `2.8.0+sources1`；SKILL.md 中 v2.8 新文本（`DSH_EXPERT_IDLE_RECLAIM` / `DSH_EXPERT_TOOL_BUDGET` / `DSH_EXPERT_ORIGIN_CHAIN` / `origin-chain`）全部在场（新文本未被回滚）；USER_DATA 三处哨兵零触碰；非核心专家文件迁移至 `expert-sources/legacy-adapted/` 而非删除；刷新目录内用户附加文件未被删除；第二次 `apply()` 零刷新（幂等）；真实部署目录 marker 前后一致（`2.7.1+sources1`）。**

## 二、实测证据（2026-10-09，节选自完整输出）

```
REAL MARKER BEFORE : "2.7.1+sources1"
[dsh-expert-orchestrator] preset ready at /tmp/t29-drill/target (deploy 2.8.0+sources1)
[~ ×57：14 条目逐文件覆盖——agent.cordis.yml、preset.yml、source-registry.json、SKILL.md、routing.md、
   roster-aliases.json、experts/（11 文件）、expert-gestures/（11 文件）、taskboard.py、bus.py、
   trim-cli SKILL.md/manifest.json、entries/（11 文件）、reference/（14 文件，含 workflows/ 子目录）]
[+ ×6：expert-lessons/README.md、expert-methods/{README,code-reviewer,devops-engineer,frontend-engineer,tech-writer}.md——copy-if-missing]
[dsh-expert-orchestrator] migrated 1 legacy expert(s) -> legacy-adapted/
PASS: marker 2.7.1+sources1 → 2.8.0+sources1
PASS: 14 PROTOCOL entries refreshed byte-identical from the package (57 files compared)
PASS: new v2.8 SKILL.md text present: DSH_EXPERT_IDLE_RECLAIM
PASS: new v2.8 SKILL.md text present: DSH_EXPERT_TOOL_BUDGET
PASS: new v2.8 SKILL.md text present: DSH_EXPERT_ORIGIN_CHAIN
PASS: new v2.8 SKILL.md text present: origin-chain
PASS: USER_DATA untouched: skills/expert-orchestration/lessons.md
PASS: USER_DATA untouched: expert-lessons/backend-engineer.md
PASS: USER_DATA untouched: expert-methods/backend-engineer.md
PASS: non-core experts/ file no longer in experts/
PASS: non-core experts/ file migrated to expert-sources/legacy-adapted/
PASS: extra user file inside refreshed protocol dir NOT deleted
PASS: second apply() refreshed nothing (idempotent)
PASS: marker untouched by second apply()
PASS: real deploy marker untouched ("2.7.1+sources1")
DRILL: ALL PASS (57 files, 14 entries)
```

## 三、对照 v2.8 语义要点

1. **刷新清单无结构性变化**：`lib/index.js` 的 `PROTOCOL` 数组本轮零增删，仍为 14 条（`agent.cordis.yml`、`preset.yml`、`source-registry.json`、`SKILL.md`、`routing.md`、`roster-aliases.json`、`experts/`、`expert-gestures/`、`taskboard.py`、`bus.py`、`trim-cli` SKILL.md/manifest.json/entries/reference）；本轮 SKILL.md/taskboard.py/bus.py 的 v2.8 改动（开关表、预算、续领、origin chain）经 57 文件级覆盖自然落到部署面。
2. **marker 语义未动**：`VERSION='2.8.0'`（lib/index.js:88），`DEPLOY_REV = ${VERSION}+sources1`（:93，拼接逻辑未改），`.deployed-version` 比对不等即全量刷新（apply() 内唯一刷新分支）——bump 只改字面量，派生与比对逻辑零变化。
3. **覆盖≠删除**：`refreshDir` 只覆盖同名文件，`skills/expert-gestures/` 内用户附加文件演练中幸存；非核心专家文件走 `migrateLegacyExperts` 一次性迁移（本例 1 个 → `legacy-adapted/` 并登记 sources.json），与升级语义文档一致。
4. **USER_DATA 面**：`lessons.md`、`expert-lessons/`、`expert-methods/` 演练中三处哨兵逐字节未动；缺失的出厂 README/方法文件以 copy-if-missing 补齐（`+ ×6`），不覆盖已有。
5. **幂等**：第二次 `apply()` 零刷新、marker 未重写——部署器对已最新部署零写。

## 四、验证边界

- 沙箱演练：`config.targetDir` 指向 `/tmp/t29-drill/target`；真实部署目录 `/vol2/@appshare/Harness/.dsh/.agent-presets/expert-orchestrator/` 仅做只读 marker 前后对照（`2.7.1+sources1` → 同值），**6a 阶段零写入**；实际刷新留待 6b 部署阶段。
- 演练中 `registerExpertTools` 因裸 ctx 无 tools/subagents 服务而显式跳过注册（`expert tools unavailable: ctx.tools/ctx.subagents missing`，fire-and-forget catch 路径），不影响部署面断言；工具注册面的验证归宿主运行时（既有 1B 立场）。
