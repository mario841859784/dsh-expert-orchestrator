# 独立安全审计报告：dev/exposure-crypto-345（HEAD=ef3b962）— 安全面

- **审计者**：独立安全审计（sec-reviewer-ef3b962），只读，与实现者、代码审查员无关
- **日期**：2026-11-13
- **审计对象**：`git diff 822ff80..ef3b962` 的安全相关面（专用 worktree：`.agents/worktrees/review-exposure-crypto-345`，HEAD 实证 ef3b962）
- **对照基准**：`docs/research/exposure-crypto-trust/00-exposure-crypto-trust.md`（威胁模型 T1–T5、§4.2/§4.3/§4.5/§5 设计与不做边界、§5.10 验收标准）
- **工作树状态**：干净（`git status --porcelain` 零输出），未发现非本任务改动
- **红线遵守**：未改任何被评审文件；探针脚本与临时板全部位于 `/tmp/secprobe`，未写入仓库

## 总体结论

**无阻断项、无高危项**。发现 中 2 项、低 4 项；威胁模型 T1–T5 与实现逐条对照相符，未发现实现弱于声明或超出声明承诺安全保证之处。核心四文件的密码学正确性（RFC 8032）经独立探针（RFC TEST 1 向量 + node:crypto/OpenSSL 双向互验）实证通过。

---

## 发现

### 中-1：_ed25519.py 非常量时间侧信道未在文档/注释中如实声明

- **位置**：`skills/expert-orchestration/tools/_ed25519.py`（全文，尤其 `_scalarmult` / `signature()`；头部注释块）
- **事实**：实现是纯 Python 教科书式 double-and-add 标量乘与朴素模运算，**不是常量时间**。签名路径 `_scalarmult(_BASE, _clamp_scalar(seed))` 与 `s=(r+k*a)%L` 都消费秘密标量 `a`（seed 派生），耗时随密钥位模式波动。头部注释声明了性能量级（sign~10ms/verify~30ms）与严格性，但**全仓 grep（侧信道/常量时间/timing/constant-time）确认没有任何位置声明该侧信道暴露**；CHANGELOG M3 条目亦只声明「纯 python 验签量级慢」。
- **攻击场景一句话**：同机共驻的低权进程对 sign 耗时做统计侧信道，理论上可逐步恢复签名标量（现实风险被「本地部署 + 密钥短命 + 事件签名不做执法」的威胁模型大幅压低，但本仓一贯的「如实声明边界」纪律在此缺口）。
- **建议**：在 `_ed25519.py` 头部注释与 CHANGELOG M3 条目各加一句如实声明（「非常量时间实现——sign 路径消费秘密标量，不抵抗同机侧信道观测；适用边界=单用户本地进程模型」），与调研报告口径对齐。纯声明性改动，不改代码。

### 中-2：A2A message/send 标题直入子进程 argv，无 `--` 分隔符（参数注入面）

- **位置**：`skills/expert-orchestration/tools/a2a_taskboard.py:291`（`argv = ['--json', 'create', title]`，其后拼接 `--owner/--desc/--scope`）
- **事实**：外部 A2A 调用方的 message 首行（不可信输入）被作为 `create` 子命令的位置参数 title 直接放入 argv，**无 `--` 分隔符**。探针实证当前无法成功注入：argparse 下 `create --owner=evil`（title 被吞为选项后 positional 缺失）→ usage error 拒绝；title 首字符 `-` 一律被当选项拒绝——即当前表现为**鲁棒性缺陷（合法标题被误拒）**而非可利用注入。但这是网络不可信输入直达子进程参数的唯一无防护拼接点，且 argparse 前缀缩写匹配使得未来给 create 增加 store_true 型旗标或参数重排时，该点会**静默升级为真参数注入**（如标题 `--auto-ready` 改变任务语义）。
- **攻击场景一句话**：未来任一次 create 旗标扩展后，外部协调者发送标题为 `--quorum-m=1` 的 message 即可在无权限声明的情况下改写任务评审语义。
- **建议**：改为 `argv = ['--json', 'create', '--', title]`（探针已实证 `create -- -normal-title` 正常创建，无兼容性损失），并在 a2a-server.selftest 增加首行 `-` 开头标题用例钉死。

