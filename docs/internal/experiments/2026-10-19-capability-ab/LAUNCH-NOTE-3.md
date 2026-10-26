# A/B 正式点火 LAUNCH-NOTE-3（T8 第一棒）
> 发布说明：本文由评测工作区归档发布；原始 run ledger 未随报告发布，文中 `RUN/`、`L/` 行号引用以本地留档为准。
> 内网服务地址已以 `<NEWAPI_LAN_HOST>` 占位。

- **点火时间**：2026-10-20 08:39:40–08:40:23 CST（UTC 00:39–00:40），run id **`20261020-004018-9nn3`**（startedAt 2026-10-20T00:40:23Z）
- **PID**：`1054473`（写入 `.dsh-eval/ab-relaunch.pid`；setsid+nohup+后台三件套，已脱离本代理会话生命周期）
- **日志**：`.dsh-eval/ab-relaunch.log`（ab-* 新文件；第一次点火被拒的原始日志完整保留于 `.dsh-eval/ab-relaunch-attempt1-fairness-refusal.log`，未触碰任何 aa-*）
- **TMPDIR**：`capability-ab-eval/.dsh-eval/tmp`（点火前实测 `.dsh-eval`/`tmp`/`runs` 同设备 st_dev 64768，EXDEV 规避）
- **矩阵**：18 场景 × 2 真实臂（baseline vs expert，普通 run 非 `--aa`）× repeats 3 = **108 trials**，concurrency 2，label `ab-capability`，provider=newapi / model=glm-5.3-flash / effort=max（同 xd44 构型）
- **场景**（18 个显式列出，holdout n1/n2/n3/v1 天然排除，未传 `--include-holdout`）：`z0_env_smoke f1_log_triage f3_test_suite_fix f4_grep_rename f8_verbose_tests f10_db_investigation l1_chain_migrate l2_ledger_state m1_cross_session_recall p1_format_contract p2_persistent_rule s1_longhorizon_debug s2_taskdag_scheduler s3_intervalset_algebra s4_multifile_refactor t1_tool_choice_grep x1_injected_readme x2_tool_result_injection`
- **护栏**：`--max-usd 16`（停调度）、`--max-usd-per-trial 0.50`（trial 级 cap）

## 护栏校准理由（用户已批准：cap $0.50 / 总上限 $16 / 预算实际约 $10–14）

- **per-trial 0.50**：A/A 实测证据——ny0d cap 0.10 掐 11 trial（l2×4、s1×6、s2 伪影×1）；校准到 0.20 后 xd44 **仍再掐 17**（s2×6、s3×5、s4×5）；s 家族自然成本 **≥$0.28 未测出上界**（A/A 全部在 cap 处截断，censoring 低估真实成本）；run 内单 trial 实测最大计费 **$0.2757**（xd44 s4/baseline-aa/rep1，从 ledger `totals.usd` 复核）。0.50 = 实测最大 $0.2757 + 余量。
- trial 在 0.50 被掐 = **数据**（下一棒分类），非故障；但若 s 家族过半被掐，如实写入简报。
- **run 级 16**：预算推算——light14 84 trial 均价 $0.0304 ≈ $2.55（A/A 84 trial 实测 $2.5500，0 掐）；heavy4 24 trial 在 0.50 cap 下每 trial $0.30–0.50 ≈ $7.2–12 ⇒ 总计 **$9.8–14.6**，与用户「实际约 $10–14」吻合。ny0d 实测护栏穿越系数 1.065 ⇒ $16 对应实际停机 ≈ $17，可接受。AA-REPORT §3 的 $7.6–8.0 是锚定 cap 0.20 截断口径的下界，0.50 下 heavy trial 跑得更远，预估相应上修。
- **墙钟诚实区间**：light 84×130s÷2 ≈ 1.5h；heavy 24×（985s 实测下界 … 单 trial 可达 60min+）÷2 ≈ 3.3–12h+ ⇒ **约 5–13h**；**s 家族不设上限盲区**（0.50 cap 下自然成本/时长上界未测出，用户已知悉并批准）。

## 与 AA-REPORT §5 命令形态的偏差记录（--allow-multi，必加）

- 第一次点火（08:35:55，无 `--allow-multi`）被 CLI 公平性门拒绝：`lib/core/orchestrate.js:233` — `arm expert differs from baseline in 3 variables; a fair A/B changes one thing (pass --allow-multi …)`。
- 该 3 variable 恰为门禁①要求的 3 条插件行（dsh-expert-orchestrator / expert-sources-remote / preset-expert-orchestrator，baseline 侧 disabled）；SMOKE-REPORT-6 §2 已备案：amendendum 有意将变量重定义为「插件有无」，composed 树表现恰为 3 行，`diff` exit 1 属预期语义。
- 硬约束禁改 arms ⇒ 无法把 3 行折叠成 1 variable；`--allow-multi` 是唯一合规路径。它不改变双真实臂形态/trial 数/判分，仅在 env.json 标记 `multiVariable: true`（report 标注 multi-variable）。
- **dry-run 验证先行**（08:39:46，`--dry-run` + 同参数）：`run 20261020-003946-0pru: 18 scenarios × 3 repeats × 2 arms = 108 trials, concurrency 2`、`dry run: nothing executed`，通过后方才实点火。
- **惰性孤儿目录（不删不改）**：`20261020-003627-v8ml`（第一次点火被拒产物，仅空 `arms/`，无 plan/env/ledger，$0）与 `20261020-003946-0pru`（dry-run 产物，plan/env 已写但零 trial，$0）。均不计入判读。

