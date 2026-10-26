# 专家模式任务板 · 视觉设计规格 v2（esb-taskboard / .eso-tb-*）

版本 v2.0 · 交付对象：前端实现 · 状态：**方向待用户二选一后实施**
前置：本文基于 v1（docs/taskboard-visual-spec.md）与 UX 规格（docs/taskboard-sidebar-ux-spec.md）复盘产出；交互机制一律沿用 T2/UX 规格，本文只定义视觉层。
硬约束沿用 v1 §0：只用产品 token（`--dsw-alias-*` / `--dsw-radius-*`）、零十六进制字面量、零新依赖、CSS 平铺、ResizeObserver 容器断点、`prefers-reduced-motion` 降级。

---

## 0. 复盘结论（先读）：「简陋」的三层根因

真机截图三张（窄栏分屏 / 宽模式 / 手机全屏）核对 + 源码与宿主主题包核实，根因按权重排序：

### P0-1 样式从未注入——三张截图里任务板是「裸 DOM」（修复归属：实现，非设计）
- 证据：`TB_CSS`（lib/client.js:2383-2537，2537 行 `].join("\n")`）定义后**全文零引用**；样式注入点 lib/client.js:3412 `tag.textContent = CSS;` 只注入设置页样式表（`CSS`，lib/client.js:755-883）。任务板 `.eso-tb-*` 规则一条都没有生效。
- 后果链：工具条无 flex → 「任务板 r29」与开关/刷新按钮换行重叠（缺陷①）；泳道头退化为纯文本行、`.eso-tb-lane-empty` 虚线占位无 border 不可见、done 折叠后板面近乎全空（缺陷②）；卡片只剩裸 button 文本 + meta div（缺陷③）。
- 修复（一行级，归属实现任务，不在本规格范围）：`tag.textContent = CSS + "\n" + TB_CSS;`（或合并数组后 join）。
- **真机验收前置**：本规格所有验收语句仅在 P0-1 修复后才可测。

### P0-2 亮色主题三层底色塌缩——v1 的「页面底/卡片底/弱底」体系在真机亮色下是同一层
- 证据（宿主主题包 dsh-client-ui-theme/lib/client.js，亮色 `body` 块）：`bg-base = bg-layer-1 = bg-layer-2 = bg-layer-3 = var(--dsw-static-neutral-bluish-00)`（全为 #fff）。暗色主题层级正常（950/875/850/800）。
- 后果：即使 P0-1 修复，亮色下卡片仍只是一张 1px 描边的白纸叠在白底上——这是样式生效后「简陋感」仍会残留的主视觉根因。v2 三方向（§5）的核心分歧就是如何在不引入阴影 token 的前提下重建层级（宿主**无任何阴影/海拔类 token**，已核实，勿假设）。

### P1-3 v1/实现引用了宿主不存在的 token（5 处幽灵引用，含设置页 1 处）
宿主主题包实际定义 107 个 `--dsw-alias-*`，逐一核对：

| 引用 | 宿主实况 | 影响面（lib/client.js） | v2 处置 |
|---|---|---|---|
| `--dsw-alias-label-quaternary` | **不存在** | 草稿点描边 2452、pending/unknown 点 2453/2460、chevron 2466、chip 图标 2477、空态图标 2505、watchoff 2420、开关旋钮 2395 | 全部替换（见 §3 T-1） |
| `--dsw-alias-fill-l1` / `-l2`（v1 规格文字） | **不存在** | 仅 v1 文档；实现已用 bg-layer-2 替代 | v1 表作废，见 §3 T-2 |
| `--dsw-alias-bg-skeleton` | 存在（亮 #0000000a / 暗 #ffffff14） | 标题占位 2389、骨架条 2502 | 保留 |
| `--dsw-alias-state-error-secondary` | 存在（亮 red-400 / 暗 red-400） | failed/rejected 点 2457/2458 | 保留 |
| `--dsw-alias-interactive-bg-hover-accent` | 存在（亮 #26314824 / 暗 #ffffff3d） | switch on 2394 | 保留 |
| `--dsw-alias-label-primary-inverted` | 存在 | 页头徽标 2530 | 保留 |

