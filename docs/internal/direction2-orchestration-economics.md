# 开发方向 2 实施设计：编排经济学（orchestration-economics）

> 依据：`docs/research/orchestration-economics/00-overview.md` §4 统一落地清单（12 条，按杠杆排序）。
> 分支：`dev/orchestration-economics-345`。设计日期：2026-11-12。
> 原则：每条落地要么「库内可测实现」、要么「协议文本纪律」、要么「如实声明当前 seam 不可达」——三者必居其一，不做第四种（不写没有 seam 支撑的伪实现）。

## 0. seam 现状（实施前勘察结论）

- **无真实 usage 缝**：宿主结算观察面（`createSettlementWatcher`，lib/tools.js:1084-1135）产出 `{stopReason, output, lastAssistantMessage}`，不含 token/缓存命中数据；`run.result` 亦无 usage 字段。→ 02-D5 的「回传 prompt_cache_hit/miss_tokens」在当前宿主 seam **不可真实采集**。
- **缓存组版已就位**：SKILL.md §5 固定段在前/变量段在后协议 + lib 侧任务书组装变量尾部追加（经验提示 tools.js:423-426、origin-chain 末行 tools.js:1883-1884），无时间戳/任务 id 类变化字段进前缀（插件侧从不注入，任务 id 仅解析不回写）。
- **模型路由静态雏形**：expert-profiles.js 逐专家 > 领域组 > defaults 链已有（2.13.5/2.13.8），缺「按任务难度/偏好选档」轴。
- **规模纪律空白**：SKILL.md §1 分诊三级管「要不要派工」，无「派多少专家、各多少预算」的 effort 分级（02-D3 / 03-启示 5 要求硬编码）。
- **读型/写型分流空白**：summon 有 `readOnly` 参数（写锁竞争面），但无「写型禁止并行扇出」的派工第一判断（03-启示 1）。
- **批量无预热**：summon_experts ≤8 并发 4 直发（tools.js:2106-2114），无 1 write + N read stagger（02-D4）。

## 1. 落地映射表（清单 12 条 → 实施决策）

