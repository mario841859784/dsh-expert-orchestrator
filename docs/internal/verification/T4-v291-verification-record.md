# T4（v2.9.1 板）发布门禁①-⑦复跑验证记录

- 任务：dsh-expert-291 板 T4；对工作树（2.9.0 + 本板 T1/T2/T3 修复，**版本未 bump**）复跑发布门禁①-⑦，为 2.9.1 发布（T6）留验证基线。
- 工作树口径：基线 HEAD=`b1a9cd1`；未提交改动 = 本板 T1（`lib/tools.js` + `test/tools.selftest.mjs`）、T2（`agent.cordis.yml` + `cordis.patch.yml` + test）、T3（`lib/persona-vars-gate.js` + `scripts/scan-persona-vars.mjs` + `test/persona-vars-gate.selftest.mjs` 新增）——`git status --porcelain` 实测恰此 4 M + 3 ??，与任务书逐项吻合，无外来改动、零触碰。禁改面（package.json 版本三处、git commit/publish）全程未动，工作树终态与开工时逐项一致。
- 验证日期：2026-10-10 12:50 CST；方法：全部实测——`npm test`、`npm pack --dry-run`、`grep -c/-n`、零依赖 semver 脚本（`/tmp/t291-verify/semver-matrix.mjs`）、真实 `apply()` 沙箱演练（`/tmp/t291-verify/refresh-drill.mjs`，沿 T7/T41 档案法）。
- 口径权威：`docs/internal/verification/T4-v29-verification-record.md`（门禁④豁免清单与复现命令）+ CHANGELOG 历版 Verified 段 + `T7-protocol-drill-17entries/`（PROTOCOL drill 先例）+ `T41-peer-semver-matrix.md`（静态矩阵法）。

## 一、结论

**七项可离线执行项全过：① npm test 269 tests / 268 pass / 1 skipped / 0 fail（exit 0，新基线，T3 后）；② pack 87 文件 = 2.9.0 基线 86 + `lib/persona-vars-gate.js`（随 `lib/` 白名单自动入包），files 白名单无需补（建议见 §二）；③ semver 三行 3/3（exit 0）；④ 豁免 7+10 处数守恒、行号零平移；⑤ PROTOCOL drill ALL PASS（17 条目 60 文件 sha256 逐字节一致，exit 0）；⑥ 手势声明两代宿主（0.2.1-alpha.2 实物树 + 0.1.7-alpha.2 pinned 装树）各 14/14 ✅ exit 0，声明产物 `--check` 可复现 exit 0；⑦ `scan-persona-vars.mjs` PASS（exit 0）。宿主实测项（召唤注册成功/通道可用）本任务不做，待 T6 发布重装后用户重启宿主补测。**

## 二、逐项证据（2026-10-10 实测）

### ① npm test 全绿——新基线 269/268/1 skipped

```
$ npm test   # exit 0
ℹ tests 269 / pass 268 / fail 0 / cancelled 0 / skipped 1 / todo 0
ℹ duration_ms 122241
```

- 与任务书给定新基线（269/268/1 skipped，T3 后）一致；对 2.9.0 基线 253 的增量 = T1/T2/T3 修复配套用例（+16，含 `test/persona-vars-gate.selftest.mjs` 新套件）。
- **1 skipped 归因（实测定位）**：`test/tools.selftest.mjs:5428` T14 部署面 e2e 用例——默认宿主模块路径 `/vol2/@appcenter/Harness/server/node_modules` 已失效（宿主现居 `@vol2/@appdata/.../0.2.1-alpha.2/node_modules`），属环境耦合、非产品缺陷。该用例支持 `DSH_HOST_MODULES` 覆盖，补跑实证：

```
$ DSH_HOST_MODULES=/vol2/@appdata/Harness/server/0.2.1-alpha.2/node_modules \
  node --test --test-name-pattern="部署面端到端" test/tools.selftest.mjs   # exit 0
ℹ tests 1 / pass 1 / fail 0 / skipped 0
```

  → 环境路径修正后实际 269/269 全绿；基线口径仍按既定 269/268/1 skipped 记录（默认路径下的标准跑法）。