### 低-1：A2A 错误回显可带内部文件路径

- **位置**：`skills/expert-orchestration/tools/a2a_taskboard.py:244-245`（`internal error: {type(e).__name__}: {e}`）、`:306-307`（taskboard 拒绝详情透传 `stderr/stdout`）
- **事实**：兜底与拒绝面把底层异常/子进程输出原文回给调用方，可能携带板文件绝对路径等本机信息。**缓解**：两条路径都在 bearer 认证之后（无凭证者不可达），且无 HTML 反射面（纯 JSON 回包）。
- **攻击场景一句话**：持有合法 token 的外部调用方可借错误回显探测服务端目录结构。
- **建议**：具名错误码优先；兜底面只回 `{type(e).__name__}`，详细信息落 stderr。

### 低-2：全事件剥签重写在 replay 人读面零提示（verify-board 仍 exit 0）

- **位置**：`skills/expert-orchestration/tools/taskboard.py:3442-3449`（replay 签名汇总行条件：`audit.get('signed') or invalid or revoked or unknown_key` 才打印）、`scripts/verify-board.mjs:101,121,135,142`（unsigned 不判异常，exit 0）
- **事实**：持有板文件写权限的攻击者可整板重算 hash 链并剥除 sig/sigkey——hash 链自洽、全部事件 unsigned。verify-board 会如实打印 `unsigned=N` 但 `ok=true, exit 0`；taskboard replay 人读汇总行在 signed=0 时不出现。**核对声明**：调研报告 §4.5④ 明确「真源防改不做」（有写权限者本来就能重写一切），且「模式混合是常态」的口径使 unsigned 不判异常是设计决定——故本项**不构成实现弱于声明**，列为「声明边界内的可改善落差」。
- **攻击场景一句话**：被篡改板的板外验证器以 exit 0「绿灯」输出，人读 replay 面却无任何签名面提示，属验签器可用性弱化。
- **建议**（可选增强）：verify-board 加 `--require-signed` 严格开关；replay 在公钥面 configured 且 signed=0 且 unsigned==全部时也打一行提示。

### 低-3：board-keys `--out-dir` 可指向仓库内路径，私钥不受 .gitignore 保护

- **位置**：`scripts/board-keys.mjs:33`（`--out-dir` 缺省 `~/.dsh/keys`，可任指）；`.gitignore:16-19`（只覆盖 `.dsh/keys/` 与 revoked-keys 变体）
- **事实**：`gen --out-dir .` 会在仓库内落 `<name>.key`，.gitignore 无对应模式，`git add -A` 即可误提交私钥。工具本身行为正确（0600、不覆盖已存在、--name 拒路径分隔符）。
- **攻击场景一句话**：操作者在仓库根误跑 `--out-dir .` 后整目录提交，私钥入库。
- **建议**：gen 时检测 outDir 位于 git 仓库内即 stderr 告警（或拒绝，需 `--force`）。

### 低-4：ThreadingHTTPServer 无并发上限 + 缺省阻塞轮询的资源消耗（认证后）

- **位置**：`skills/expert-orchestration/tools/a2a_taskboard.py:52,322-333`（阻塞轮询缺省 300s、0.5s 间隔 spawn 子进程）
- **事实**：每连接一线程、无上限；持合法 token 者可并发开大量 message/send，每个占线程 300s 并以 0.5s 周期 spawn `taskboard.py` 子进程（子进程有 board flock 串行化，不破坏数据，但进程/线程数量无界）。缓解：bearer 恒开、绑定缺省回环、体上限 1MB。
- **攻击场景一句话**：拿到 token 的恶意客户端用几百条并发 message/send 耗尽线程与进程表。
- **建议**（可选）：并发信号量上限 + 每 token 请请速率上限；MVP 阶段记录为已知边界即可。

---

## 核对通过清单（如实声明核对 / 独立探针实证）

### 密码学正确性与健壮性（_ed25519.py + 签名集成）

