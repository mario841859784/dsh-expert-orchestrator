# T4 评审报告 — 任务板呈现层重做（T3 交付，v2 spec）

- 评审人：代码审查员（T4）
- 日期：2026-10-26（基于工作树未提交改动，HEAD=f45649a）
- 被评对象：`git diff lib/client.js test/client-taskboard.selftest.mjs` + 新增 `docs/taskboard-visual-spec-v2.md`、`docs/taskboard-sidebar-ux-spec-v2.md`、`public/qa-screenshots/`
- **结论：回炉（1 轮即可，3 个 P1 均为小改：一行 CSS 选择器、一行 CSS 位置、一个渲染条件；无结构性返工）**

---

## 一、总体印象

T3 交付质量整体扎实：P0 注入修复落位准确、TB-PURE 纯函数区扩展有测试契约、L3 缓存设计克制（零依赖、不写盘、深链让位语义明确）、测试为真断言且 `npm test` 复跑通过。幽灵 token 清理彻底，方向 C 泳道容器化与密度阶梯均落地。主要问题集中在三处边界态：极窄档阻塞徽章被裁、宽档 done 折叠占位文案自相矛盾、D2 亮色修复对 dep-blocked 因级联顺序失效。

## 二、逐项核对证据

### 1. spec 符合度

| spec 条目 | 判定 | 证据 |
|---|---|---|
| P0-1 样式注入 | ✅ | lib/client.js:3630 `tag.textContent = CSS + "\n" + TB_CSS;`；测试「P0: TB_CSS 已随既有 style 注入块进入文档」断言注入点且 TB_CSS 定义先于注入点 |
| R1 done 折叠初值 | ✅ | `tbInitialDoneFold(doneCount, totalCount)` = `total>0 && done>=3 && done<total`（lib/client.js:2382-2384）；全板完成永不自动折叠；仅初载触发（foldInitRef）；缓存命中时让位（`doneFoldedRef.current == null` 门控） |
| R2 空泳道窄/宽分档 | ⚠️ 部分 | 窄档空泳道只留泳道头（body=null）✅；宽档占位 ✅——但见 P1-2（done 折叠态误渲染「无任务」） |
| R3 完成横幅 | ✅ | lib/client.js:3542-3547 零交互、success-tertiary 底 + 3px 左实条、aria 播报一次（allDoneRef 防重复）、无「用时」字段（用 loadedAt 相对时间，符合 §9 裁决） |
| §4 空态 9 态 | ✅ | E5 横幅、E6 折叠焦点防护（toggleDoneFold 焦点迁至折叠按钮）、E7 过滤空态、E9 内联条 + `setLive(t("tb.error.stale"))` 均落地；E1-E4/E8 沿用 |
| §5 密度档阈值 | ✅ | ≥720 宽 / 480-719 标准 / 300-479 紧凑（两行卡：点+ID+标题+阻塞徽章 / owner+「{n} 个文件」）/ <300 兜底 / <360 裁 rev+watch 点（`data-eso-tb-w360/compact/xnarrow`，lib/client.js:2740-2757）——但见 P1-1 |
| §6 过滤 n/m + aria | ✅ | `filtersActive ? count + "/" + laneTotal`（lib/client.js:3323）；「筛选后 {n} 项」播报（filteredCountRef 防重复） |
| §7 焦点防护 F1/F2 | ✅ | F1：repairFocusOnFilterChange + 焦点迁「重置」/筛选按钮；F2：折叠时焦点迁折叠按钮 |
| §8 UI 保留域 L1/L2/L3 | ✅（P2-1 例外） | L1 刷新/可见性全保留（React 态）；L2 仅布局换档；L3 `TB_UI_CACHE = Object.create(null)` 模块级按 sessionId 存 expandedId/doneFolded/ownerFilter/blockedOnly/statusFilter/scrollTop，卸载落位（lib/client.js:2925-2940），零写盘；深链优先于缓存（expandedId）——但见 P2-1（滚动位置例外） |
| T1 §2 工具条单行契约 | ✅ | 标题 min-width:0 + ellipsis、按钮 flex:none、rev/watch <360 裁剪、开关 off 态 +border-l2（D7） |
| T1 §3 幽灵 token 替换 | ✅ | diff 中 `label-quaternary` 全部为删除行；新增行统一 `label-tertiary`；`fill-l1/l2`、`--dsw-shadow-*`、十六进制字面量零残留（grep 证实 + 测试「TB_CSS 卫生」双保险） |
| T1 §4.1 计数点着色 | ✅ | `.eso-tb-count-dot[data-st=done/running/escalated]` 三色齐备（D6）；进度条 track 改 bg-skeleton（D8） |
| T1 §4.4 状态点表 | ✅ | failed→error-primary、draft/pending/unknown→label-tertiary、泳道 todo 点→label-tertiary |
| 方向 C 泳道容器化 | ✅ | `.eso-tb-lane{background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg);padding:8px}`；卡片 bg-layer-1 浮起；宽档 done 两列网格；空泳道居中「无任务」11px tertiary |
| token 真实存在性 | ✅ | `--dsw-alias-bg-module-platform`、`state-success-tertiary`、`state-warn-tertiary`、`state-error-primary` 均在宿主 dsh-client-ui-theme/lib/client.js 有定义（逐一 grep 冒号形式证实） |

