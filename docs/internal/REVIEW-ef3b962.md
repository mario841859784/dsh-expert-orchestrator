# REVIEW-ef3b962.md — 独立评审报告（合入 main 前置门禁）

- **评审对象**：dsh-expert-orchestrator 分支 `dev/exposure-crypto-345`，HEAD=`ef3b962`（专用 worktree `review-exposure-crypto-345` 检出为分支 `review-exposure-crypto-345`），diff 基线 `822ff80..ef3b962`，两提交（1be57fa / ef3b962），25 文件 +2423/-70。
- **评审者**：reviewer-ef3b962（独立评审者，与实现者无关；只读评审，未改动任何被评审源码/文档；全部探针落在 /tmp）。
- **对照基准**：docs/research/exposure-crypto-trust/00-exposure-crypto-trust.md §5 路线表（N1/N2/M1/M3/⑤ 五项）与 §4.5「签名买不到的东西」边界；前序报告 REVIEW-f533f96.md（格式参照）。
- **日期**：2026-11-13

---

## 一、总结论

**同意（合入放行，附 1 项必改：测试基建竞态修复；不涉产品代码语义缺陷）。**

五项路线表（N1 卡面安全声明、N2 写面审计回显、M1 A2A 最小 HTTP、M3 Ed25519 签名+板外验证器、⑤ 路由遥测回填）全部按报告 §5 前置与不做边界如实落地；M3 密码学实现经独立跨实现互验（node:crypto/OpenSSL vs vendored python）全绿；npm test 632 项 0 fail；mutation gate 复跑 662 项，唯一 fail 为 a2a 启动面用例的负载型竞态（根因已定位到测试 helper 与服务端横幅打印顺序，与签名/密码学面无关），单独复跑 5/5 稳定通过。

> 备案（红线要求）：主仓根发现非本任务产生的未跟踪文件 `REVIEW-ef3b962-security.md`（本次评审未创建、未改动；疑为并行评审产出，请编排者裁决归属）。

---

## 二、分项发现表