| 项 | 结论 | 证据 |
|---|---|---|
| RFC 8032 正确性 | ✓ | 独立探针：TEST 1（sk=9d61b19d…）pk/sig 逐字节==向量；node:crypto（OpenSSL 独立实现）双向互签互验、python 签==node 签逐字节。`test/board-signing.selftest.mjs:54-84` 已入同锚点（RFC TEST 1 + L·B==单位元群阶自检） |
| 随机源 | ✓ | `_ed25519.py` 无随机数生成（sign/verify 本不需要）；密钥生成在 node 侧 `generateKeyPairSync('ed25519')`（CSPRNG） |
| 签名 malleability | ✓ | `checkvalid()`（_ed25519.py:142-157）`s >= L` 返回 False（canonical S）；探针实证 S=L、S=L+1 均拒 |
| 恶意输入健壮性 | ✓ | 非 32 字节 pk / 64 字节 sig / 非曲线点 raise ValueError；R 位翻转、16 字节 sig、损坏 pubkey 文件均被调用方（`_sig_audit_events` taskboard.py:513-546、verify-board.mjs:101）try/except 捕获计 invalid，不静默、不崩进程 |
| sigkey 进 hash 链 | ✓ | `sig` 不进 hash、`sigkey` 进（taskboard.py:417 注释+实现）——换钥冒名即断链（unrecoverable） |
| 密钥缺失降级 fail-visible | ✓ | 未配置=不签名（板面逐字节不变，additive 契约）；配置非法=stderr 警告「本命令不签名」+ 不阻断（`_sign_seed` taskboard.py:441-459） |
| 验签标记不静默 | ✓ | invalid/revoked/unknown_key → stderr 汇总 + `replay --json` data.sig_audit（taskboard.py:428-429、513-546）；吊销判定优先于公钥面（:537-539） |
| 吊销语义 | ✓ | 板根 `revoked-keys`（每行 base64 公钥全文）；空/缺失=空吊销集，**显式不学 SSH 的停用全体语义**——与报告 §4.3 声明逐字相符 |
| 公钥面损坏文件 | ✓ | 非法 b64/非 32 字节逐文件跳过+stderr 告警（`_pubkey_face` taskboard.py:465-487），不静默当空 |

### A2A 最小 HTTP 服务端（a2a_taskboard.py）

| 项 | 结论 | 证据 |
|---|---|---|
| 绑定缺省回环 | ✓ | `--host` 缺省 127.0.0.1（:480）；卡面 `dsh:bindHost` 如实回显非回环绑定为 127.0.0.1 口径（:529） |
| 鉴权恒开 | ✓ | bearer 恒要求，`hmac.compare_digest` 常时时间比较（:439）；token 来源链 --token > env DSH_TOKEN > 启动生成 `a2a-<32hex>`（secrets，仅生成态 stderr 横幅）；401 带 WWW-Authenticate |
| Origin MUST | ✓ | 带 Origin 不在白名单一律 403，**缺省空名单=全拒**（:412-415），MCP transports MUST 条款落地 |
| DNS rebinding 纵深 | ✓ | Host 头必须 ∈ loopback 集（:378,404-410），GET 无 Origin 时的兜底；双保险与浏览器行为相符 |
| HTTP 解析健壮性 | ✓ | 体上限 1_000_000 字节（:82）；401/403 早退不读体+`Connection: close`（残体毒化连接复用已修）；JSON-RPC 层未知方法/非法 id/通知丢弃均有具名处理；BaseHTTPRequestHandler 自带 64KB 头行上限 |
| 命令注入 | ✓ | `run_taskboard(argv)` argv 列表、无 shell（经 mcp_taskboard.py subprocess，timeout=30s） |
| 参数注入 | △ | 见发现 中-2（当前被 argparse 拒绝，无 `--` 防护缺口） |
| 错误回显 | △ | 见发现 低-1（bearer 后、JSON 无反射） |
| 写面纪律 | ✓ | `DSH_TASKBOARD_A2A_WRITES=1` opt-in，缺省具名拒 `writes_disabled`（:263-267）；卡面 `dsh:writeFace` 如实声明 |
| 信任边界不超声明 | ✓ | 外部写入=代理转达自报口径（metadata `dsh:owner/dsh:scope` 显式才透传，:285-294）；不新增执法；`/.well-known/agent-card.json` 公开元数据不设防（声明相符）；taskId 续话具名拒（MVP 不做）、非 text part 具名拒（宁拒勿猜） |
| 并发 | △ | 见发现 低-4 |