### 2. 约束符合度

- 零新依赖 ✅：`git status` 仅 2 个修改文件 + 新增 docs/public，package.json 未动。
- 裸色值/幽灵 token ✅：见上表；测试「TB_CSS 卫生」静态断言兜底（但其 warn-label 分支断言过弱，见 P2-2）。
- 注册块结构 ✅：diff 唯一触及注入区的是 lib/client.js:3630 一行（textContent 拼接），`ctx.inject` 内层插件结构零改动；T6 静态断言测试通过。
- 数据面 ✅：diff 中 `workspaceFiles`/`tbIo`/`tbParseBoard`/`tbResolveBoard`/`.expert-taskboards` 零命中（grep 证实）；数据格式未触碰。

### 3. 回归风险

- 键盘导航（onCardKeyDown 全局 roving）、Esc 收起、深链 `#task=` 展开+高亮：逻辑未动，仅卡头 JSX 重排，`data-card-id`/`aria-expanded`/`aria-controls` 全保留 ✅。
- aria-live：新增三类播报均走既有 `setLive` 单一 polite 区，带 ref 防重复 ✅。
- TB-PURE 既有纯函数：零改动，仅新增 `tbInitialDoneFold` 并导出；测试提取契约同步更新 ✅。
- `tbInitialDoneFold` 语义：与旧逻辑 `doneCount >= 3` 相比，仅在全板完成（done==total>0）场景行为变化——这正是 R1 要求的修正；既有用例无依赖旧语义 ✅。
- 宽窄切换：isWide 语义不变（≥720），新增档位只加 data 属性与 CSS，不影响既有断点 ✅。

### 4. 测试质量

- 新增 5 条用例（tbInitialDoneFold×2、P0 注入、TB_CSS 卫生、v2 静态锚点）全部为真断言，无恒真；边界覆盖好（total=0、null 防御、全板完成不折叠）。
- `npm test` 本地复跑：**351 tests / 0 fail / 1 skip**（123.6s），与申报一致 ✅。
- 弱点：TB_CSS 卫生测试的 warn-label 分支自认「退而求其次」，用 `uses(5) <= darkBlocks(5)` 放行——实际亮色 warn-label 使用 3 处，其中 1 处未被覆盖（即 P1-3），该断言恰好测不出本次真实缺陷（见 P2-2）。

### 5. 数据面

未触碰 ✅（证据见二.2）。`public/qa-screenshots/build-qa-page.mjs` 明确标注「零依赖、仅 QA 脚手架、非产品代码」，从 lib/client.js 实时提取 TB_CSS 保持单一真相，设计得当。

## 三、回炉项清单