附带发现（超出本任务范围，仅上报）：设置页样式 `.eso-set-badge[data-kind=shadowed]`、`.eso-set-dot`、`.eso-set-switch::after`（lib/client.js:811/816/825）同样引用了不存在的 `label-quaternary`。

### P1-4 真机对比度实测不达标项（WCAG，实测值来自宿主静态色值）

| 组合 | 实测 | 判定 | v2 处置 |
|---|---|---|---|
| 亮·`state-warn-label` #dd8629 文字 on 白底 | **2.79** | ✗ AA（4.5） | 阻塞徽标文字弃用 warn-label，改 label-secondary；语义由 warn 色图标 + 描边承载（§3 T-3） |
| 亮·`state-warn-primary` #f59e0b 图形 on 白底 | **2.15** | ✗ 非文本 3:1 | 图形可接受为"附加通道"（泳道/文字已冗余编码），但阻塞主信号不得只靠它 |
| 亮/暗·pending 点 `state-idle-primary`（neutral-300/600）on 卡底 | 1.48 / 2.10 | ✗ 非文本 3:1 | 中性状态点统一改 `label-tertiary`（亮 3.71 / 暗 7.36，双主题达标）（§3 T-1） |
| 亮·`state-success-primary` #22c55e 图形 on 白底 | 2.28 | ✗ 非文本 3:1 | 进度条填充改用 §3 T-4 组合（track 用 bg-skeleton 提升可感知性）；done 点保留但泳道头有文字冗余 |
| 暗·`state-warn-label` on layer-2 | 4.99 | ✓ | 保留暗色 warn-label 可用 |
| 亮·`label-tertiary` #81858c（11px 弱信息） | 3.71 | ✓（按 v1 §8.3 的 ≥3 宽限） | 保留 |
| 页头徽标：亮 brand #0f1115 + inverted #fff；暗 #f9fafb + #232324 | 18.9 / 15.0 | ✓ | 保留 |
| switch off：亮 track=bg-layer-3=#fff on 工具条 #fff | 1.0 | ✗ 不可见 | off 态 track 加 1px border-l2（§3 T-5） |

### P1-5 实现层小缺陷（视觉相关，一并列入差异清单）
- 摘要条计数点 `.eso-tb-count-dot` 只有尺寸规则、**没有任何 `[data-st]` 着色规则**（CSS 2418 vs 渲染 3233-3237）→ 三处计数点全部透明，摘要条只剩裸数字。
- 泳道名实现用 label-primary（2433），v1 规格为 label-secondary；泳道名升为板内最强文字与卡片标题同级，弱化泳道、强化卡片的层级意图丢失。
- 宽模式截图（真机）中插件 tab 座位仅 ~60px 宽，720px 断点正常走窄模式但容器远低于 300px 设计下限——**待真机复测**（P0-1 修复后若仍复现，属宿主座位分配问题，上报协调者，不属视觉规格）。

---

## 1. 与 v1 差异清单（D 编号，供评审逐条过）