| # | 评审项 | 结论 | 依据（文件:行号 / 实测） |
|---|--------|------|--------------------------|
| 1 | taskboard.py 签名集成正确性与 v2.13 兼容性 | **通过** | 签名覆盖 canonical(事件去 hash/sig)，`_event_hash` 排除 `('hash','sig')` 两键（taskboard.py:416-419）防自指；`sigkey`（公钥指纹 sha256[:16]）在 hash 输入内——换钥冒名即断链；`BOOKKEEPING_KEYS=('event_seq','event_state_hash')`（:395）从状态 hash 排除，commit_event 内存簿记回写（:851-852）与 hash 口径一致；`_WRITE_CMDS`（:769-771）全部写命令信封附 event_seq 对账锚点；验签点 `_sig_audit_events` 判定顺序 revoked→unknown_key→verify（与 verify-board.mjs 一致），invalid/revoked/unknown_key stderr 汇总不静默、非 unrecoverable（签名不做执法，报告 §5.7 口径）；无签名配置时事件 JSON 逐字节不变（additive）。既有行为无破坏：npm test 632 项全量回归 0 fail（含 v2.13 事件溯源/CAS/hook 三查/回执契约全族）。 |
| 2 | scripts/verify-board.mjs 板外验证器 | **通过（附建议 2 条）** | 独立进程只持公钥验整板，符合报告 §5.10 验收。**实测失败模式**（/tmp 探针，签名板 2 事件）：篡改内容→hash=broken+sig=invalid，exit 1；空公钥目录→unknown_key，exit 1；公钥入吊销文件→revoked，exit 1；退出码逻辑 verify-board.mjs:142（ok?0:1）。两处边界实测确认：①剥除 sig 计 `unsigned=2` 且「全部通过」（:101 `'sig' in ev` 缺失即 unsigned——sig 不在 hash 输入，属报告「模式混合是常态」已声明设计，建议文档明示）；②尾部截断（2 事件→1 事件、board.json 不动）→全部通过——**板外验证器不做视图对账**（python load 路径有 event_seq>末 seq 的 unrecoverable 防御，verify-board 未复刻，见建议项）。 |
| 3 | scripts/board-keys.mjs 密钥约定一致性 | **通过** | gen 产 `<name>.key`（32B seed base64、0600）+ `<name>.pub`；指纹=sha256(pub)[:16] hex 与 taskboard.py `_key_fingerprint` 逐字节一致；不覆盖已有私钥；pubkey 子命令 PKCS#8 DER 包 seed。与 python 侧路径/格式约定一致；探针实测 gen→签名→验签全链互通。 |
| 4 | lib/route-telemetry.js ⑤ 回填实测性与隐私面 | **通过** | **回填数据确为实测产出非硬编造**：stopReason 取宿主 settle 真实离散值（runExpertOneShot/Continuable 返回值 additive 增键）；durationMs=Date.now()-summonT0 实测；estTokens=estimateTokens 启发式且如实标注估算（usage=null 占位=宿主结算 seam 未接入，与 lib/cost.js 头注同缝）。样本仅存规模与离散字段（expert/model/pref/ok/stopReason/taskChars/answerChars/estTokens/durationMs/ts），**不含任务书/回包正文**，隐私面干净；summon answer 逐字节不变；默认开启（kill switch `DSH_EXPERT_ROUTE_TELEMETRY='0'/''`）；8MB 软顶停写不删；I/O 异常 fail-open。性能：每 summon 一次 appendFileSync，可忽略。routing-metrics.mjs 只读聚合（okRate/tokPerChar 反推比/时长分位/stopReason 分布），无写面。 |
| 5 | a2a_taskboard.py（M1）正确性与导出边界 | **通过** | 鉴权先于暴露：Origin 带头必命中白名单（缺省空=全拒）、Host 头 rebinding 纵深校验、bearer 恒开（hmac.compare_digest 常时比较；token 启动生成 a2a-<32hex>，**仅生成态回显 stderr，显式提供不回显**）；401/403 早退不读体+Connection: close。写面 `DSH_TASKBOARD_A2A_WRITES` opt-in（缺省具名拒 writes_disabled，:265-266）——bool 非空即开语义与既有 `DSH_TASKBOARD_MCP_WRITES` 约定逐字一致（mcp_taskboard.py:114），属约定延续非新引入（`=0` 会开启，见建议项）。metadata 仅 dsh:owner/dsh:scope 显式透传；JSON-RPC 通知（id=null）202 丢弃不执行（无副作用）；状态映射 escalated→input-required 如实；超时返回非终态不虚构。**单向导出边界保持**：无 summon/编排工具入口，message/send 只落板 create。 |
| 6 | gen-agent-card.mjs（N1）卡面如实性 | **通过** | securitySchemes bearer（description 如实「凭证带外分发、卡面不承载明文密钥」）+ security `[{bearer:[]}]` + preferredTransport='JSONRPC' + dsh:writeFace；url 维持空占位（宣称端点须 --url）；服务端卡（a2a_taskboard.py build_card）capabilities streaming/push 照实 false。无未部署端点/能力宣称。 |
| 7 | N2 审计回显 + watchdog 信封收口 | **通过** | mcp_taskboard 写工具成功响应尾行【审计】task/status/owner/by/event_seq/revision（data.task 缺失返回 None 不阻断；拒绝面不附）——回显仅含对账字段，**无凭据/敏感值**。watchdog 三线收口与 SKILL.md §3 规范逐字相符：nudge=【升级｜时间窗｜告警】+「本提示不阻断。」尾行；adopt/reclaim=【升级｜时间窗｜执行】无尾行；检查点轨迹/telemetry 行维持 v2.7 字面（数据面非升级提示行，边界如实）。 |
| 8 | SKILL.md / CHANGELOG 文档一致性 | **通过** | §3 五通道（增时间窗）与 watchdog 收口句、§9 签名段（SIGN_KEY/PUBKEY_DIR/revoked-keys 三开关）、MCP/A2A 导出面三条、路由遥测与信任面工具三行——逐条与实现核对相符；诚实边界声明（签名不证明内容为真/不做执法、剥 sig=unsigned 等）与代码一致；无夸大、无死语法。CHANGELOG 测试对账数字（基线 621/618+9、⑤③批 632/629+11、gate 651→662/29 变异）与复跑实测基本吻合（差异见第四节注记）。 |
| 9 | 测试充分性与复跑 | **通过（附必改 1）** | 见第四节实测数字。三个新 selftest 覆盖面核对：board-signing（RFC 8032 §7.1 TEST 1 向量+群阶自检+双实现互签互验+篡改/吊销/unknown_key/链篡改执法归属+verify-board 全链）；route-telemetry（enabled 矩阵/字段形状/软顶/fail-open/kill switch/summon 真断言+输出零变化）；a2a-server（卡形状/鉴权三件/JSON-RPC 层/写链/阻塞语义/启动面）。变异抽查方式说明：评审红线禁止改动被评审源码，故未自注入变异；以 mutation gate 框架复跑（REGISTRY 29 点，taskboard.py/bus.py 门禁逻辑，test/mutation-gate.selftest.mjs:24-25 确认不含 a2a 面）作实证。 |
| 10 | 全仓旧字面/死代码残留 | **通过** | 无 TODO/FIXME/XXX/HACK 残留（新文件 grep 零命中）；「四通道」仅存于历史 CHANGELOG 条目（历史记录正确保留，现行 SKILL.md §3 已统一五通道）；`__pycache__` 未跟踪且 .gitignore:29 已覆盖；worktree git status 干净。 |

