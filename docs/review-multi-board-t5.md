# [评审] 多板切换器 T5（attempt mbs-t5-1）

- 评审人：代码审查员（只读评审，kind=review）
- 评审对象：多板切换器特性全部未提交改动 —— docs/taskboard-sidebar-ux-spec-v2.md §12 增补（+134）、docs/taskboard-visual-spec-v2.md §9 增补（+82）、lib/client.js（+645）、test/client-taskboard.selftest.mjs（+362）、public/qa-screenshots/build-qa-page.mjs（+91）及 4 张 multi-board QA html/png。
- 评审依据：sidebar-ux-spec-v2 §12（五项裁决/S0-S5/12.2-12.10）、visual-spec-v2 §9、设计系统硬约束（token-only/零新依赖/不拆文件/aria 键盘完整/刷新不移动视线）。
- 核实手段：只读（git status/diff、grep/awk/read、spec 逐条对照）；npm test 复跑一次。

## Verdict：**needs_revision**

发现计数：🔴 P0×1｜🟡 P1×1｜🟡 P2×1｜💭 P3×2。P0/P1 存在即 needs_revision。

npm test 复跑（本次评审独立执行）：`tests 381 / pass 380 / fail 0 / skipped 1` —— 与编排者三次复跑结果一致。

---

## 先说好的：核实为实的亮点

1. **R1 修复有效**：refresh（lib/client.js:3140）经 tbPickBoard 裁决，`if (file && (resolved.kind !== "ok" || resolved.file !== file))` 分支走 S5 内联条且不调 applyBoardResult（:3108-3120）——刷新链不会把用户拉走；compareRefresh（:3172）固定 stat 选定板、仅 changed>0 才重读，catch→`void refresh()` 交 R1 修复路径处理（A33 ✓）。两函数均不再 resolveEntries（有静态锚点测试钉住）。
2. **TB-PURE 纯函数区纯净**（lib/client.js:2196-2588）：awk 全区扫描零 `document./window./io./fetch(/localStorage` 命中；tbResolveBoard:2231 / tbListBoards:2450 / tbPickBoard:2481 / tbBoardSwitchPatch:2499 / tbUiCacheKey:2523 全部输入→输出可测。
3. **Token 纪律零违例**：本次 diff 新增 CSS 无任何十六进制裸色值（grep 核查 0 命中），颜色/圆角全部 `var(--dsw-alias-*)` / `var(--dsw-radius-*)`；字号 px 沿用既有密度阶梯惯例；零新依赖、未拆文件、无豪华动效。
4. **aria/键盘符合 §12.2/12.3**：picker roving tabindex + Home/End 循环；下拉 listbox 模式（aria-activedescendant、触发钮 aria-haspopup/aria-expanded、Esc 回焦触发钮、Tab 关闭）；`.eso-tb-toolbar`（:2618 position:sticky）为下拉 absolute 提供定位上下文，层级正确。
5. **S0-S5 迁移与裁决③④⑤一致**：ambiguous 永不自动猜板；refresh/compareRefresh 永不改选定板；显示名去 .json；L3 两级键 + 旧一级条目按未命中降级（有测试钉住零污染）。
6. **词条双语齐备**（zh/en 各三处新增），未发现漏译或 key 不对齐。

---

## Findings

### 🔴 F1（P0）switchBoard 不落旧板 UI 现场进缓存 —— 裁决②/§12.5/A28 失效