| # | v1 | v2 | 理由 |
|---|---|---|---|
| D1 | Token 表含 `fill-l1/l2`、`label-quaternary` | 全表按宿主实况重写（§3）；幽灵 token 禁用 | 宿主未定义，渲染回退 |
| D2 | 阻塞徽标文字 = `state-warn-label` | 亮色徽标文字 = label-secondary + warn 色图标/描边；暗色保留 warn-label | 亮色 2.79 不达 AA |
| D3 | pending/draft/unknown 点用 idle-primary / label-quaternary | 中性点统一 `label-tertiary`（draft 空心 1.5px、pending 实心、unknown 空心 2px） | idle 双主题 <3:1 |
| D4 | 卡片 hover 仅边线变化 | 方向 A 维持；方向 B/C 见各方向节 | 亮色无边框可辨的层级需另行建立 |
| D5 | 无完成态设计（done 全折叠后板面只剩泳道头） | 新增「全板完成态」横幅视觉（§4.2） | 缺陷② |
| D6 | 摘要条计数点无着色规则（实现遗漏） | 补 `[data-st]` 着色规则并入规格（§4.1） | P1-5 |
| D7 | switch off 无描边 | off track + 1px border-l2 | 亮色不可见 |
| D8 | 进度条 track=layer-2 | track=bg-skeleton、填充=success-primary（不达标时回退 brand-primary） | 亮色 track 不可见 |
| D9 | 泳道名 label-secondary | 维持 v1 意图：泳道名 label-secondary、计数 tertiary，让卡片标题成为卡片区最强文字 | 层级归位 |
| D10 | v1 未定义窄栏 <300px 兜底 | 增加 <300px 兜底行（§4.3）+ 上报座位问题 | 真机 60px 座位 |
| D11 | v1 假设「底色三层」成立 | 亮色底色全同已证实；层级改由「边线 + 淡彩 tint + 结构」承载（三方向分叉） | P0-2 |

---

## 2. Token 修正表（v2 唯一取值来源，全部经宿主主题包核实）

| 语义 | Token | 亮 / 暗实际值（供实现自查） |
|---|---|---|
| 页面底 | `--dsw-alias-bg-base` | #fff / #151517 |
| 卡片底 | `--dsw-alias-bg-layer-1` | **#fff（同 base）** / #232324 |
| 弱底 chip/徽标 | `--dsw-alias-bg-layer-2` | **#fff（同 base）** / #2c2c2e |
| 强弱底（开关轨道等） | `--dsw-alias-bg-layer-3` | **#fff** / #2c2c2e 的更深档 #232324（暗 800 档） |
| 淡彩 tint·进行中 | `--dsw-alias-state-business-tertiary` | deepseek-100 / deepseek-800 |
| 淡彩 tint·完成 | `--dsw-alias-state-success-tertiary` | green-100 / green-900 |
| 淡彩 tint·阻塞 | `--dsw-alias-state-warn-tertiary` | amber-100 / amber-900 |
| hover 命中底 | `--dsw-alias-interactive-bg-hover` | #2631480f / #ffffff14 |
| accent 底 | `--dsw-alias-interactive-bg-hover-accent` | #26314824 / #ffffff3d |
| 骨架 | `--dsw-alias-bg-skeleton` | #0000000a / #ffffff14 |
| 边线 1/2/3 | `--dsw-alias-border-l1/l2/l3` | #0000000a / 1a / 1f · #ffffff0f / 1f / 29 |
| 文字 强/正文/弱 | `--dsw-alias-label-primary/secondary/tertiary` | #0f1115 / #61666b / #81858c · #f9fafb / #cfd3d6 / #adb2b8 |
| 反白（brand 上文字） | `--dsw-alias-label-primary-inverted` | #fff / #232324 |
| 状态·进行 | `--dsw-alias-state-business-primary` | #4176e6 / #7aaaff |
| 状态·成功 | `--dsw-alias-state-success-primary` | #22c55e / #22c55e |
| 状态·失败 | `--dsw-alias-state-error-primary` | #ec1313 / #f25a5a |
| 状态·否决 | `--dsw-alias-state-error-secondary` | #f25a5a / #f25a5a |
| 状态·升级/警示图形 | `--dsw-alias-state-warn-primary` | #f59e0b / #f59e0b |
| 状态·警示文字（**暗色限定**） | `--dsw-alias-state-warn-label` | #dd8629（暗 on layer-2 = 4.99 ✓） |
| 圆角 | `--dsw-radius-xs/sm/md/lg/panel` | 沿用 v1（2/4/8/12/panel） |

