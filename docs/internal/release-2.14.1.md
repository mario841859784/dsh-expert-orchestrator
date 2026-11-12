# 2.14.1 发版准备留痕（2026-11-12）

## 发版范围
- #4 升级信封统一（【升级｜通道｜级别】六键信封；budget.contractViolation 非升级行维持原形态；taskboard.py fail-loop 升级行收口；cmd_fail 控制流回归修复）
- en 协议字面本地化（[ESCALATION|…] 英文等价，zh 不变，SKILL.md §3 措辞同步）
- lib/tools.js stale 注释清理（零行为）
- docs：protocol-round-ab 对照实验档案（先写后跑，到达率 B 臂 3/3 + 信封子探针 3/3）与 exposure-crypto-trust 打包调研报告入库

依据：评审 `docs/internal/REVIEW-f533f96.md` 结论 + T1 评审建议收口（HEAD a8983aa 合并记录）。

## 版本三处 bump（2.14.0 → 2.14.1）
- `package.json:4`
- `dsh.plugin.json:4`
- `lib/index.js:95`（`const VERSION = '2.14.1'`）

grep 复核：`grep -rn '2\.14\.0'`（排除 node_modules/package-lock）全仓命中仅 CHANGELOG:7 历史节与 docs/internal/release-2.14.0.md 历史留痕，无第四处用户面出现。

## CHANGELOG
- 顶部空 `## [未发布]` 保留。
- 其下新起 `## [2.14.1] — 2026-11-12` 节：Changed（升级信封统一含 cmd_fail 连带修复 / en 协议字面本地化 / stale 注释清理）+ Added（文档）（对照实验档案 / 打包调研报告）+ 测试口径。措辞风格对齐 [2.14.0] 节。

## 测试门禁（2026-11-12 实测）
- `npm test` 全量：612 tests / 610 pass / 0 fail / 2 skipped（skip 为宿主模块缺失类环境条件门，±1 属抖动）/ exit 0。
- `DSH_EXPERT_MUTANTS=1 node --test test/mutation-gate.selftest.mjs`：31/31 pass / 0 fail。

## push / publish
- 由委派方执行（本任务不 commit / 不 push / 不 publish）。

## 收口记录（2026-11-12）

- 发版提交：b8ca88f（T20），push 859a70f..b8ca88f → origin/main
- npm publish 成功：dsh-expert-orchestrator@2.14.1（tag latest）
- registry 实证：dist-tags latest=2.14.1；shasum=c507a1672e2915355782440f86bca3020ac565ab
- 测试对账：npm test 612/610 pass/0 fail/2 skipped + mutation gate 31/31（专家+编排者双跑一致）
