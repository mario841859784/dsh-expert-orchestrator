# T25 发版留痕：dsh-expert-orchestrator 2.13.10

- 执行人：devops-engineer（T25，编排者 summon 委派，用户已明示发版授权）
- 日期：2026-11-11
- 工作树：`/vol2/@appshare/Harness/workspace/dsh-expert-orchestrator` @ main `32354b9`
- 红线遵守：零代码改动（发布动作未改工作树内容）；`?? docs/research/` 在途改动未触碰；无凭据硬绕。

## 0. 动工前只读核实（全部通过）

| 项 | 预期（编排者口径） | 实测 | 结论 |
|---|---|---|---|
| package.json:4 | 2.13.10 | 2.13.10 | ✓ |
| dsh.plugin.json:4 | 2.13.10 | 2.13.10 | ✓ |
| lib/index.js:95 | 2.13.10 | `const VERSION = '2.13.10'` | ✓ |
| npm registry latest | 2.13.9 | 2.13.9 | ✓（待发布） |
| npm whoami | mario841859784 | mario841859784 | ✓ |
| origin/main..HEAD | 27 commit 未推 | 27 commit，behind=0（fetch 后复核，无分叉） | ✓ |
| SSH key id_ed25519_74 | 不存在 | `ls` exit=2，不存在 | ✓（NAS 步预期 skip） |
| 工作树状态 | 仅 ?? docs/research/ | `git status --porcelain` 仅 `?? docs/research/` | ✓ |

## 1. 对账基线（步骤 a）

`node scripts/sync-deploy.mjs status`（发布前，动工基线留痕）：

```
[sync-deploy] npm latest      : 2.13.9
[sync-deploy] 本地工作区      : 2.13.10 @ 32354b9 …（最近 tag v2.13.9）
[sync-deploy] Mac desktop     : 非 symlink 安装
[sync-deploy] SSH key 不存在：/vol2/@appshare/Harness/.ssh/id_ed25519_74（发版同步需要免密通道，先装公钥）
exit=2
```

status 整体 exit=2 由 SSH key 缺失引起（脚本退出码约定 2=环境缺失跳过）；本地/registry 两项对账数据正常输出。

## 2. git push（步骤 b）

- 前置：`git fetch origin` 后复核 `origin/main..HEAD`=27、`HEAD..origin/main`=0，无分叉。
- 执行：`git push origin main` → exit=0，`ee9288f..32354b9 main -> main`。
- 后验：push 后双向 rev-list 均 0，本地与 origin/main 完全一致。
- 未使用 force。

## 3. npm publish（步骤 c）

- publish 前只读核对：`npm pack --dry-run` 共 63 文件，关键文件全部在白名单内——
  `skills/expert-orchestration/SKILL.md`（96.3kB）、`skills/expert-orchestration/tools/bus.py`（42.4kB）、
  `skills/expert-orchestration/tools/taskboard.py`（233.6kB）、`lib/` 全套（含 lib/index.js 104.2kB）、
  package.json / dsh.plugin.json / README.md / README.zh.md / CHANGELOG.md 均在。
- 执行：`npm publish` → exit=0，`+ dsh-expert-orchestrator@2.13.10`，
  tarball 447.8 kB，shasum `2466da38f84a3e01fcc93fe6540d0c48b62c69a9`，total files: 63。
- 实证（CDN 传播延迟约 90–150s，轮询至 HTTP 200）：
  - `https://registry.npmjs.org/dsh-expert-orchestrator/2.13.10` → 200，version=2.13.10，shasum 与 publish 输出逐字一致；
  - `npm view dsh-expert-orchestrator version` → **2.13.10**（dist-tags latest）。
- 发布期间现象记录：publish 成功后约 1 分钟内 `npm view` 与 registry 全量 JSON 仍返回 2.13.9（CDN 缓存分片传播），轮询第 3 次（约 2.5 分钟）后 200。属正常传播窗口，无回滚需要。

## 4. Mac desktop 同步（步骤 d）

`node scripts/sync-deploy.mjs mac` → exit=0：

```
[sync-deploy] git fetch origin …
[sync-deploy] ⚠ 工作树有未提交改动（desktop 实跑的就是这些）： ?? docs/research/
[sync-deploy] 已与 origin/main 一致（32354b9ea），无动作。
[sync-deploy] 提醒：desktop 宿主需重启才会加载新 lib（Electron 无法脚本重启）。
```

