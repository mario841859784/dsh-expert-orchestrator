# A/A 重点火 LAUNCH-NOTE（T7 续作，分离式 detached 启动）
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **点火时间**：2026-10-19 20:26:22（本地），run id **`20261019-122622-ny0d`**
- **PID**：`4003058`（写入 `.dsh-eval/aa-relaunch.pid`；`ps` 证实 SID=PID=4003058，独立会话，setsid+nohup+后台三件套齐全，已脱离本代理会话生命周期）
- **日志**：`.dsh-eval/aa-relaunch.log`
- **TMPDIR**：`capability-ab-eval/.dsh-eval/tmp`（EXDEV 规避：truth-stash `dsh-eval-truth-*` 落在同一设备内；该 tmp 目录中已见 dsh-eval-truth-* 实证）

## 启动命令（key 值以 ***REDACTED*** 代替；实际运行时从 `/vol2/@appshare/Harness/.dsh/.credentials.yaml` refs 内联读取，零回显零落盘）

```bash
cd capability-ab-eval
TMPDIR=$E/.dsh-eval/tmp setsid nohup env \
  DEEPSEEK_API_KEY=***REDACTED*** NEWAPI_API_KEY=***REDACTED*** \
  node ../dsh-eval-infra/lib/cli.js run --aa \
  --repeats 3 --concurrency 2 --label aa-noise-floor \
  --max-usd 3 --max-usd-per-trial 0.10 \
  f10_db_investigation f1_log_triage f3_test_suite_fix f4_grep_rename f8_verbose_tests \
  l1_chain_migrate l2_ledger_state m1_cross_session_recall p1_format_contract p2_persistent_rule \
  s1_longhorizon_debug s2_taskdag_scheduler s3_intervalset_algebra s4_multifile_refactor \
  t1_tool_choice_grep x1_injected_readme x2_tool_result_injection z0_env_smoke \
  > .dsh-eval/aa-relaunch.log 2>&1 < /dev/null &
echo $! > .dsh-eval/aa-relaunch.pid
```

注：任务草样中的 `run --aa baseline` 经源码核对（dsh-eval-infra `src/cli.ts:295-296`，`--aa` 为布尔旗标、baseline 臂为缺省）修正为 `run --aa`；`baseline` 位置参数会被误当场景 glob。18 场景以显式 glob 列出（与 z464 plan.json 逐一对应），holdout n1/n2/n3/v1 天然排除，未传 `--include-holdout`。

## 矩阵（与 z464 完全一致，共 108 trials）

- 18 场景（15 硬 + 3 简 z0/p1/p2）× 2 臂（baseline + `--aa` 内部合成孪生 **baseline-aa**，env.json 双臂 composedTreeSha 同一）× repeats 3 = **108**，concurrency 2，meter 开（wire meter 默认），label `aa-noise-floor`
- 预算：`--max-usd 3`（停调度上限）、`--max-usd-per-trial 0.10`
- 点火前门禁四查全过：①`diff baseline expert` 恰 3 条插件行 disabled 差异；②config.json prices=glm-5.3-flash hit .03/miss .15/output .5；③两份孤儿 run 目录原样；④dsh-expert-orchestrator HEAD=ea7f46a0cafeefce70ae393276e0a7b1102c1020 且工作树净

## 存活证明（≥150s 门限，实际 ~183s 时首次验证）

- 20:29:25 `kill -0 4003058` → ALIVE；progress：completed=2 / 108，failed=0，usd=$0.03698
- 20:30:05 再次 ALIVE；progress.json mtime 20:28:58 → 20:30:01 持续推进
- 日志实证双臂正常：`✓ f10_db_investigation/baseline#1 · $0.0174 · 12 steps · 143s`、`✓ f10_db_investigation/baseline-aa#1 · $0.0196 · 12 steps · 150s`（usd 平价计费正常，无 EXDEV、无 401）

## 孤儿 run 处置声明（证据链，一律不删不改、不续）

- `runs/20261019-120426-z464`：上一棒孤儿，停于 8/108（usd=$0.1374，0 失败），数据有效但不续
- `runs/20261019-120004-g39h`：30/30 trial EXDEV 秒败，保留作事故证据
- 本次 ny0d 为全新 run，不 resume 任何孤儿；两目录点火后 mtime 无变化

## 预计耗时与监控

- 实测单 trial ~143-150s、并发 2 → 108 trials 约 **2.2-2.5 小时**；按当前费率全程约 $2.0（< $3 上限）
- 监控：`node ../dsh-eval-infra/lib/cli.js progress 20261019-122622-ny0d` 或直接读 `.dsh-eval/runs/20261019-122622-ny0d/progress.json`
- 基础设施失败语义（EXDEV 复现 / 401 / 连续 5 个 trial 级 error）由下一棒（AA-REPORT）处置；本回合点火方在存活证明后即收工
- **运行已 detach，本会话可安全退出**

---
**DevOps 自动化师** · 2026-10-19