### Ed25519 密码学独立验证（补充第 1/2 项）

跨实现互验（评审者独立构造，node:crypto/OpenSSL vs vendored `_ed25519.py`，/tmp 探针）：

- 公钥派生一致：`py_pk == node_pk`（同 seed）；
- 互签互验双向：python 验 node 签 = True，node 验 python 签 = True；
- 篡改 sig 第 10 字节：py 侧 raise ValueError（非曲线 R 点）、node 侧 false——两侧调用点（taskboard.py `_sig_audit_events`、verify-board.mjs）均已 try/except 收敛为失败；
- S==L（群阶模值）拒绝：checkvalid 返回 False；
- L 常量 = 2^252 + 27742317777372353535851937790883648493 逐位正确；
- clamp 位（3..253 + 2^254）、r/k/S mod L 与 RFC 8032 纯 python 标准形态一致。

结论：vendored 实现密码学正确性独立验证通过；`checkvalid` 对非曲线点/长度不符是 raise 而非 return False，契约上依赖调用方 catch（两处调用方均已 catch）——建议级注记（docstring 宜注明「调用方必须 catch」）。

---

## 三、必改项

1. **（测试基建，一行级；不涉产品语义）a2a 启动面用例竞态**：`test/a2a-server.selftest.mjs:70` 的 startServer 在 stderr 首个含 `A2A_LISTEN` 的 chunk 即 resolve 并定格 stderr，而服务端 `a2a_taskboard.py:546` 先打 `A2A_LISTEN`、`:549` 才打 `A2A_TOKEN`——负载下（mutation gate 全量跑批）两次 print 之间被调度切开时，resolve 时 stderr 缺 token 行，`:301` 断言必炸。实测：mutation gate 全量复跑 1/1 次触发（662/660 pass/1 fail/1 skipped，188s）；该用例单独复跑 5/5 通过（负载消失即不复现）。修复任选其一：①服务端把 `A2A_TOKEN`（凭证）移到 `A2A_LISTEN`（暴露点）之前打印——顺带改善「凭证先于暴露」叙事；②helper 等 `A2A_TOKEN|A2A_TOKEN 来源` 行到齐再 resolve。**不改此竞态，mutation gate 作为门禁会间歇性假红。**

除上述 1 项外无必改项。

## 四、测试复跑实测数字

