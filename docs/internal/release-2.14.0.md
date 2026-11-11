# 2.14.0 发版准备留痕（2026-11-12）

## 发版范围
- 方向 2 编排经济学（成本记账与预算熔断提示、模型路由三档偏好、批量预热 stagger + 写型扇出建议、SKILL.md 协议面）
- 方向 3 循环检测与人工升级（连续失败循环升级 failloop、召唤失败循环告警、SKILL.md 四轴纪律）
- 方向 4 代理身份与信任链（approve/reject --by 批准人审计、SKILL.md §2 不可信中继四条安全语义）
- 方向 5 MCP+A2A 导出（tools/mcp_taskboard.py stdio 服务、scripts/gen-agent-card.mjs）
- 评审五点补齐（commit 58a18d4：gen-agent-card --skill-dir 实装、card version 单一事实源、--by 码点上限、roster 真解析、batchSummary 数字断言）

## 版本三处 bump（2.13.10 → 2.14.0）
- `package.json:4`
- `dsh.plugin.json:4`
- `lib/index.js:95`（`const VERSION = '2.14.0'`）

grep 复核：`grep -rn '2\.13\.10' --include='*.js' --include='*.json' --include='*.mjs'`（排除 node_modules/package-lock）包内零遗漏；CHANGELOG:52 剩余 `2.13.10` 为 2.14.0 节内改动历史描述，按惯例保留。

## CHANGELOG
- `## [未发布] — 开发分支 dev/orchestration-economics-345（…）` 标题改为 `## [2.14.0] — 2026-11-12`，四个方向的 Added 小节原样保留。
- blockquote 中「本节发布前不 bump 版本、不 npm publish。」删除，保留『依据 docs/research/…』引用行。
- 顶部另起新的空 `## [未发布]` 节。

## 评审报告入库
- `REVIEW-oeconomics-345.md` → `docs/internal/REVIEW-oeconomics-345.md`（git add，随本批由编排者 commit）。

## 测试门禁（2026-11-12 实测）
- `npm test` 全量：611 tests / 609 pass / 0 fail / 2 skipped（mutation-gate 未启用、宿主模块本机缺失，非失败）/ exit 0 / 165.5s。
- `DSH_EXPERT_MUTANTS=1 node --test test/mutation-gate.selftest.mjs`：31/31 pass / 0 fail（含 taskboard.py/bus.py 29 点变异捕获）。
- 2.13.10 → 2.14.0 改动仅版本字符串与文档，理论零回归，实测与基线持平（58a18d4 记录 611/608/0/3=609+1——口径差异：本机 skip=2 为宿主模块缺失，历史记录含 mutation-gate skip，无 fail 项，零回归成立）。

## push / publish 步骤
- 编排者执行，结果待附（本任务红线：不 push、不 npm publish、不 git commit）。