**禁用清单**（引用即回归）：`label-quaternary`、`fill-l1`、`fill-l2`、任何 `--dsw-shadow-*`（不存在）、十六进制字面量。

---

## 4. 三方向共同底座（无论选哪个方向都先落地）

### 4.1 摘要条修复（缺陷①②的关联面）
- 计数点补着色：`.eso-tb-count-dot[data-st="done"]`→success-primary、`[data-st="running"]`→business-primary、`[data-st="escalated"]`→warn-primary；6px，无双主题达标要求（旁有数字冗余）。
- 进度条：track = `bg-skeleton`（亮 #0000000a 可感知）、填充 = `state-success-primary`；全亮色真机若填充不可辨（2.28）→ 回退 `brand-primary`（18.9）。验收句见 §7。
- 全部任务 done 时：进度条满格 + 行尾追加「全部完成」12px label-secondary（文案归属 T2，此处只定视觉位置与样式）。

### 4.2 全板完成态（缺陷②专属）
done 折叠 + 其余泳道全空的板区，不再是 4 个孤零零的泳道头：
- 板区顶部渲染一条完成横幅 `.eso-tb-complete`：高 44px、radius-md、底 `state-success-tertiary`（亮 green-100 / 暗 green-900）、左缘 3px 实条 `state-success-primary`、radius-md；内容 = 14px「✓」图标 success-primary + 「9/9 已完成」13px/600 label-primary + 右侧「用时 34 分钟」11px label-secondary（数据沿用现有 loadedAt/summary，不加新交互）。
- 横幅下方泳道照常渲染（空泳道头 + 虚线占位），占位虚线保持 v1 的 border-l1 dashed、20px 高，不改。
- 对比度：暗色 green-900 底上 label-primary #f9fafb 与 success 图标均需真机复查（T-6 验收项）。

### 4.3 极窄兜底（缺陷③的真机面）
- 容器 <300px（含异常座位）：`.eso-tb-card-head` 标题单行截断（去 2 行 clamp）、badges 行隐藏 scope chips 仅保留阻塞徽标；泳道头不变。此为防御性规则，正常座位不触发。
- 60px 级异常座位不试图做视觉补救，按 P1-5 上报。

### 4.4 状态点修正表（替换 v1 §2.2，全方向一致）

| status | v2 规格 |
|---|---|
| draft | 空心：1.5px 描边 `label-tertiary` |
| pending | 实心 `label-tertiary` |
| ready | 空心：2px 描边 `state-business-primary` |
| running | 实心 `state-business-primary` + 2s 脉冲（沿用） |
| done | 实心 `state-success-primary` |
| failed | 实心 `state-error-primary` |
| rejected | 实心 `state-error-secondary` |
| escalated | 实心 `state-warn-primary` |
| unknown | 空心：2px 描边 `label-tertiary` |

其余不变项：动效克制四条（v1 §7）、类名清单（v1 §9）、焦点环、页头徽标（数值对比已实测达标）。

---

## 5. 视觉方向方案（A/B/C，**用户二选一后再实施**）

> 分叉点只有一个：亮色主题下「底色三层塌缩」后，层级与质感从哪里来。暗色主题三方向观感差异小（底色本有层级）。

### 方向 A「线描极简」（Border-first，最小改动）
- 卡片 = bg-layer-1 + 1px border-l1 + radius-md；hover 边线升 border-l2（沿用 v1）。
- 泳道无底无框（沿用 v1 §1.1「拒绝四块灰底拼盘」）。
- 亮色层级补偿：仅把**展开卡**边线升 border-l3 + 卡片底改 `bg-layer-2`（暗色即 850 档，亮色无变化但边线已足够），弱层级纯靠线。
- 一句话取舍：最贴 v1、改动最小、双主题一致性最好；代价是亮色下依旧是"白纸白底"，质感上限最低。
- 适合：如果用户要的是"先把该有的样式真正显示出来，观感不倒退"。