### N2 审计回显（mcp_taskboard.py）

| 项 | 结论 | 证据 |
|---|---|---|
| 回显不泄敏 | ✓ | 【审计】行只含 task/status/owner/by/event_seq/revision，全部自报口径；不含 token/capability/attempt 值 |
| 对账锚点 | ✓ | event_seq 落信封顶层与事件流同源；拒绝面（isError）不附审计行（零写零事件） |
| 无 shell | ✓ | subprocess argv 列表 + timeout=30s |

### 密钥工具与板外验证器（board-keys.mjs / verify-board.mjs）

| 项 | 结论 | 证据 |
|---|---|---|
| 私钥落盘 | ✓ | 0600（writeFileSync mode + chmod 兜底，board-keys.mjs:43-45）；已存在不覆盖（:36，never destroy） |
| 私钥不入 git | ✓（缺角） | .gitignore:16-19 覆盖 `.dsh/keys/`（缺省 out-dir）与 revoked-keys 三变体；`--out-dir` 仓库内路径缺口见 低-3。diff 全量核对无 .key/secret/token 类文件 |
| 验签器防绕过 | ✓ | seq 连续 + prev_hash 串联 + hash 逐条复算 = 防选择性删除/重排/篡改；OpenSSL 独立实现与 python vendored 双锚；吊销比对；unknown_key/revoked/invalid → exit 1 |
| canonical 复刻边界 | ✓ | 键 ASCII / 数值安全整数域前提在文件头如实声明 |
| 卡面无明文密钥 | ✓ | gen-agent-card.mjs：securitySchemes bearer + description「凭证带外分发、卡面不承载明文密钥」；url 缺省空占位（不宣称端点） |

### 威胁模型 T1–T5 对照（docs/research/exposure-crypto-trust §2）

| 威胁 | 实现对照 | 结论 |
|---|---|---|
| T1 伪造署名 | M3 事件签名 + 板外验证器（opt-in）：签名归因「密钥持有者」，hash 链覆盖 sigkey 落款 | ✓ 相符（不证明内容为真、不做执法——如实声明） |
| T2 token 窃取 | 本批不涉及（远期轮）；A2A bearer 为带外分发口径 | ✓ 未越界 |
| T3 外部写无认证边界 | 写面仍 env 开关 opt-in + 自报口径，与「不新增执法」声明逐字相符 | ✓ 相符 |
| T4 发现面注入 | 卡面 skill 描述纯展示字段，无执行语义；securitySchemes 先于端点（N1） | ✓ 相符 |
| T5 洗批准 | 显式不做：签名不签批准语义、不买活体/人（§4.5 清单如实落地） | ✓ 相符（非缺陷，声明边界） |

## 探针实证记录（脚本均在 /tmp/secprobe，未写仓库）

1. RFC 8032 §7.1 TEST 1 全向量（pk、sig 逐字节）+ node/OpenSSL 双向互签互验 — 通过。
2. Malleability/健壮性矩阵（S=L、S=L+1、零公钥、16 字节 sig、R 位翻转）— 全部拒绝且不崩调用方。
3. 参数注入探针：`taskboard.py create --owner=evil`（缺 title）→ usage error；`create -- -normal-title` → 正常创建（证明 `--` 分隔符方案可行且无兼容性损失）。
4. diff 卫生：无 .key/secret/token 类文件；worktree git status 干净。
5. 注：TEST 2 向量探针首轮因手抄 hex 错误失败，改用 node 互验（更强锚点）替代——双实现互验是本审计采用的正确性主证据。

## 与另一位代码审查员的分工边界

正确性回归、测试复跑、契约/文档一致性归 REVIEW-ef3b962.md 的作者；本报告只覆盖安全面，未重复其范围。主仓根 REVIEW-f533f96.md 属既往评审，非本审计产出。