### ② npm pack --dry-run：87 文件 vs 2.9.0 基线 86

```
$ npm pack --dry-run 2>&1 | tail -3
npm notice package size: 341.2 kB
npm notice total files: 87
```

- **差量恰 +1：`npm notice 4.3kB lib/persona-vars-gate.js`**（T3 交付，随既有 `lib` 白名单自动入包）。顶层文件清单与 2.9.0 逐项一致（CHANGELOG.md/LICENSE/README×2/agent.cordis.yml/cordis.patch.yml/dsh.plugin.json/package.json/preset.yml + lib/skills/expert-lessons/expert-methods 四目录）。
- **入包判定**：`lib/persona-vars-gate.js` ✔ 入包；`scripts/scan-persona-vars.mjs` ✘ 不入包（`scripts/` 从不在 files 白名单）；`test/persona-vars-gate.selftest.mjs` ✘ 不入包（测试文件历来不入包，口径一致）。
- **结论与建议（只记录，不改 package.json，改法归 T6）**：**files 白名单无需补**——门禁⑦属仓库侧发布门禁 CLI，与既有三个 `scripts/` 工具（`build-classic-pack.mjs`/`gen-preset-declaration.mjs`/`verify-gesture-declaration.mjs`）同为不入包惯例；其依赖的 `lib/persona-vars-gate.js` 已入包，未来如需部署面复跑门禁⑦可经包内 lib 直调，无需动白名单。

### ③ peer/engines semver 矩阵复验（三行）

声明原文实测与 T41 档案逐字一致（2.6.0 起未动）：

```
engines.dsh = >=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0
peer @deepseek-ai/dsh-tools = >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0
```

```
$ node /tmp/t291-verify/semver-matrix.mjs   # exit 0（零依赖，沿 T41 静态矩阵法）
version          engines  peer    note
0.1.7-alpha.2    true     true    PASS  old-generation host (verified generation)
0.2.1-alpha.1    true     true    PASS  current running host line
0.2.1-alpha.2    true     true    PASS  0.2.1 tuple prerelease admitted by >=0.2.1-0 lower bounds
MATRIX: 3/3
```

（过程留痕：首版脚本 0/3，插桩定位为 `sat()` 未先 parse 字符串候选致 NaN——**脚本 bug，非声明面问题**；修复后 3/3，声明区间零改动。）静态声明面立场沿 1B 裁决：真实装载归宿主实测（见 §四）。

### ④ undefined/None 豁免清单——处数守恒 7+10，行号零平移

```
$ grep -rn "return undefined" lib/    # 恰 7 行
lib/client.js:136 / lib/tools.js:537 / lib/expert-profiles.js:129
lib/index.js:81 / lib/index.js:1107 / lib/index.js:1116 / lib/host-settings.js:116
$ grep -n "return None" skills/expert-orchestration/tools/taskboard.py   # 恰 10 行
:832 / :839 / :1661 / :1844 / :1847 / :1852 / :1860 / :1867 / :2352 / :2354
```

- 与 v2.9 T4 记录（§三）逐行号一致：T1 对 `lib/tools.js` 的改动**未平移** `:537` 惰性值豁免点；`taskboard.py` 本板零改动。处数 7+10 守恒，函数语境映射不变（fail-open/语义「空」返回，零工具 JSON 返回面暴露）。

### ⑤ PROTOCOL refresh drill（沙箱模拟，沿 T7 档案法）

```
$ node /tmp/t291-verify/refresh-drill.mjs   # exit 0
seeded sentinel files: 60 (17 entries, dirs recursive)
REAL MARKER BEFORE : "2.9.0+sources1"
PASS: marker 2.9.0+sources0 → 2.9.0+sources1
PASS: 17 PROTOCOL entries refreshed byte-identical from the package (60 files compared)
PASS: first apply() refreshed exactly 60 files (~ lines)
PASS: new entry README.md/README.zh.md/CHANGELOG.md: sentinel overwritten, sha256 == package copy  ×3
PASS: USER_DATA untouched ×3 / extra user file inside refreshed protocol dir NOT deleted
PASS: second apply() refreshed nothing (idempotent) / marker untouched by second apply()
REAL MARKER AFTER  : "2.9.0+sources1"
PASS: real deploy marker untouched (read-only对照)
DRILL: ALL PASS (60 files, 17 entries)
```