- **位置**：lib/client.js:3206（switchBoard 五步区，只读 restored 不写旧板）；lib/client.js:3267（`tbUiCacheWrite` 六字段写唯一调用点 = unmount cleanup）；lib/client.js:2958-2964（uiSnapRef 仅 5 字段，scrollTop 在 uiScrollRef :2965）；lib/client.js:3101（applyBoardResult 仅写 WriteSelected）。
- **证据**：grep 全文 `tbUiCacheWrite` 仅 :2564 定义 + :3267 一个调用。切板 A→B 时，A 的 expandedId/doneFolded/ownerFilter/blockedOnly/statusFilter/scrollTop 仅存于 React state 与 uiSnapRef，被 switchBoard 直接覆盖且从未写入 TB_UI_CACHE；切回 A 时 tbUiCacheRead 未命中 → 默认初值。推论：每会话只有 unmount 瞬间的最后选定板持有 UI 缓存，「每板各自记忆」实际完全未实现于切板路径。
- **影响**：§12.10 冒烟 A28（切回 A 逐项恢复现场）必挂 —— 而 A28 是 spec 明列 P0 门禁项；裁决②「每板各自记忆、切板不丢现场」不成立。测试侧无任何用例钉「切板前落位」机理，故 381 用例全绿仍漏检。
- **建议修法**（一行级，不拆文件）：
  ```js
  // switchBoard 覆写 state 之前：
  var outgoing = selectedFileRef.current;
  if (typeof outgoing === "string" && outgoing !== "") {
      tbUiCacheWrite(TB_UI_CACHE, sessionId, outgoing,
          Object.assign({}, uiSnapRef.current, { scrollTop: uiScrollRef.current }));
  }
  ```
  注意两点：① uiSnapRef 不含 scrollTop，需并 uiScrollRef.current（对照 unmount 写 :3267-3273 的组合方式）；② 补一条测试钉住该落位次序（见 F3）。

### 🟡 F2（P1）容器宽 720-727px 宽档固定 8px 溢出（T4 已知缺陷，定级确认 + 存量说明）

- **位置**：lib/client.js:2990（`wide = width >= 720`）与宽档 grid `repeat(4, minmax(176px, 1fr))` + 3×8px 列距 → min 总宽 728 > 720。
- **定级**：**P1**（边界缺陷）。经核为存量问题（HEAD 已含，非本次改动引入），但本特性 §12 主张密度阶梯完备性，建议顺手修。
- **建议修法**：`minmax(176px→174px, 1fr)`，4×174+24=720 恰合阈值，免动 spec §5 密度阶梯；或阈值改 728（需同步 spec 与 QA 生成器镜像断点，成本更高，不推荐）。

### 🟡 F3（P2）测试缺口：切板落位机理无覆盖

- **位置**：test/client-taskboard.selftest.mjs 新增 60 用例区。
- **证据**：现有用例钉 tbListBoards 排序/label/hasEvents、tbPickBoard 三态、tbBoardSwitchPatch 五步重置面与次序、uiCache 两级键/降级、T3 接线静态锚点 —— 但「switchBoard 在覆写前写旧板缓存」这一步无静态锚点亦无行为断言，是 F1 漏检的直接原因。
- **建议**：随 F1 修复补 1 条静态锚点（switchBoard 内 tbUiCacheWrite 调用位于 setState 覆写之前）+ 1 条纯函数行为用例（两板各自写读互不串）。

### 💭 F4（P3）spec §12 前言行号锚点已漂移

- **位置**：docs/taskboard-sidebar-ux-spec-v2.md:288「写作时已复核，行号供参考」。
- **实测对照**：tbResolveBoard :2194-2211→现 :2231；TB-PURE 区 :2176-2402→现 :2196-2588；renderCandidates :3354-3363→现 :3738；renderStructuralEmpty :3365-3374→现 :3785；refresh :2865-2883→现 :3140；compareRefresh :2885-2906→现 :3172；TB_UI_CACHE 定义 :2404-2406→现 :2608；卸载落位 :2928-2940→现 :3264-3276。
- **评**：spec 已自注「行号供参考」，不构成纪律违反；建议特性合入时顺手刷新锚点，防后续读者按图索骥失败。

### 💭 F5（P3）compareRefresh 错误路径语义提示

- **位置**：lib/client.js:3172 起 catch 分支。
- **评**：stat/读板任何失败（含瞬时网络抖动）都升级为整板 refresh（一次 listing + 重拉）。行为正确且不改选定板，仅提示：高频轮询下瞬时错误会放大请求量；如后续有节流需求可在 catch 内对 aborted 单独短路（现已有 `signal.aborted` 判断，主路径无碍）。意见项，非必改。

---

## 规格符合性逐条小结（§12）