### 方向 B「淡彩语义」（Tinted semantics，推荐）
- 卡片底色保持中性，语义信息以**淡彩 tint**承载（全部来自 *-tertiary token，无新色值）：
  - running 卡：左缘 2px 实条 `business-primary`；展开区顶部 8px 内衬底 `business-tertiary`（radius-sm 内条）。
  - 阻塞徽标：底 `warn-tertiary`、文字亮色 label-secondary / 暗 label-primary、图标 warn-primary、radius-sm——琥珀 tint 药丸成为全卡唯一暖色锚点（替代 v1 的灰底徽标）。
  - attention 泳道卡（failed/rejected/escalated）：左缘 2px `error-primary` 实条。
  - done 卡：无 tint（保持退后），仅标题 label-secondary（沿用）。
- hover：整卡底 `interactive-bg-hover`（150ms），边线不变——亮色下命中区终于可见。
- 泳道仍无底色，tint 只出现在卡片语义元素上，整体仍"简约"。
- 一句话取舍：用宿主现成 tint 档重建语义层级与质感，观感提升最明显、改动可控；代价是卡片出现彩色元素，比 A "热闹"一档。
- 适合：如果用户要的是"一眼有状态感、有设计感，但仍克制"。

### 方向 C「结构面板」（Panel & rail，观感最重）
- 泳道本身成为容器：底 `bg-module-platform`（亮 bluish-60 淡灰蓝 / 暗 800 档）、radius-lg、内 padding 8px、泳道头 sticky 于泳道内顶部（视觉 sticky 由 T2 定，此处只定样式）。
- 卡片在泳道容器内用 bg-layer-1（亮白卡浮于淡灰蓝泳道上——亮色层级由此重建）+ border-l1。
- 空泳道占位改为泳道容器内的居中弱文字「无任务」11px label-tertiary（替代虚线条）。
- 工具条与摘要条维持页面底，形成"外壳-泳道-卡片"三段纵深。
- 一句话取舍：亮色下纵深感最强、最像"专业看板"；代价是视觉密度与改动量最大，且暗色下泳道底与卡片底色差变小、需真机复查（T-6）。
- 适合：如果用户要的是"看板要像一块面板，而不是一页文档"。

**选择建议一句话版**：求稳选 A，求"简约但有设计感"选 B（本人推荐），求"看板存在感"选 C。

---

## 6. 实施顺序（方向选定后）

1. P0-1 样式注入修复（实现任务，前置依赖）。
2. §4 共同底座（含幽灵 token 替换、阻塞徽标、完成态、极窄兜底）。
3. 所选方向（A/B/C）的差异化样式。
4. §7 验收清单逐条真机过检（浅/暗双主题）。

## 7. 真机验收清单（每条可机测/目测，双主题）

1. 打开任务板 tab：工具条单行 40px、标题与开关/刷新不重叠（P0-1 生效判据）。
2. 亮色主题：pending/draft 卡的状态点肉眼可辨（≥3:1，label-tertiary 生效判据）。
3. 亮色主题：阻塞徽标为琥珀 tint 药丸、文字非琥珀色；暗色主题：徽标文字为 warn-label。
4. 摘要条计数前有彩色小点（done 绿 / running 蓝 / escalated 琥珀）。
5. 全部任务 done 后：板区顶部出现绿色 tint 完成横幅，板面不再只有泳道头。
6. （仅方向 B）running 卡左缘 2px 蓝条；（仅方向 C）泳道为淡灰蓝圆角容器、卡片白底浮起；双主题均需复查 tint 底上正文 ≥4.5:1、图形 ≥3:1。
7. switch off 态在亮色工具条上可见圆形轨道描边。
8. 容器 300px / 720px 两档断点行为与 v1 §1 一致；<300px 触发单行标题兜底不横向溢出。
9. `prefers-reduced-motion` 下脉冲/骨架静止（回归项）。
10. 深浅主题切换无残影：`document.head` 中仅一个 `data-plugin` 样式标签且含 `.eso-tb-` 规则（DevTools 可查）。