- 方法：真实 `apply()` 路径（`lib/index.js` 默认导出），沙箱 `targetDir=/tmp/t291-verify/drill-target`；预置 stale 哨兵 + 旧 marker `2.9.0+sources0` 触发刷新（bump 后 `DEPLOY_REV` 必异于任何旧值，机制=`.deployed-version` 字符串不等即全量刷新）；**VERSION 字面量零改动，真实部署目录全程只读对照（marker 前后一致 `2.9.0+sources1`）**。
- 2.9.1 语义点：刷新源=**当前工作树**，故 T2 修改后的 `agent.cordis.yml`（含 persona vars 去除 `{{cwd}}` 后的声明面）经 60 文件级 sha256 比对确认可逐字节落部署面；17 条目清单与 T7 档案一致，本轮零增删。

### ⑥ 声明/手势一致性（既有校验，两代宿主实测）

```
$ node scripts/verify-gesture-declaration.mjs /vol2/@appdata/Harness/server/0.2.1-alpha.2/node_modules   # exit 0
① parsed declaration shape ✅×2  ② gesture dir modelInvocable:false ×11 ✅×4
③ gesture injection render ✅×4  ④ deployed shape mounted AS PARSED → 13 skills ✅×3  ⑤ parent-root inertness ✅×1
PASS: gesture declaration (parsed from the shipped product) verified against .../0.2.1-alpha.2/node_modules
$ node scripts/verify-gesture-declaration.mjs /tmp/t14-host-0.1.7/node_modules   # exit 0（T14 先例装树，仍在）
PASS: …（同构 14/14 ✅）
$ node scripts/gen-preset-declaration.mjs --check --quiet   # exit 0（声明 build 产物可复现——T2 改动后复核）
```

- 0.2.1-alpha.2 为**当前宿主实物树**（`/vol2/@appdata/Harness/server/0.2.1-alpha.2/`，本任务首次对其完成 14/14 实测）；0.1.7-alpha.2 pinned 装树沿 T14 §二② 先例复用。注：脚本缺省路径 `/vol2/@appcenter/...` 已失效（exit 2=文档化跳过，T14 档案明载）；本轮以显式实树参数实跑，非跳过。

### ⑦ persona-vars 扫描 PASS

```
$ node scripts/scan-persona-vars.mjs   # exit 0
persona-vars gate⑦ PASS (2 files, vars ⊆ {provider, model})
```

## 三、基线与差量汇总

| 项 | 2.9.0 基线 | 2.9.1 实测 | 差量 |
|----|-----------|-----------|------|
| ① npm test | 253/253 | 269 tests / 268 pass / 1 skipped（e2e 环境路径修正后 269/269） | +16（T1/T2/T3 配套 + persona-vars 套件） |
| ② pack 文件 | 86 | 87 | +1 = `lib/persona-vars-gate.js` |
| ④ 豁免处数 | 7 + 10 | 7 + 10（行号零平移） | 守恒 |

## 四、待补测清单（宿主实测项，本任务不做）

- **待 T6 发布重装后用户重启宿主补测**（既定 1B 惯例）：
  1. 召唤注册成功（`summon_expert` 工具经宿主注册可用）；
  2. 手势通道可用（`/expert-<name>` 注入——静态面已由⑥两代实测覆盖，宿主运行时归此项）；
  3. 门禁⑦工具在宿主会话的可用性（`scan-persona-vars.mjs` 属仓库侧 CLI，部署面按 §二 结论无需入包）。
- 版本 bump（package.json / dsh.plugin.json / lib/index.js 三处）与 git commit/publish 归 T6；bump 后按「行号平移、处数守恒、复测刷新」惯例复核④与②（bump 不新增文件，②差量应维持 87）。

---
**DevOps 自动化工程师**：七项门禁复跑完毕，全过；工作树仅含本板 T1/T2/T3 合法改动，零污染零触碰。
