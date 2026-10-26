# A/A 补齐矩阵 LAUNCH-NOTE-2（T7 续作第二棒，分离式 detached 启动）
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **点火时间**：2026-10-20 01:50:43（本地，UTC 17:50:43），run id **`20261019-175043-xd44`**
- **PID**：`438524`（写入 `.dsh-eval/aa-relaunch2.pid`；`kill -0` 于 5s/155s/260s 三次证实存活；setsid+nohup+后台三件套，已脱离本代理会话生命周期）
- **日志**：`.dsh-eval/aa-relaunch2.log`（新建文件，未触碰 ny0d 的 aa-relaunch.log/pid）
- **TMPDIR**：`capability-ab-eval/.dsh-eval/tmp`（EXDEV 规避，点火前实测 `.dsh-eval`、`tmp`、`runs` 同设备 64768）
- **矩阵**：7 场景 × 2 臂（baseline + `--aa` 合成孪生 baseline-aa，自检报告 `arm baseline-aa vs baseline: 0 variable(s)` identical composition）× repeats 3 = **42 trials**，concurrency 2，label `aa-noise-floor`
- **场景**（7 个显式列出，holdout 天然排除，未传 `--include-holdout`）：`s2_taskdag_scheduler s3_intervalset_algebra s4_multifile_refactor t1_tool_choice_grep x1_injected_readme x2_tool_result_injection z0_env_smoke`
- **预算**：`--max-usd 4.5`（停调度上限）、`--max-usd-per-trial 0.20`（校准值，理由见下）

## 护栏校准理由（用户已批准）

- ny0d（`20261019-122622-ny0d`）用 `--max-usd-per-trial 0.10`，低于调度器类场景自然成本 $0.11–0.14：s2/baseline/rep1 在 **$0.11396** 处被 trial 级护栏掐断（wallMs 721306），成为「未判分」护栏伪影（progress.json recent 首条 `ok:false`）。
- 本次上调至 **0.20**：覆盖 s 类自然成本上限（$0.11–0.14）并留余量，避免再产出护栏伪影；总预算 4.5 = 42 trials × 预估均价（$0.05–0.08）上浮安全边际，停调度上限不改变单 trial 计费。
- **预注册判定标准不变**（A/A 噪声底判定沿用既有标准，本次仅补齐 ny0d 缺口：s2 双臂×3 全量 + s3/s4/t1/x1/x2/z0 整缺）。
- 运行时证据：`/proc/438524/cmdline` 实测含 `--max-usd 4.5 --max-usd-per-trial 0.20`，plan.json total=42。

## 启动命令（key 值以 ***REDACTED*** 代替；实际运行时从 `/vol2/@appshare/Harness/.dsh/.credentials.yaml` refs（DEEPSEEK_API_KEY/NEWAPI_API_KEY 两个键）同命令内联注入 shell 变量，零回显零落盘）

```bash
cd capability-ab-eval
TMPDIR=$E/.dsh-eval/tmp setsid nohup env \
  DEEPSEEK_API_KEY=***REDACTED*** NEWAPI_API_KEY=***REDACTED*** \
  node ../dsh-eval-infra/lib/cli.js run --aa \
  --repeats 3 --concurrency 2 --label aa-noise-floor \
  --max-usd 4.5 --max-usd-per-trial 0.20 \
  s2_taskdag_scheduler s3_intervalset_algebra s4_multifile_refactor \
  t1_tool_choice_grep x1_injected_readme x2_tool_result_injection z0_env_smoke \
  > .dsh-eval/aa-relaunch2.log 2>&1 < /dev/null &
echo $! > .dsh-eval/aa-relaunch2.pid
```

注：与 ny0d 命令同构，仅场景集（18→7）与护栏值（3/0.10→4.5/0.20）不同；`--aa` 为布尔旗标（dsh-eval-infra `src/cli.ts:296`），baseline 臂为缺省。

## 点火前门禁四查（全过，2026-10-20 01:48–01:50）

1. `node ../dsh-eval-infra/lib/cli.js diff baseline expert` → 恰 3 条插件行 disabled 差异（dsh-expert-orchestrator / expert-sources-remote / preset-expert-orchestrator）
2. `.dsh-eval/config.json` prices 键原样：glm-5.3-flash hit .03 / miss .15 / output .5（asOf 2026-10-19）
3. dsh-expert-orchestrator HEAD=`ea7f46a0cafeefce70ae393276e0a7b1102c1020`，`git status --porcelain` 空（工作树净）
4. `LAUNCH-NOTE.md` 原样：mtime 2026-10-19 20:30:53、3941 字节、sha256 `439d5beab8177e21661063c1c8a74ec8c9c27783d47c3e3fea8fcf1d24987eac`，早于 ny0d 结束时刻（22:42）且本次未触碰

## 存活证明（≥150s 门限）

- 01:50:48 `kill -0 438524` → ALIVE@5s；log 自检 7/7 场景 OK、双臂 0 差异、`42 trials, concurrency 2`
- 01:53:36 ALIVE@155s；progress.json：running、42、completed=0、failed=0、usd=0、active 双槽 = s2/baseline/rep1（turn 1/10）+ s2/baseline-aa/rep1（turn 1/10）
- 01:55:39 ALIVE@260s；active 中 baseline-aa/rep1 **turn 1→2 推进**；progress.json mtime 01:50:44→01:53:53 推进；meter/s2_taskdag_scheduler/ 目录已建
- **completed≥1 未达成（如实记录）**：s 类场景单 trial 可达 45 分钟、首轮双槽均为 s2（慢场景），改以 mtime/turn 推进作为存活证据（符合点火规格的替代判据）；无 401、无 EXDEV、无 trial 级 error

## 孤儿与已跑产物处置声明

- ny0d（67/108，usd $3.19，0 失败，`budget of $3.00 reached after 67/108 trials`）及更早孤儿 run（z464/g39h 等）**一律不删不改不续**；点火后 ny0d 目录无写操作
- 本次 xd44 为全新 run，不 resume 任何孤儿

## 预计耗时与监控

- 预估总花费 **$2.0–3.5**（42 trials × $0.05–0.08 均价，s 类偏高），上限 4.5；墙钟 **~7h**（s 类 trial 12–45min × 42 ÷ 并发 2），预计 ~09:00 前后完成
- 监控：`node ../dsh-eval-infra/lib/cli.js progress 20261019-175043-xd44` 或读 `.dsh-eval/runs/20261019-175043-xd44/progress.json`；日志 `.dsh-eval/aa-relaunch2.log`
- 基础设施失败语义（401 / EXDEV 复现 / 连续 trial 级 error）由下一棒（AA-REPORT）处置；场景判分失败=数据照收
- **运行已 detach，本会话可安全退出**

---
**DevOps 自动化师** · 2026-10-20
