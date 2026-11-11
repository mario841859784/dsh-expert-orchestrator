# 评审报告：dev/orchestration-economics-345（worktree 分支 review-oeconomics-345）

- 评审人：code-reviewer（只读评审，未改动任何代码文件；本报告为唯一落盘产物）
- 日期：2026-11-12
- 范围：`git diff main...review-oeconomics-345`，5 提交（68199fe → c2ddb31 → 43b9d20 → 7a4e88b → 9394a05），24 文件 +3019/-44
- 核实手段：逐文件 diff 审读 + 全量测试实跑（`node --test` 5 个自测文件：31 tests / 30 pass / 0 fail / 1 skip——skip 为已声明的 deployed-roster 弱覆盖分支）+ 关键代码点复核（git 工作树 clean，无其他会话未提交改动）

## 总结论：**同意（可合入）**

四方向实现与文档（SKILL.md/CHANGELOG）一致，测试有效性显著高于平均水平（多处采用「与基线提交双跑差分比对」证明缺省零变化），零依赖约束守住（package.json 无 diff，MCP 导出为纯 python3 stdio，A2A 卡生成仅用 node 内置）。**阻断项 0、重要项 0**，以下 minor 项不阻碍合入，可后续处理。

## 必改项

### blocker（合入前必须修）：无

### major（应修）：无

### minor（可后续）

1. **scripts/gen-agent-card.mjs:9** — 头注用法写了 `--skill-dir <dir>`，实现并无该参数（SKILL.md:310 的对外文档未提此参数，仅脚本头注误导）。建议：删掉头注中该参数，或实现它。测试注释也自认「生成器无该参数」。
2. **scripts/gen-agent-card.mjs（version 字段）** — card.version 硬编码 `'2.13.10'`，与 package.json 当前版本一致，但分支未 bump 版本；下次发版若忘同步会静默漂移。建议：从 package.json 读版本（node 内置 `readFileSync`，不违反零依赖），或至少在发版清单里记一条。
3. **skills/expert-orchestration/tools/taskboard.py（cmd_approve/cmd_reject --by）** — `by` 任意字符串无长度上限，原样嵌入 checkpoints 注记与人读 stdout；理论上可膨胀板文件。CLI 无鉴权口径已在文档如实声明，属接受面；建议仅加一个截断（如 200 字符）即可。
4. **test/protocol-export.selftest.mjs（用例 ⑤ deployed-roster 分支）** — merged roster 存在时的 list_experts 分支在纯仓库 CI 形态被 skip（测试内自己 `return` 跳过），该分支实际未被 CI 断言。建议：测试内临时构造一个最小 merged roster fixture 再跑一轮，使两分支都有真断言。
5. **test/orchestration-economics.selftest.mjs（成本真链路）** — cost.batchSummary 提示行只断言含「会话累计」，未断言 used/budget 具体数字；en 语景的 cost.budgetExceeded 只在纯函数层测过、真链路未测。均不碍正确性，补断言更稳。

## 逐文件评审意见

### lib/cost.js（新，+102）
- 正确。`tokenBudgetTokens`：未设/''/'0'→null 关闭，`n*1000` 千 token 口径、支持小数（'0.5'→500000），非法→null+stderr 告警，边界完整。
- `estimateTokens` 按 code point 遍历（`for (const ch of text)`，代理对 emoji 计 1 个 other），CJK 三区 ×0.75、其余 ×0.25，Math.ceil——估算口径在头注与 CHANGELOG 均如实声明。已知边界：不含 CJK 扩展 B+（0x20000+）、假名/韩文按 0.25 计——已声明为估算，可接受。
- `createCostLedger` 封顶 500 条丢最旧，不存正文只存字符数/估算值，隐私面干净；`totals()` 仅反映封顶窗口内，语义与提示文案一致。
- 值得肯定：头注明确写出真实 usage 的未来接入点（runExpertOneShot/runExpertContinuable 消费缝），不虚报精度。

### lib/fail-loop.js（新，+58）
- 正确。阈值 env 须整数≥2 否则默认 3；开关 '0'/'' 关闭、默认开；达阈后**每次**失败都告警（不只在第 N 次），符合「提醒不静音」语义。
- streak Map 按专家名增长、无封顶——名字集合有界（花名册），无内存风险。进程内存态、跨进程不聚合，已如实声明。

### lib/expert-profiles.js（+67）
- `ROUTE_PREFS` freeze；`resolveRoutePref` trim+lowercase 归一、非法→null+告警。
- 读容错/写严格不对称是有意设计：读侧丢弃非法 modelByPref 档位并告警，写侧 `validateExpertProfileDocument` 对声明但未存活的档位显式拒绝——合理且测试覆盖。
- `resolveExpertModel` 第 5 参 opts={pref}：档值优先于 defaults.model、per-expert/组层显式 model 压过偏好、无效 pref 静默回落——优先级链自洽，五层断言齐全。
- 建议（非必改）：`resolveRoutePref` 在 runExpert 内逐次调用重复解析 env，可提到 register 时缓存一次；无害的轻微冗余。

### lib/messages.js（+21）
- 新 key（cost.budgetExceeded / cost.batchSummary / econ.writeFanoutAdvisory / failloop.summon）zh/en 各一套，测试含「全量 key 收口」断言，无漏译。