| 跑批 | 命令 | 结果 |
|------|------|------|
| 全量测试 | `npm test` | **632 tests / 630 pass / 0 fail / 2 skipped**（182.6s；CHANGELOG 记 629 pass/3 skipped——差 1 为环境相关跳过条件，无回归） |
| Mutation gate ① | `DSH_EXPERT_MUTANTS=1 npm test` | 662 tests / 660 pass / **1 fail** / 1 skipped（187.8s）——fail 即第三节必改项（a2a 启动面竞态），非签名/密码学面缺陷；CHANGELOG 记 662/660/0 fail/2 skipped，pass 数逐位吻合 |
| Mutation gate ②（复现性） | 同上（后台复跑） | **662 tests / 661 pass / 0 fail / 1 skipped**（185.7s）——同一跑批两次结果不同（①660 pass+1 fail / ②661 pass+0 fail），间歇性竞态实锤；实现者环境记 0 fail 与②一致 |
| a2a-server selftest 隔离复跑 ×5 | `DSH_EXPERT_MUTANTS=1 node --test test/a2a-server.selftest.mjs` | 5/5 全过（8 pass/0 fail）——证实竞态为负载型 |
| Ed25519 跨实现互验 | 评审者独立探针（node:crypto + python3） | 全绿（见第二节补充） |
| verify-board 失败模式探针 | 签名板 2 事件 + 5 类篡改 | 篡改/空钥/吊销→exit 1；剥 sig→unsigned（过）；尾部截断→过（见第 2 项） |

**基线对照**：f533f96 时点 612 项全过 → 本轮 632 项全过（+20：a2a-server 8 + route-telemetry 6 + board-signing 5 + receipt P2b 1），零回归。

## 五、建议项（不阻塞合入）

1. **verify-board 补视图对账**：尾部截断（事件流被删尾、board.json 不动）当前板外验证器全过（python load 路径有 event_seq>末 seq 防御，verify-board.mjs 未复刻）——建议加 board_seq/revision 与事件流末 seq 的一致性比对（verify-board.mjs:142 附近），一行级补强即可闭合。
2. **剥 sig=unsigned 边界文档明示**：verify-board.mjs:13 已有注释、CHANGELOG 有「无签名事件如实计 unsigned」，但「攻击者剥 sig 后板外验证器不判异常（只能靠 unsigned 计数对比基线察觉）」未在 SKILL.md §9 明示——建议补一句，防运维误读「全部通过」为「未被篡改」。
3. **验签性能注记**：`_sig_audit_events` 在每条 repair=True 读路径全量重跑（纯 python ~30ms/条，无缓存）——事件量大时写命令延迟线性增长；报告「事件量小」口径下可接受，建议 SKILL.md 注记或后续加验签结果缓存（以 hash 为键）。
4. **写面开关语义收紧（跨文件一致改）**：`DSH_TASKBOARD_MCP_WRITES`/`DSH_TASKBOARD_A2A_WRITES` 为 bool 非空即开（mcp_taskboard.py:114、a2a_taskboard.py 同款），`X=0` 会**开启**写面——属既有约定延续，建议未来统一收紧为显式 `'1'`（与 DSH_EXPERT_* 家族 '0'/'1' 语义对齐）。
5. **a2a 阻塞轮询开销**：每 0.5s spawn 一次 `taskboard show` 子进程，300s 上限=单请求最多 600 次 spawn——MVP 可接受，建议后续改事件文件 mtime 长轮询或常驻读面。
6. **canonical 值域声明补全**：verify-board 复刻 python `_canonical` 的键 ASCII/安全数值域前提已声明，字符串值的 U+2028/2029 转义差异为未声明理论边角——建议在 verify-board.mjs 头注补值域前提。
7. **checkvalid 契约注记**：`_ed25519.py` checkvalid 对非曲线点/长度不符 raise 而非 return False——调用方均已 catch，docstring 宜注明「调用方必须 catch」防未来新调用点踩坑。

## 六、备案

- 评审全程只读：worktree 探针前后 `git status` 干净（porcelain 空）；所有篡改探针/密钥/脚本均落 /tmp，已随会话清理语义（/tmp 临时区，不入仓）。
- 主仓根未跟踪文件 `REVIEW-ef3b962-security.md` 非本评审产出，未读未改（红线：发现他人改动立即上报）。
- mutation gate 变异范围经核实为 taskboard.py/bus.py 门禁逻辑 29 点（test/mutation-gate.selftest.mjs:24-25），不含本轮新增 a2a/签名文件——新面的钉住力由三个 selftest 的真断言覆盖（卡片形状/鉴权/验签失败模式均直接断言），建议后续轮把 M3 签名判定面（revoked→unknown_key→verify 顺序）纳入 REGISTRY。

---

*评审者：reviewer-ef3b962（独立评审，未参与实现）· 2026-11-13*