| # | 清单条目 | 决策 | 落点 |
|---|---|---|---|
| 1 | 任务书缓存组版 ★★★ | **已在位，勘验留痕不重复实现**（§0 第 2 条） | SKILL.md §5 + lib/tools.js 既有 |
| 2 | 读型/写型分流 ★★★ | **双面落地**：协议纪律 + 工具输出建议行（≥2 写型条目批召时附【分流建议】，非阻断） | SKILL.md §3 + tools.js summon_experts render |
| 3 | effort 分级预算 ★★★ | **协议硬编码**：派工规模纪律四档（琐碎禁派子代理 / 简单 1 专家 / 中等 2–4 / 复杂 ≤8）+ 任务书「预算」变量行（调用/token 预算下发，TALE 思路） | SKILL.md §1 + §5 模板 |
| 4 | 难度子任务级+在线校准 ★★☆ | **部分落地**：难度轴=分诊三级在子任务上的复用（每子任务定档再派工）；在线校准复用既有 metrics 回写（rework/switched→routing.md）+ 本方向成本记账提供累计面；难度估计器（LLM 自评/分类器）**如实声明无 seam，不做** | SKILL.md §1/§8 + lib/cost.js |
| 5 | 三档偏好路由 ★★☆ | **库内落地**：档案 `defaults.modelByPref`（quality/balanced/cost 三档）+ env `DSH_EXPERT_ROUTE_PREF` 旋钮——仅在 defaults 层生效（逐专家/组层为显式配置，偏好不覆盖）；级联降档=协议规则（模型不可用按 quality→balanced→cost 手动换 model 重试，沿 2.13.8「插件内不自动 fallback」裁决）；快路径=分诊已有（只读亲自做+简单单专家）；路由层零训练零依赖（清单 #11 同步满足） | expert-profiles.js + tools.js + SKILL.md §5 |
| 6 | 1 write + N read 预热 ★★☆ | **库内落地（opt-in）**：summon_experts 新 `stagger: true` 参数——首项串行完成缓存写入后再并行其余；如实声明：共享前缀主要来自同专家重复条目与宿主基础设施前缀，异质专家 persona 各异收益有限 | tools.js summon_experts |
| 7 | 结构化回传 ★★☆ | **协议落地**：任务书交付段四要素约定（结论/依据/置信度高中低/产物路径）；产物落盘+≤10 行摘要纪律已在位 | SKILL.md §5 |
| 8 | 命中率指标+预算熔断 ★★☆ | **估算面落地**：lib/cost.js CJK 感知 token 估算 + 会话级召唤记账（expert/model/任务书/回包规模）+ env `DSH_EXPERT_TOKEN_BUDGET`（千 token 阈值）超限【成本】提示行（非阻断，沿振荡告警先例）。**如实声明**：宿主 usage 缝缺席，估算是启发式（标注「估算」），真实 hit/miss 回传待宿主 seam 出现后接入（模块头注释留接入点） | lib/cost.js + tools.js |
| 9 | 异构扩编+中心校验 ★☆☆ | **协议落地**：规模纪律中写死「加专家须加异构领域/视角，拒绝同质扩编；复杂任务固定一名独立评审做中心校验」（评审门禁 §4 已在位） | SKILL.md §1 |
| 10 | 压缩梯度+检查点交接 ★☆☆ | **已在位**：断点续跑检查点折叠（v2.7）+ bus 落盘交接 + 指针式材料引用（§5）即 03-启示 3/6 的既有落点；勘验留痕 | SKILL.md §3/§5 既有 |
| 11 | 路由层轻量 ★☆☆ | **设计满足**：route pref 为纯规则查表（无训练模型、无 GPU、CPU 零开销） | expert-profiles.js |
| 12 | 缓存策略进决策 ★☆☆ | **部分落地**：stagger（#6）+ 批间串行建议（§3 既有）+ 三档偏好（#5）；DeepSeek 谷时排程为厂商特定优化，协议注记不做工具面 | SKILL.md §5 |

## 2. 行为零变化纪律

- `DSH_EXPERT_ROUTE_PREF` 未设置（或缺省）→ resolveExpertModel 返回值与现状逐字节一致（modelByPref 未配置同样零变化）。
- `DSH_EXPERT_TOKEN_BUDGET` 未设置/'0'/空串 → 记账仍在（纯内存、零 I/O）但**不产生任何提示行**，summon 输出逐字节不变；阈值非法 → fail-open 禁用 + stderr 告警（沿 taskboard.py budget_thresholds 先例）。
- `stagger` 参数缺省 false → 派发路径与既有逐字节一致（同一 mapPool 调用形态）。
- 【分流建议】仅在「同一批 summon_experts 含 ≥2 个非 readOnly 条目」时出现在 render 文本（工具返回值结构不变，既有断言不受影响）。
- 新增 3 个 msg 字典 key（cost.budgetExceeded / cost.batchSummary / econ.writeFanoutAdvisory），zh 路径为首发文本、en 同步补齐。

## 3. 诚实边界（本方向不宣称的事）

1. **估算≠计量**：estimateTokens 为字符启发式（CJK ≈0.75 token/字、其他 ≈0.25 token/字符），只用于规模对账与熔断提示，不用于计费对账；真实 usage（含 cache hit/miss）接入点=宿主结算面出现 usage 字段时的 runExpertOneShot/runExpertContinuable 消费缝（lib/cost.js 头注留痕）。
2. **stagger 收益有前提**：见映射表 #6，异质专家批次收益有限（persona 各异，共享前缀短），该参数服务于同专家多条目/同宿主前缀批次。
3. **难度估计器缺位**：清单 #4 的「可学习难度估计」无训练数据与推理缝，本方向以分诊三级+子任务定档的规则化形态覆盖其决策面，学习化留待后续方向。
4. **发布纪律**：本分支不 bump 版本、不 npm publish（发布需用户确认）；CHANGELOG 以「未发布」节累积。