## 8. 与 T2（UX 交互规格）的边界声明

- 本文不改变：手风琴单开、泳道折叠规则、过滤行触发条件、深链 `#task=`、刷新/watch 机制、键盘与读屏行为——以上以 T2/UX 规格为准。
- 本文新增的视觉元素（完成横幅、tint 实条、泳道容器）均挂在既有 DOM 节点上，不要求 T2 新增任何交互或数据字段；完成横幅文案沿用现有数据（done 计数/总数），如 T2 另有完成态文案以其为准。
- 若 T2 与本文在「空泳道占位」「done 折叠默认态」上冲突，以 T2 为准并回写本文 §4.2。
- 多板切换器的视觉规格见 §9（v2.1 增补）；其交互机制、状态机与键盘/aria 规格以 UX 规格增补（taskboard-sidebar-ux-spec-v2.md §12）为准，本文 §0–§8 结论不变。

---

## 9. 多板切换器（v2.1 视觉增补）

> 任务板「多板切换器」特性增补（任务 T1-MBS）。本节为追加小节，不修改 §0–§8 任何结论；全部样式沿用 §2 Token 修正表，**零新增 token、零十六进制字面量、零新依赖**，CSS 平铺进 `TB_CSS`（类名 `.eso-tb-*`），断点按容器宽（ResizeObserver），`prefers-reduced-motion` 全量静态化。硬约束见 §0/§2。
> 双入口共用同一选板纯函数（裁决①）：选择板页（ambiguous 升级）与工具条紧凑切换下拉只是同一候选数据的两种视觉形态；交互与状态机见 UX 规格 §12。

### 9.1 选择板页（ambiguous → 「选择板」页）

出现条件：解析结果 ambiguous（候选 ≥2）。沿用 `.eso-tb-empty` 垂直居中骨架（图标 + 标题 + 正文 + 附加内容），容器类升级为 `.eso-tb-picker`（min-height 160px、max-width 420px 居中、padding 24px 12px 沿用 empty 骨架）。

结构（自上而下，gap 沿用 empty 骨架 6px，正文与列表之间 16px）：

1. 16px 图标（沿用 `.eso-tb-empty > svg`：label-tertiary）；
2. 标题 `.eso-tb-picker-title`：13px/500 label-secondary（沿用 `.eso-tb-empty-title`）；
3. 正文 `.eso-tb-picker-body`：12px label-tertiary（沿用 `.eso-tb-empty-body`）；
4. 候选卡列表 `.eso-tb-board-cards`：纵向堆叠、宽 100%、max-width 360px 居中、卡间 gap 8px；
5. 尾注「重新检测」linklike 按钮（沿用）。

候选卡 `.eso-tb-board-card`（button 元素）：

- 形态：宽 100%、padding 12px 16px、radius-md、底 bg-layer-1、边线 1px border-l1、行内 gap 8px；内容两行——行 1 显示名 13px/600 label-primary（单行 ellipsis），行 2 meta 11px label-tertiary（mtime + 「来自聊天链接」标注沿用 `tb.empty.ambiguous.chat` 的 data-chat 样式）。

状态表（全部出自 §2 修正表 token）：

| 状态 | 视觉 |
|---|---|
| default | 上行形态原样 |
| hover | 底 `interactive-bg-hover` + 边线升 border-l2；transition 150ms ease |
| focus-visible | 沿用既有任务板焦点环规格（2px，不新增 token/颜色） |
| 上次使用（缓存命中标记） | 左缘 2px 实条 `state-business-primary` + 底 `interactive-bg-hover-accent`；不加 check 图标（避免与 meta 行争宽）；meta 行前置「上次使用」11px label-tertiary |
| active/按下 | 底 `interactive-bg-hover-accent`（与 hover 底一致，边线保持 border-l2） |