| 条款 | 结论 |
|---|---|
| 五项裁决 ①②③④⑤ | ③④⑤ ✓；② 未实现（F1） |
| 12.1 S0-S5 状态机 | ✓（S5 内联条 + 保持 S4 渲染 + 重新检测链正确） |
| 12.2 选择页 roving tabindex/Home/End | ✓（初焦点=缓存上次板，aria-selected 标记一致） |
| 12.3 下拉 listbox/Esc/Tab | ✓（activedescendant 模式正确，焦点回归触发钮） |
| 12.4 受控重载五步 | ✓ 次序与重置面一致；**落位步骤缺失（F1）** |
| 12.5 L3 两级键/每板记忆 | 两级键 ✓；「每板记忆」失效（F1） |
| 12.8 F4/F5 | ✓（boardRenderedRef 条件防焦点抢夺；F5 每渲染重置仅轻微冗余） |
| 12.9 词条表 | ✓ 双语齐备 |
| 12.10 冒烟门禁 | A26/A32/A33 判可过；**A28 现状不可过（F1）**；A26 关联的 720-727px 溢出为 P1（F2） |
| §9 视觉 Token 对照 | ✓ 零新增 token，无裸色值 |

## 完成核对

- [x] npm test 复跑一致（381/380/0/1）
- [x] 本报告落盘 docs/review-multi-board-t5.md
- [x] bus 摘要已投 coordinator（task T5 / attempt mbs-t5-1 / 落款「代码审查员」）
- [x] 全程只读：未修改评审对象任何文件、未 commit、无副作用命令

---

# 第 2 轮复审（attempt mbs-t5-2）

- 评审人：代码审查员（只读复审，kind=review，第 2 轮/上限 2 轮）
- 复审对象：T9 回炉交付——lib/client.js switchBoard 落位（:3206-3213）、宽档 grid 174px（:2667）、test 新增 3 用例。
- 核实手段：只读（read/grep/git diff 逐行核对）；npm test 独立复跑一次。

## Verdict：**needs_revision**（第 2 轮 → 按协议 escalated 交编排者裁决）

发现计数：🔴 F1（P0）**已闭合** ✅｜🟡 F2（P1）**未闭合**（修法参照系错位，溢出仍存在）｜🟡 F3（P2）**已闭合** ✅｜回炉新改动无新缺陷 ✅。

npm test 复跑（本次复审独立执行）：`tests 384 / pass 383 / fail 0 / skipped 1` —— 与交付宣称一致。

## F1（P0）switchBoard 落位 —— ✅ 闭合，逐项核实通过

- **写入时机**：lib/client.js:3209-3213，`outgoing = selectedFileRef.current` 判空守卫后调 `tbUiCacheWrite`，位置严格先于 ：3214 `tbBoardSwitchPatch()`（步 1 abort）与 ：3223-3239 全部 state 覆写。switchBoard 为事件处理器，执行时 uiSnapRef.current（:2958-2964 render 期逐次重赋）与 uiScrollRef.current（:4061 onScroll 同步）均为覆写前旧板现值——不存在「outgoing=A 但 uiSnapRef 已被部分重置」的时序（state 批量更新在 handler 返回后才触发 render 重赋）。
- **六字段组合**：`Object.assign({}, uiSnapRef.current, { scrollTop: uiScrollRef.current })`（:3211-3212）与 unmount 落位（:3275-3282）字段集合逐字段一致，同经 tbUiCacheNormalize 收纳（:2535-2548）+ 读侧 board 标记校验（:2559）。
- **outgoing 守卫**：`typeof outgoing === "string" && outgoing !== "" && uiSnapRef.current`（:3210）与 unmount 守卫（:3274）语义一致（S1/S2 无选定板不落位）；`:3205` 同板守卫防自写。
- **重复写幂等**：tbUiCacheWrite 为整条目替换（:2568），同板两次写 last-write-wins 无叠加污染；切板路径写旧板、unmount 路径写当前板，键位（sessionId→board 两级）天然隔离，无同键竞写。