- desktop 工作树即宿主实跑本体（link: symlink 形态），push 后已与 origin/main @32354b9 一致，无需拷贝。
- **宿主重启指引（脚本无权执行，需人工）**：Electron desktop 宿主需重启后才会加载 2.13.10 新 lib。

## 5. NAS 生产同步（步骤 e）——SKIP

`node scripts/sync-deploy.mjs nas` → exit=2：

```
[sync-deploy] SSH key 不存在：/vol2/@appshare/Harness/.ssh/id_ed25519_74
```

- skip 原因：免密 SSH key `/vol2/@appshare/Harness/.ssh/id_ed25519_74` 不存在，无凭据硬绕（红线）。
- **后续手动步骤（待 NAS 侧 key 装好后由人或下次任务执行）**：
  1. 在 NAS（841859784@192.168.5.74）`authorized_keys` 装入对应公钥，key 落位 `/vol2/@appshare/Harness/.ssh/id_ed25519_74`；
  2. 复跑 `node scripts/sync-deploy.mjs nas`（脚本将把 NAS web profile 依赖升级到 npm latest=2.13.10，依赖级安装，不手工拷 node_modules）；
  3. NAS dsh web 属 fnOS 应用，重启须 appcenter UI 操作（脚本无 kill 权限，EPERM 实证）。

## 6. 终态核验（步骤 f）

`node scripts/sync-deploy.mjs status`（发布后）：

```
[sync-deploy] npm latest      : 2.13.10
[sync-deploy] 本地工作区      : 2.13.10 @ 32354b9 …
[sync-deploy] Mac desktop     : 非 symlink 安装
[sync-deploy] SSH key 不存在：/vol2/@appshare/Harness/.ssh/id_ed25519_74（发版同步需要免密通道，先装公钥）
exit=2
```

- 本地 = registry = **2.13.10** ✓；desktop 实跑工作树 = origin/main 32354b9（同版本）✓。
- status exit=2 仍由 SSH key 缺失引起，不构成对账失败。
- 未完成项：NAS profile 仍停留在旧版（待 key 装好后按 §5 手动步骤收口）。

## 7. 变更清单与影响面

| 动作 | 影响 |
|---|---|
| git push origin main（27 commit，ee9288f→32354b9） | 远端 main 前进；desktop 工作树随之对齐 |
| npm publish 2.13.10 | registry latest 2.13.9→2.13.10；新装/升级用户即得 |
| sync-deploy mac | 无动作（已一致），留宿主重启提醒 |
| sync-deploy nas | 无副作用，exit=2 skip |

工作树内容零改动（发布动作不改代码）；唯一新增文件即本留痕文件。

## 8. 回滚步骤

- npm 侧：npm 不可删除已发布版本，如需回退执行 `npm dist-tag add dsh-expert-orchestrator@2.13.9 latest`（把 latest 标签拨回 2.13.9）；2.13.10 版本本体保留在 versions 列表。
- git 侧：`git push --force origin ee9288f:main` 仅在远端 main 被污染时考虑（本次无需要，未执行）。
- 触发标准：2.13.10 上线后出现功能性回退报告（发布产物校验失败、宿主加载异常）即回拨 latest 标签。

## 9. 宿主感知发版（T26 追加，devops-engineer）

### 9.1 问题与改法

T25 发版夜实证两处宿主错配：`mac` 步在本会话 NAS 宿主上因 `~/.dsh/profiles/desktop` 同形路径假阳性命中而 exit=0；`nas` 步在本机=NAS 时无条件 `ssh 841859784@192.168.5.74` 回环且免密 key 缺失 exit=2。T26 给 `scripts/sync-deploy.mjs` 加宿主检测（唯一代码改动面，三既有模式本体逐字节不动）：

- **宿主检测**（`hostDetect()`）：mac = `process.platform === 'darwin'`（NAS 不可能是 darwin，零误判面）；nas = linux 且 `homedir()` 前缀 `/vol2/@appshare/Harness`（fnOS Harness 应用用户家目录，即脚本全部生产缺省路径的根）且生产 profile 或 workspace 目录在位；其余 = other。误差面：非 NAS Linux 伪造同形 homedir + 同名目录概率极低；NAS 上目录缺失则降级 other → auto 显式报错不猜。
- **新 `auto` 模式（发版推荐入口）**：宿主检测 + 只读对账 → 按宿主分发。NAS = NAS 本机流（本机 profile 依赖级升级到 npm latest，与 nasNpmPath 语义逐条对齐但无 SSH 回环；升级后校验 + 权限归一 + fnOS appcenter UI 重启指引）；mac = 现状 mac 本地流语义逐字节不变；other = exit=2 不猜。
- **显式模式宿主门**（`hostGate()`）：`mac` 在非 mac 宿主 exit=2 具名提示；`nas` 在 NAS 宿主（ssh 目标即本机回环）exit=2 具名提示且先于 SSH key 检查触发；`status` 只读对账不设门。既有兼容面不受影响：真 mac 跑 mac、非 NAS 宿主跑 nas 原样放行；`--file`/`--restart`/`DSH_SYNC_NAS_*` 覆盖全部保持。