### 🔴 P1-1 极窄档（<300px）阻塞徽章被整行隐藏，违反「阻塞徽章任何档位不裁」
- 位置：TB_CSS xnarrow 规则 `.eso-tb-root[data-eso-tb-xnarrow] .eso-tb-card-badges{display:none;}`。
- 依据：UX spec §3-1「阻塞徽章与 ID 任何档位不裁（唯一异常信号）」；T1 §4.3「badges 行隐藏 scope chips **仅保留阻塞徽标**」。
- 现状：xnarrow 走标准卡分支，badges 行内含阻塞徽章，容器 display:none 连徽章一起裁掉——异常座位下唯一异常信号消失。
- 建议：删去 `.eso-tb-card-badges{display:none}`（chip/chip-more 已各自隐藏，该条对 chips 是冗余、对徽章是伤害）。

### 🔴 P1-2 宽档 done 折叠态渲染「无任务」占位，与泳道头计数 9 自相矛盾
- 位置：lib/client.js:3327-3337 renderLane——`shownTasks` 在 done 折叠时置空数组后，`shownTasks.length===0 && isWide` 即渲染 `t("tb.lane.empty")`。
- 依据：UX spec R2 表「已完成 **空**」才出占位；E6 折叠态要求「泳道头常显『已完成 (9)』+ 折叠区不渲染卡片」，占位文案与计数 9 并存属错误信息。
- 现状：宽档 + 手动折叠 done（9 项）→ 泳道头「9」+ 折叠箭头下方显示「无任务」。
- 建议：done 泳道的占位条件改用真实空判断（如 `name === "done" ? lanes[name].length === 0 : tasks.length === 0` 再叠加折叠分支），折叠态渲染 null。

### 🔴 P1-3 D2 亮色降对比修复对 `.eso-tb-dep-blocked` 级联失效
- 位置：D2 覆盖行（`.eso-tb-lane-blocked,.eso-tb-detail-fail .eso-tb-detail-tag,.eso-tb-dep-blocked,...{color:label-secondary}`）插在 TB_CSS 数组前段，而既有规则 `.eso-tb-dep-blocked{color:var(--dsw-alias-state-warn-label);}`（HEAD lib/client.js:2496，现 TB_CSS 区相对行 ~133）在其后，同特异性后者胜——亮色下 dep 行「阻塞」文字仍是 warn-label（实测对比度 2.79，不达 AA）。
- 说明：该规则系 T3 之前既有（非本 diff 引入的回归），但本 diff 的 D2 修复明确把 `.eso-tb-dep-blocked` 列入覆盖清单却未生效，属修复未达意图；且 P2-2 的弱断言恰好放行。
- 建议：把 `.eso-tb-dep-blocked{...warn-label}` 基础规则并入 D2 前段治理（删除原行，或将其移到覆盖行之前）。

### 🟡 P2-1 L3 滚动恢复覆盖深链 scrollIntoView（spec「深链优先」的滚动例外）
- 位置：深链高亮 layout effect（lib/client.js:2983-2987，声明在前）→ L3 恢复 effect（lib/client.js:3002-3008，声明在后、同批 commit 执行、后写胜）。同 sessionId 关闭重开且带 `#task=` 时，卡会展开+高亮但视口落在缓存 scrollTop 处，高亮卡可能不在视口内。
- 建议：restore 前检查 `highlightId == null`（或深链存在时丢弃缓存 scrollTop）。影响面窄（同一会话重开+深链组合），容忍不回炉亦可。

### 🟡 P2-2 warn-label 卫生断言近恒真（测试质量）
- 位置：test/client-taskboard.selftest.mjs「TB_CSS 卫生」用例——`uses(5) <= darkBlocks(5)`，其中 1 处 warn-label 是注释文本，实际亮色使用 3 处仍放行。
- 建议：改为逐行断言「含 warn-label 的规则行必须含 `body[data-ds-dark-theme]`」（注释行除外）；否则 P1-3 类问题测试永远测不出。

### 🟡 P2-3 容忍建议（可不改）
- `tb.aria.filtered` 英文文案「{n} items after filter」与 spec §9「{n} tasks match filter」措辞不一致——语义等价，容忍。
- `tb.aria.refreshStale`（spec §9 新 key）实现复用既有 `tb.error.stale`（中英文案与 spec 意图逐字一致）——key 名不同、文案相同，容忍。
- 泳道头 sticky 于泳道内顶部（T1 方向 C 提及「视觉 sticky 由 T2 定」）未实现，T2 spec 亦未要求——归属待定，容忍，建议记录 backlog。