## 启动命令（key 值以 ***REDACTED*** 代替；实际运行时自宿主 `/vol2/@appshare/Harness/.dsh/.credentials.yaml` refs（DEEPSEEK_API_KEY/NEWAPI_API_KEY 两键）同一 shell 命令内读入变量、以前缀赋值注入环境后经 setsid 传递，**零回显零落盘**：/proc/1054473/cmdline 实测含 `--max-usd 16 --max-usd-per-trial 0.50` 且不含任何 API_KEY 字样，key 仅存在于进程 environ）

```bash
cd capability-ab-eval
DK=$(python3 -c "…读 refs/DEEPSEEK_API_KEY…")   # ***REDACTED***
NK=$(python3 -c "…读 refs/NEWAPI_API_KEY…")     # ***REDACTED***
DEEPSEEK_API_KEY="$DK" NEWAPI_API_KEY="$NK" TMPDIR="$PWD/.dsh-eval/tmp" \
  setsid nohup node ../dsh-eval-infra/lib/cli.js run \
  --baseline baseline --arm expert \
  --repeats 3 --concurrency 2 --label ab-capability \
  --max-usd 16 --max-usd-per-trial 0.50 --allow-multi \
  z0_env_smoke f1_log_triage f3_test_suite_fix f4_grep_rename f8_verbose_tests \
  f10_db_investigation l1_chain_migrate l2_ledger_state m1_cross_session_recall \
  p1_format_contract p2_persistent_rule s1_longhorizon_debug s2_taskdag_scheduler \
  s3_intervalset_algebra s4_multifile_refactor t1_tool_choice_grep \
  x1_injected_readme x2_tool_result_injection \
  > .dsh-eval/ab-relaunch.log 2>&1 < /dev/null &
echo $! > capability-ab-eval/.dsh-eval/ab-relaunch.pid
```

## 点火前门禁五查（全过，2026-10-20 08:33–08:36）

1. `node ../dsh-eval-infra/lib/cli.js diff baseline expert` → 恰 3 variable：dsh-expert-orchestrator / expert-sources-remote / preset-expert-orchestrator 三条插件行（baseline 侧 disabled），无其他差异行 ✓（exit 1 为既备案语义，见 SMOKE-REPORT-6 §2）
2. `.dsh-eval/config.json` prices 键原样：asOf 2026-10-19，glm-5.3-flash hit .03 / miss .15 / output .5（peak=offpeak）✓
3. dsh-expert-orchestrator HEAD=`ea7f46a0cafeefce70ae393276e0a7b1102c1020`，`git status --porcelain` 0 行 ✓
4. 报告/笔记原样：AA-REPORT.md（mtime 2026-10-20 04:43:20、14806 B、sha256 `e554d343…05b5b51`）· LAUNCH-NOTE-2.md（01:57:10、5407 B、`073463ee…fcb924a`）· LAUNCH-NOTE.md（2026-10-19 20:30:53、3941 B、sha256 `439d5beab8177e21661063c1c8a74ec8c9c27783d47c3e3fea8fcf1d24987eac`，与 AA-REPORT §5 记录值一致）✓
5. 前序 run 产物原样（progress 与 AA-REPORT §6 逐项吻合）：ny0d=cancelled 67/108 $3.1937 · xd44=done 42/42 $4.3742 · z464=running-stale 8/108 $0.1374 · g39h=running-stale 30 failed $0 ✓；加查 EXDEV：`.dsh-eval`/`tmp`/`runs` st_dev 同 64768 ✓

## 存活证明（≥150s 门限，全过）

- 08:39:45 `kill -0 1054473` → **ALIVE@5s**；log：selfcheck 18/18 场景 OK、`arm expert vs baseline: 3 variable(s)`（--allow-multi 放行）、`108 trials, concurrency 2`
- ~08:41:33 ALIVE（ELAPSED 01:51）；progress.json：running、108、completed=0、failed=0、双槽 active = f10/baseline/rep1 + f10/expert/rep1（A/B 交织配对）；meter/f10_db_investigation/ 已建
- **08:44:52 终验 ALIVE（ELAPSED 04:34 = 274s ≥ 150s）**；progress：**completed=3、failed=0、usd=$0.0575**（completed≥1 ✓、usd 累计 ✓）；progress.json mtime 08:42:49→08:44:08 推进 ✓
- 错误面：log 全文 grep `401|Unauthorized|EXDEV` 唯一命中为 run id 时间戳 `…00**401**8…` 子串（误报），排除后 **0 命中**；无 trial 级 error

## 预算/监控/失败语义

- 预算预估 $9.8–14.6（护栏 16 停调度，实际停机估 ~$17）；墙钟 5–13h（s 家族盲区如上）
- 监控：`node ../dsh-eval-infra/lib/cli.js progress 20261020-004018-9nn3` 或读 `.dsh-eval/runs/20261020-004018-9nn3/progress.json`；日志 `.dsh-eval/ab-relaunch.log`
- 基础设施失败语义（401 / EXDEV 复现 / 连续 5 trial 级 error）由下一棒处置；场景判分失败 / cap 掐断 = 数据照收（0.50 掐断由下一棒分类；s 家族过半被掐则如实入简报）
- **运行已 detach，本会话可安全退出**

---
**DevOps 自动化师** · 2026-10-20
**数据**：A/B 正式点火 18×2×3=108 trials（baseline vs expert 双真实臂），护栏 16 / 0.50（用户批准）
**偏差**：命令形态加 `--allow-multi`（公平性门 orchestrate.js:233 强制；3 插件行=单一概念变量「插件有无」，SMOKE-REPORT-6 已备案；禁改 arms 下的唯一合规路径）
**下一步**：下一棒判读（T8 收口），预注册口径沿用 AA-REPORT §2（pooled +20pp 门 + pass^3，l2/s3 单格翻转记噪声）