## F2（P1）宽档 174px —— ❌ 未闭合：数学对参照系错位，720-743px（含滚动条至 ~758px）仍溢出

- **位置**：lib/client.js:2667（`repeat(4,minmax(174px,1fr))`）+ lib/client.js:2665（`.eso-tb-board{padding:8px 12px 16px}`）+ lib/client.js:2989-2990（断点测量面 = `.eso-tb-root` 的 contentRect.width）。
- **证据**：回炉修法「4×174+3×8=720 恰合阈值」是把 grid min 总宽与**根容器测量宽**直接比较；但 grid 的实际约束容器是 `.eso-tb-lanes`——其可用宽 = 根 contentRect 宽 − `.eso-tb-board` 水平 padding 24px（:2665，宽档无任何 padding 覆写，已 grep 核实）− 纵向滚动条宽（`.eso-tb-board` overflow-y:auto，:2665；overflow-y 非 visible 使 overflow-x 计算为 auto，横向溢出会出横向滚动条）。DOM 嵌套已核实：root（:4072）→ board（:4060）→ lanes（:4069）。
- **推论**：根宽 720px 时 lanes 可用宽 = 696px（经典滚动条下 ~681px）< grid min 720px → 溢出 24~39px。溢出区间实际为根宽 **[720, 744)**（有经典滚动条时 [720, ~759)），非「720-727px 无溢出」——新测试断言消息（test 第 3 新用例）所述前提不成立。
- **建议修法**（二选一，均为小改）：① `minmax(168px,1fr)`——4×168+24=696=720−24，对齐真实约束面（同步把新用例公式改为 `total + 2×boardPadding ≤ 720`，建议断言锚定 `.eso-tb-board` 的 padding 值而非魔法数）；② 宽档覆写 board padding（如 `[data-eso-tb-wide] .eso-tb-board{padding:8px 4px 16px}`）并按 720−8=712 反推列宽。方案①不动视觉密度更优。
- **窄档核验**：✅ 仅宽档规则一行变更（git diff 确认 176→174 单行），窄档 flex 纵排不消费该值，其余断点不受影响。

## F3（P2）测试缺口 —— ✅ 闭合

三条新用例逐条对照第 1 轮 F3 建议的「1 静态锚点 + 1 纯函数用例」：
1. **落位时机静态锚点**：断言 `tbUiCacheWrite(...outgoing...)` 位于 `var patch = tbBoardSwitchPatch();` 与 `setSelectedFile(file);` 之前 + 守卫语义 + 六字段完整性（uiSnapRef + scrollTop）——精确钉住第 1 轮漏检的根因（覆写前落位）。
2. **A→B→A 纯函数往返**：两板各自写读键位隔离、现场六字段完整恢复、重复落位不污染他板——行为面钉住「每板各自记忆」。
3. **宽档 720 公式断言**：公式化提取 minmax/gap 断言 `4N+3gap ≤ 720` 并钉阈值不回归——公式本身自洽，但钉的是错误参照系（见 F2），需随 F2 复修同步修正断言面。

## 回炉新改动新缺陷排查 —— 未发现

- tbUiCacheWrite 在 switchBoard 路径与 unmount 路径的叠加：整条替换 + 两级键隔离，幂等无污染（F1 项已核）。
- 新增静态锚点测试对 switchBoard 的切片（`function switchBoard(file)` → `apiRef.current = {`）边界稳定，不脆。
- 其余回炉改动仅 :2667 一行 CSS + 3 条测试，无其他触面。

## F4/F5（P3）：维持第 1 轮结论，记 backlog，不阻塞本 verdict。

## 结论

F1/F3 闭合质量高（时机、字段、守卫、幂等四面均真闭合，非表面合规）；F2 修复的公式在其自身参照系内成立（4×174+3×8=720≤720），但参照系错位导致实际溢出未消除——**P1 仍在，verdict=needs_revision**。这是第 2 轮（上限 2 轮），按协议转 **escalated** 交编排者裁决。裁决策参考：F2 修法收敛路径明确（168px 或宽档 padding 覆写，均为小改、低风险），可裁决定向修法后单点回炉，不必重开整特性评审。