空态：候选恒 ≥2 才进选择页（`tbResolveBoard` 判据保证），无独立空态；列表读取异常回落 E3 broken 态。

### 9.2 工具条紧凑切换下拉

触发按钮 `.eso-tb-board-switch`：

- 形态：高 24px、padding 0 8px、radius-sm、flex:none，位于工具条标题之后（顺序见 UX 规格 §12.11 对 §2-1 的扩展）；内容 = 板显示名 12px label-secondary + 下拉 chevron 12px label-tertiary。
- 容器 <360px：降为纯图标按钮（仅 chevron，title=完整文件名），宽度让位标题；此按钮与开关/刷新/筛选同级，**永不裁剪**（UX §12.11）。
- 仅候选 ≥2 时渲染；单板/无板不渲染。

面板 `.eso-tb-board-menu`：

- 定位：absolute，与触发按钮左缘对齐，top = 工具条底 + 4px；z-index 3（工具条为 2）；min-width 200px、max-width min(320px, 容器宽−24px)；max-height 320px、overflow-y auto；底 bg-layer-1、边线 1px border-l2、radius-md、上下 padding 4px。
- 条目 `.eso-tb-board-option`：高 32px、padding 0 12px、radius-sm（内衬圆角）、显示名 12px label-secondary + 行尾 mtime 11px label-tertiary（有则显）。

状态表：

| 状态 | 视觉 |
|---|---|
| hover | 底 `interactive-bg-hover` |
| focus-visible | 沿用既有焦点环（2px） |
| selected（当前板） | 底 `interactive-bg-hover-accent` + 左缘 2px 实条 `state-business-primary` + 文字 label-primary（与 9.1 上次使用态同一视觉语言） |
| 空态 | 面板内单行弱文字「未检测到任务板」11px label-tertiary（aria-disabled，不可选；正常数据下面板不出现空态） |

- 动效：展开 150ms opacity + 4px translateY；`prefers-reduced-motion` 下静态。
- 浮层模式：面板不得被工具条/座位边界裁剪（实现若需挂载点调整属实现取舍，验收以浮层可完整显示为准——UX §12.10 A27）。

### 9.3 板显示名（裁决⑤的视觉面）

- 显示名 = 文件名去 `.json` 后缀；工具条下拉、选择页卡、aria 可访问名均用显示名；完整文件名放 `title` 属性；选择页 meta 行可展示完整文件名 11px label-tertiary。
- events 配对（`<board>.json ↔ <board>.json.events.jsonl`）不产生任何视觉元素。

### 9.4 Token 对照（自查表，零新增）

| 类 | 使用的 token |
|---|---|
| `.eso-tb-picker` / 标题 / 正文 | 沿用 `.eso-tb-empty` 系（bg-base、label-secondary、label-tertiary） |
| `.eso-tb-board-card` / `.eso-tb-board-option` | bg-layer-1、border-l1（hover border-l2）、radius-md / radius-sm、label-primary/secondary/tertiary |
| 选中/上次使用实条与 tint | state-business-primary、interactive-bg-hover-accent |
| hover 命中底 | interactive-bg-hover |
| 下拉面板 | bg-layer-1、border-l2、radius-md |

### 9.5 边界与验收

- 本文 §9 只定视觉；状态机、键盘 roving、aria-haspopup 取舍、切板受控重载语义、L3 缓存键扩展以 UX 规格 §12 为准。
- 真机冒烟验收清单（分屏 20%–80% 逐档、三模式、多板/单板/无板、切板现场保留、刷新不拉走）以 UX 规格 §12.10（A26–A34）为准；本文 §7 清单不含切换器条目，不重复维护。
- 双主题对比度：9.1/9.2 全部组合仅使用 §2 已核实的既有 token 对（interactive-bg-hover-accent、border-l2、label-* ），无新增对比度风险；tint 实条沿用方向 B 同语言，入 §7-6 双主题复查范围。

—— 完 ——