### 9.2 发版四步（宿主感知版，auto 优先）

1. **push**：`git push origin main`（与 T25 同）；
2. **publish**：`npm publish`（与 T25 同）；
3. **发版同步（原 mac/nas 两步合一）**：在发版宿主上跑 `node scripts/sync-deploy.mjs auto`——NAS 宿主自动走本机流升级 web profile，mac 宿主自动走 mac 本地流；auto 不可识别宿主时按提示显式 `mac`/`nas`（远端 nas 流仍供跨机使用）；
4. **冒烟**：与 T25 同。

### 9.3 本机 NAS 流手动收口步骤（2.13.10 当前待收口项）

T25 §5/§6 遗留：NAS web profile 实装 2.13.9（latest 2.13.10）。免密 SSH key 至今缺位，但宿主感知改造后**无需 key**即可本机收口：

```
node scripts/sync-deploy.mjs auto   # NAS 宿主 → 本机流：profile 2.13.9→^2.13.10 依赖级安装 + 权限归一
# 重启（脚本无 kill 权限）：fnOS 应用中心 → Harness → 重启
```

回滚：profile `package.json` 的 `dsh-expert-orchestrator` spec 拨回 `^2.13.9` 后 `pnpm -C ~/.dsh/profiles/web install`。

### 9.4 T26 真机验证留痕

| 用例 | 手段 | 结果 |
|---|---|---|
| 宿主检测（NAS 真机） | selftest 真机分支 + CLI 门 | hostDetect()=nas；mac/nas 显式模式 exit=2 具名提示，nas 门先于 SSH key 检查（回环不发生）；unknown exit=1、无参 exit=2 保持 |
| auto「已最新无动作」 | fixture（/tmp，spec ^2.13.10 + stub 实装 2.13.10，`DSH_SYNC_NAS_PROFILE` 覆盖） | exit=0，无动作，appcenter 重启指引输出 |
| auto 升级路径 | fixture（/tmp，spec ^2.13.9 + stub 实装 2.13.9） | exit=0，真实 pnpm 依赖级安装 2.13.9→2.13.10、pnpm-lock 随动、升级后校验一致（fixture 已清理，生产 profile 未触碰） |
| mac 本地流 | mock platform=darwin 单测（本宿主 NAS 无法真机验） | 门径选择/放行逻辑覆盖；cmdMac 本体零改动、真机 mac 语义不变（如实声明：未在真 mac 上跑过） |
| 全量对账 | npm test | 580 tests / 578 pass / 0 fail / 2 skipped = 基线 576/574/0/2 + 新增 4 用例，零回归 |

生产 web profile 本任务未升级（2.13.9 现状保持）：该 profile 正承载本会话 dsh web 宿主，且任务书「已最新无动作」前提与实测不符，按破坏性操作确认纪律留待 §9.3 单步收口。

## 10. NAS 生产升级实际执行记录（2026-11-11 23:44，用户确认后）

- 首跑 auto 失败：pnpm 无法移除 node_modules/zod（Permission denied os error 13）——根因=历史同步产物属主错位（node_modules 内容属 841859784:Users，NAS 宿主运行账号 Harness(903) 无写权限）。
- 解法：`mv node_modules node_modules.old-2.13.9`（父目录归 Harness 可改名；旧目录整体保留兼作回滚）→ 重跑 auto 全新安装 → **实装 2.13.10**，pnpm-lock 随动，校验一致。
- 遗留清理项：`profiles/web/node_modules.old-2.13.9` 需 841859784 账号或管理员删除（Harness 用户无权限）。
- 遗留脚本缺陷（下迭代修）：auto 升级校验失败路径仍 exit=0（本次首跑实证），应具名非零退出。
- 生效条件：dsh web 进程（pid 3875208）内存仍是旧代码，须 fnOS 应用中心重启 Harness。
