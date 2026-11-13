# 发版留痕：2.14.2（2026-11-13）

- **版本三点 bump**：package.json:4 / dsh.plugin.json:4 / lib/index.js:95（2.14.1 → 2.14.2）；CHANGELOG `[未发布]` 定版为 `[2.14.2] — 2026-11-13`。
- **合入留痕**：dev/exposure-crypto-345 合并进 main（合并提交 dfd2a89，含 1be57fa / ef3b962 / b2543aa / 5a24d75 四提交）。
- **内容面**：exposure-crypto-trust §5 路线表 N1/N2/watchdog 收口/M1/M3/⑤ 六项 + 独立评审收口（主报告必改1+建议7、安全报告中2低4 逐条落地）+ 宿主 0.2.2-rc.2 兼容修复（summon 顶层平铺契约）。
- **评审门禁**：主报告「同意合入放行」；安全审计「无阻断项、无高危项」——两报告原文 docs/internal/REVIEW-ef3b962{,-security}.md。
- **门禁复跑（发版提交时点）**：npm test 632 tests / 629 pass / 0 fail / 3 skipped；mutation gate 664 / 662 pass / 0 fail / 2 skipped（31 变异点全捕获，REGISTRY 含 M3 判定面 2 点）。
- **宿主兼容性注记（如实）**：2.14.2 适配宿主 0.2.2-rc.2（startActivation 顶层平铺契约 + delivery='caller' one-shot 语义）；对旧宿主（≤0.2.2-alpha.x，legacy start/startContinuable 在场）走 legacy 轨，适配层包回嵌套 request——与 2.14.1 在旧宿主上的行为逐字节等价（两代兼容不回退）。alpha 升级指南示例与 rc.2 运行时矛盾已留痕（docs/internal/SUMMON-FAIL-0.2.2-rc.2.md），待上游反馈。
- **npm publish**：`npm publish`（本机 ~/.npmrc 凭据）→ registry dist-tags 实证 latest=2.14.2。
- **部署**：`node scripts/sync-deploy.mjs status` 对账 + `nas` 拉新（NAS web profile npm 副本安装，权限归一内置）；**NAS web 宿主重启须用户在 fnOS appcenter UI 操作**（ssh 用户 kill 必 EPERM，脚本不代重启）。desktop profile 为 symlink 直指本机工作树，宿主重启后加载 2.14.2。
- **summon 恢复验证口径**：NAS 宿主重启后，编排会话 summon_expert/experts 应恢复发射（rc.2 崩溃 `spec.parent.id` TypeError 已修）；若仍报错按 docs/internal/SUMMON-FAIL-0.2.2-rc.2.md 证据链复查宿主实际版本。