### lib/tools.js（+93）
- 接线正确：costLedger 恒开（无开关面）；summonFailLoop 开关在 register 时读 env（新注册实例才生效——测试已验证该动态性）。
- render 侧写型分流建议用 `Array.isArray(args?.experts)` 守卫（tools.js:2142），无 undefined 崩溃面；建议仅 render 文本不阻断 execute，与声明一致。
- stagger 实现：首项完整串行（含 summonLoopHint/costLedger 记账）后其余按既有并发池跑，结果序保持声明序；失败路径 runOne catch 返回不 throw，首项失败不会中断余项（测试覆盖派发序但未显式组合「首项失败+stagger」——行为从代码看正确，属可选补测）。
- 失败 streak 记在 query 名（list[0]），成功时 query 名+解析名两键都清——解析名与 query 名 streak 可能短暂不一致，但已尽量闭合，且解析失败时 query 名键正是唯一可用键。语义可接受。

### skills/expert-orchestration/tools/taskboard.py（+92）
- approve/reject --by：空白归一、缺省与基线提交双跑逐键一致（事件 args 形状 {}），审计注记明确写入「板面自报审计面」「批准者≠草案创建代理本人」「代理转达的批准不可信」——身份可伪造性的口径如实，未夸大保证。
- fail_streak 语义：跨 retry 累计（同一任务）、成功 done/retry 清零、不同任务互不影响——语义自洽且测试逐条验证。
- 执法开关 fail-open 设计：`DSH_EXPERT_FAILLOOP_ENFORCE` 缺省不执法（不读 env 不落字段，缺省形状与基线逐字节一致）；`_failloop_limit` 非法值告警+禁用执法而非崩溃——方向正确。
- escalated 分支行为与 failed 分支等价再加升级字段/事件，无遗漏路径；checkpoint 时间戳本地时区与既有口径一致。
- `int(t.get('fail_streak') or 0)` 与既有 `repair_count`（:1675）/`vote_round`（:2042）同口径，板文件损坏时同风险，非本分支新增问题。

### skills/expert-orchestration/tools/mcp_taskboard.py（新，+330）
- 安全面：**读面 7 工具默认开放、写面 5 工具默认拒**（`DSH_TASKBOARD_MCP_WRITES=1` 才入列+放行，缺省具名拒返回 isError 文本含开关名）——最小暴露面正确；不导出 approve/retry/recover（升级唯一出口=用户显式 retry），符合单向导出边界声明。
- -32601：未知 method 且 id 非 None → -32601，notifications/* 零回包；tools/call 的 name 非 str → -32602，未知工具名 → 结果内 `unknown_tool` isError 文本（MCP 推荐做法）；非法 JSON 行丢弃不崩溃。均正确且有测试。
- `run_taskboard` subprocess timeout=30 → code=124 错误文本；CLI 非 0 → `taskboard_exit_{code}` 带 receipt/stderr；--board 透传（DSH_TASKBOARD_MCP_BOARD）有真写验证。
- 小不一致（已在注释声明）：status 读工具用纯 `status` 无 --json，靠 parse_receipt 人读回退；其余读工具统一 --json。行为正确，风格不一致，可后续统一。

### scripts/gen-agent-card.mjs（新，+92）
- roster 解析三层兜底（experts 数组/裸数组/损坏 catch→bundled frontmatter 扫描），skills 过滤 disabled/shadowed，`dsh:rosterSource` 如实标注来源——不虚报 merged。
- url 缺省空串 + 头注声明「A2A HTTP transport 未部署、卡只描述能力不宣称端点」——如实。
- 见 minor #1/#2（--skill-dir 幽灵参数、version 硬编码）。

### skills/expert-orchestration/SKILL.md（+28）与 CHANGELOG.md（+41）
- §1 派工规模四档、§2 批准人四条不可信中继语义、§3 分流/偏好/stagger/循环检测、§5 预算行、§9 新增 4 个 env 速查行 + MCP/A2A 导出面段——逐条与实现核对一致（工具数 7+5、开关名、fail-open、唯一出口、估算口径声明均无出入）。
- CHANGELOG 未发布节四方向条目与实现一致。

### test/mutation-gate.selftest.mjs（±42）
- 仅 REGISTRY 行号随 taskboard.py 插入同步偏移，anchor 文本未变；测试实跑通过。

### 测试有效性总评（5 个自测文件）
- 强项：多处「与基线提交（git show c2ddb31 / 43b9d20）双跑差分比对」证明缺省零变化——这类断言能抓住回归面而非只测happy path；fail-loop 跨 retry 累计/清零/新任务隔离、MCP 写面缺省拒+开启全链真写+板文件落盘验证，均为真断言。
- 漏测面均为 minor（见必改项 #4/#5 与 stagger+首项失败组合）。

## 疑问（不阻碍合入）
1. card.version '2.13.10' 是「随当前版本手写」还是刻意固定？若前者建议改为读 package.json（见 minor #2）。
2. SKILL.md §1「复杂 ≤8 名」与既有 SUMMON_CONCURRENCY=4 并发上限并存——语义是「声明上限 8、并发 4」，两处文档表述一致，确认这是预期口径而非笔误。

## 值得肯定
- 每个新开关都做到「缺省零变化」并有基线差分测试证明，回归风险极低。
- MCP 写面默认关闭+具名拒文本带开关指引，错误信息可直接行动。
- 估算/自报/兜底三类「能力边界」全部在头注与文档如实声明（token 估算是估算、--by 是自报、rosterSource 标来源），没有一处夸大保证。
- 零依赖约束严格守住：MCP server 纯 python3、AgentCard 生成仅 node 内置、package.json 无任何 diff。

---
*本报告由 code-reviewer 生成于只读评审；除本文件外未做任何写操作。*