## 四、判定

**回炉（1 轮）**：P1-1 / P1-2 / P1-3 三项（合计约 3-5 行改动，均在 TB_CSS 数组与 renderLane 条件内，无结构调整），修后只需重跑 `npm test` + 宽/窄档截图冒烟即可复核。P2 三项建议随同批次顺手处理 P2-2（一行测试改法），P2-1/P2-3 可容忍。

---

# 第 2 轮复审（T4 回炉修复验证）

- 评审人：代码审查员（T4）
- 日期：2026-10-26（只读复审，基于工作树未提交改动）
- 被评对象：`git diff lib/client.js test/client-taskboard.selftest.mjs`（相对第 1 轮同一工作树）
- **结论：✅ pass —— 3 个 P1 全部闭合，2 处联动清理正确且最小，3 条新回归用例为真断言且与修复一一对应，`npm test` 本地复跑 354 tests / 0 fail / 1 skip（353 pass，138s）与申报一致；未发现修复引入的新 P0/P1 问题。**

## 一、P1 逐条闭合证据

### P1-1 xnarrow 阻塞徽章被裁 — ✅ 已闭合
- 证据：lib/client.js:2583-2585 现为 `.eso-tb-root[data-eso-tb-xnarrow] .eso-tb-chip,.eso-tb-root[data-eso-tb-xnarrow] .eso-tb-chip-more{display:none;}`——仅隐藏 scope chips，`.eso-tb-card-badges` 容器不再整行隐藏（第 1 轮针对容器的那条规则已删除，grep 全文无残留）。
- 阻塞徽章链路核实：标准卡分支 `if (blockedCount > 0) badges.push(blockedBadge)`（lib/client.js:3244）→ badges 行（lib/client.js:3253）；compact 档徽章走卡头（lib/client.js:3220-3221），均不受 xnarrow 新规则影响。`.eso-tb-badge-blocked`（lib/client.js:3201-3208、样式 lib/client.js:2520）在 xnarrow 档可见——符合 UX spec §3-1「阻塞徽章任何档位不裁」。
- 回归用例：test/client-taskboard.selftest.mjs:281-288「回炉 P1-1」断言 xnarrow display:none 规则恰一条、必含 `.eso-tb-chip`、必不含 `card-badges`——真断言，直接钉死本缺陷。

### P1-2 宽档 done 折叠态渲染「无任务」自相矛盾 — ✅ 已闭合
- 证据：lib/client.js:3336-3347——`laneTrulyEmpty = name === "done" ? lanes[name].length === 0 : tasks.length === 0`；分支顺序为 `shownTasks.length > 0` → `else if (folded)` 渲染 null → `else if (isWide && laneTrulyEmpty)` 渲染占位 → else null。折叠态（shownTasks 置空）一律走 null 分支，不再出现「无任务」与泳道头计数 9 并存。
- 边界核实：折叠按钮仅在 `laneTotal >= 3` 时渲染（lib/client.js:3328-3330），初值折叠 `tbInitialDoneFold(0,0)=false`——空 done 泳道不可能进入折叠态，无「折叠 + 真空」死角；done 泳道用未过滤计数 `lanes[name].length` 判真空，过滤生效时（泳道头 0/9）不折叠则不渲染占位（宽档保留泳道、E7 过滤空态仅窄档，lib/client.js:3537-3540），符合 spec。
- 回归用例：test/client-taskboard.selftest.mjs:290-299「回炉 P1-2」断言真实空判断表达式存在 + 折叠 null 分支先于空态占位分支——真断言。
- 💭 遗留观察（非本次修复引入，不阻塞）：非 done 泳道在过滤生效且 0 匹配 + 宽档时仍渲染「无任务」占位，与泳道头「0/n」并存——该行为与第 1 轮已通过的原条件（`shownTasks.length===0 && isWide`）逐字等价，非回炉回归；spec R2/E7 未禁止，建议记 backlog 与 P2-3 同批处理。

### P1-3 D2 亮色修复对 dep-blocked 级联失效 — ✅ 已闭合
- 证据：独立基础规则 `.eso-tb-dep-blocked{color:var(--dsw-alias-state-warn-label);}` 已删除（diff 删除行，grep 全文无该规则残留，仅注释说明 lib/client.js:2437、2544-2545）；D2 亮色治理行 lib/client.js:2523 含 `.eso-tb-dep-blocked` → `label-secondary`（AA 达标）；暗色 override 行 lib/client.js:2524 保留 `warn-label`。级联根因（同特异性后行胜）已消除。
- 主题回归核实：warn-label 现仅出现在 `body[data-ds-dark-theme]` 前缀行（lib/client.js:793/829/879 位于 TB_CSS 区外不受影响；TB_CSS 区内仅 lib/client.js:2524 一处）；亮色 badge-blocked 改为 warn-tertiary 底 + label-secondary 文字（lib/client.js:2520），暗色走 override 行 warn-label——D2 语义（亮降对比/暗保留）双向一致。

## 二、联动清理复核（正确且最小）

1. **filter-chip blocked**：原亮色规则 `.eso-tb-filter-chip[data-kind="blocked"][data-on]{color:warn-label}`（diff 删除行）已删；并入 D2 亮色行（lib/client.js:2523）+ 暗色 override 行（lib/client.js:2524）。特异性核实：D2 行 (0,3,0) > 通用 `[data-on]` 行 (0,2,0)（lib/client.js:2436），开启态阻塞 chip 亮色必然命中 label-secondary ✅。
2. **lane-blocked**：原基础规则中的 `color:warn-label` 已从 lib/client.js:2475 移除（该行现仅剩 font-size/font-variant-numeric），亮色走 D2 行、暗色走 override 行 ✅。
3. 两处清理均为「删原行 + 并入既有 D2 行」形态，零新增选择器、零结构调整，最小改动 ✅。P2-2 同步闭合：TB_CSS 卫生测试 warn-label 分支改为逐行断言「非注释行含 warn-label 必含 `body[data-ds-dark-theme]`」（test/client-taskboard.selftest.mjs:246-251），不再近恒真——P1-3 类级联失效今后必被测出。

## 三、回归用例质量

- 新增 3 条（test/client-taskboard.selftest.mjs:281/290/301）：「回炉 P1-1」「回炉 P1-2」「回炉 P1-3」，均为真断言（精确到选择器级/分支顺序级/规则级），无恒真、无仅 grep 注释的弱断言；与 3 个 P1 一一对应 ✅。
- 其中 P1-2 用例额外断言分支顺序（folded null 分支先于空态占位分支），P1-3 用例断言根因形态（独立 warn-label 规则不得残留）——钉死的是缺陷机理而非表象，质量好 ✅。

## 四、npm test 本地复跑

- **354 tests / 353 pass / 0 fail / 1 skip**（138.4s），与申报「354/0 fail/1 skip」一致 ✅。

## 五、全 diff 复扫

- hunk 分布与第 1 轮评审范围一致（locale、TB-PURE、TB_CSS、渲染层、缓存、测试），回炉改动全部落在上述已核实区域；零新依赖（git status 仅 2 个修改文件 + docs/public 新增）、数据面零触碰、注册块结构未动（维持第 1 轮已核实的 lib/client.js:3630 单行注入点）。未发现第 1 轮遗漏的 P0/P1 级新问题。

## 六、遗留问题清单

| 级别 | 项 | 处置建议 |
|---|---|---|
| 💭 | 非 done 泳道过滤 0 匹配 + 宽档渲染「无任务」与泳道头 0/n 并存（原行为，非回炉回归） | 记 backlog，随 P2-3 同批 |
| 💭 | P2-1（L3 scrollTop 覆盖深链 scrollIntoView）、P2-3 三项 | 维持第 1 轮「容忍」裁决不变 |

**判定：pass（第 2 轮=最后一轮，无 P0/P1 遗留）。**
