# 专家模式任务板 · 视觉设计规格(esb-taskboard / .eso-tb-*)

版本 v1.0 · 交付对象:前端实现 · 状态:可实施
范围:dsh-expert-orchestrator web client 右侧 Sidebar 自定义 tab(停靠面板 / 分屏 2 格 / 全屏)+ 会话页头 icon button 入口。
本文只含设计规格,不含实现代码。

---

## 0. 设计基调与硬性约束

- **简约**:底色只有三层——页面底 / 卡片底 / 弱底;彩色只允许出现在 ①状态点 ②阻塞徽标 ③accent 交互反馈(含 switch on、重试链接)。其余一律中性灰阶。
- **渐进披露**:默认每张卡只暴露 title + 状态点 + owner + 阻塞;desc / dep / summary / fail 全部收进展开区。
- **Token 硬约束**:颜色、圆角只允许引用产品主题变量(`--dsw-alias-*`、`--dsw-radius-*`);禁止任何十六进制字面量、禁止新设 CSS 自定义属性存颜色。圆角只用 xs(2)/sm(4)/md(8)/lg(12)/panel。
- **实现形态**:CSS 为纯文本字符串 → 禁用嵌套语法、预处理器特性;选择器一律平铺,前缀 `.eso-tb-`。
- **宽度断点不使用媒体查询**:面板宽 ≠ 视口宽。由容器 ResizeObserver 在根节点切换 `data-eso-tb-wide`,CSS 按属性选择器切换布局。
- react 为唯一外部依赖;StateDot / PathLabel / FileTypeIcon 三个基元优先复用(见 §3.6 基元映射)。

### Token 映射表(唯一的取值来源)

| 语义 | Token |
|---|---|
| 页面底(板区/工具条底) | `--dsw-alias-bg-base` |
| 卡片底 | `--dsw-alias-bg-layer-1` |
| 弱底(chip/徽标/骨架条) | `--dsw-alias-fill-l1`(次选 `--dsw-alias-fill-l2`) |
| 边线 默认/hover/激活 | `--dsw-alias-border-l1` / `-l2` / `-l3` |
| 文字 强/正文/弱/最弱 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-quaternary` |
| accent 交互(hover、链接、switch on) | `--dsw-alias-interactive-bg-hover-accent`、`--dsw-alias-link` |
| 状态图形 | `--dsw-alias-state-idle-primary`、`state-business-primary`、`state-success-primary`、`state-error-primary`、`state-error-secondary`、`state-warn-primary` |
| 状态文本(警告语义小字) | `--dsw-alias-state-warn-label`(阻塞徽标专用,勿用 warn-primary) |
| 骨架 | `--dsw-alias-bg-skeleton` |
| 圆角 | `--dsw-radius-xs / sm / md / lg`(面板外框 `panel`) |

字号体系(全板统一一套,窄/宽模式不换档):11 / 12 / 13px;字重 400 / 500 / 600;行高 15 / 17 / 18px。间距基数 4px,使用 4 / 6 / 8 / 12 / 16。

---

## 1. 看板布局(四泳道双模式)

泳道固定四列,顺序与语义:

| 泳道 | 含状态 | 排序规则 |
|---|---|---|
| 待办 | draft, pending, ready | 被阻塞者沉底,其余按 updated 倒序 |
| 进行中 | running | updated 倒序 |
| 已完成 | done | updated 倒序 |
| 异常 | failed, rejected, escalated | escalated > failed > rejected,再按 updated |

### 1.1 宽模式(容器 ≥ 720px,含分屏大格与全屏)

- 4 列等宽 grid:`repeat(4, minmax(176px, 1fr))`,列间距 8px。
- **泳道不设底色、不画框**,与板区同为页面底;列与列之间仅靠「列头 + 间距」区分(简约优先,拒绝四块灰底拼盘)。
- 列头(高 28px):状态点 8px + 泳道名 12px/600 label-secondary + 计数 11px label-tertiary(tabular-nums)。待办列计数附加阻塞数:「6 · 阻塞 2」,阻塞数用 `state-warn-label` 着色。
- 每列内部独立滚动,列高 = 板区可视高;列内卡片垂直间距 6px。
- 全屏模式:板区内容 `max-width: 1440px` 水平居中,避免超宽屏把卡片拉散。
- 泳道为 0 时:保留列头,计数 0,label-quaternary;列体显示一条 20px 高的虚线占位(border-l1 虚线,半径 sm)——保留空间记忆,不显示插画。

### 1.2 窄模式(容器 < 720px;最窄 ~300px)

- 泳道从横排改为**纵向分区**:每泳道 = 分区头(28px,样式同列头)+ 卡片纵向列表;分区间距 12px。
- 分区头吸附效果不做(滚动性能与噪音取舍),四个分区始终按序渲染,空分区只留 28px 头 + 计数 0。
- 300px 极窄校验:卡片单列自适应,标题单行截断;泳道头、徽标、chips 均不换档、不隐藏——本规格的一套字号在 300px 下不溢出(标题 13px + 点 8px + 间距 8px + padding 24px ≈ 仍余 200px+ 给文字)。
- 卡片列表在窄模式下随整板滚动(板区一个滚动容器),不出现双层滚动条。

---

## 2. 卡片解剖(两种模式同一张卡,宽度自适应)

```
┌ .eso-tb-card ─ bg layer-1 · border 1px border-l1 · radius-md · padding 10px 12px ─┐
│ R1  [StateDot 8px] —8px— [标题 13px/600 label-primary,最多 2 行,line-height 18px, │
│      溢出省略] ·················(hover 时右端出现 chevron 12px label-quaternary)  │
│ R2  margin-top 6px  「T1」11px/500 label-tertiary tabular —6px— owner 12px/400      │
│      label-secondary(owner 过长截断,hover title 提示全文)                        │
│ R3  margin-top 6px(仅有阻塞或 scope 时渲染)                                      │
│      [阻塞徽标] —4px— [scope chip] —4px— [scope chip] [+n]                        │
│ R4  展开区:margin-top 8px · padding-top 8px · border-top 1px border-l1           │
│      desc    12px/400 label-secondary,行高 17px,不限行数                        │
│      dep 行  margin-top 6px:6px StateDot + 「T2」11px label-secondary +           │
│              未满足者尾部追加「阻塞」11px state-warn-label                        │
│      summary margin-top 6px:12px/400 label-secondary,前缀「摘要」11px tertiary    │
│      fail    margin-top 6px:12px/400 label-secondary,前缀「失败」11px state-warn-label │
└──────────────────────────────────────────────────────────────────────────────┘
```

逐项规格:

- **整卡可点** = 展开/收起;hover 仅边线 `border-l1 → border-l2`(150ms),**不用阴影、不用上浮位移**。
- done 卡不做透明度衰减;弱化靠语义:标题用 13px/500 label-secondary,其余同规格(保证 ≥4.5:1)。
- **阻塞徽标** `.eso-tb-badge-blocked`:高 18px、padding 0 6px、radius-sm、底 `fill-l1`;内容 11px/600 `state-warn-label` 文字「阻塞 2」(数字 = 未满足 dep 数),前置 12px 警示图标(同色)。它是全卡唯一的暖色,天然成为视觉锚点。
- **scope chips** `.eso-tb-chip`:复用 PathLabel 呈现路径,外层高 18px、radius-sm、底 `fill-l1`、文字 11px/400 label-tertiary;最多显示 2 个,超出折叠为「+n」(11px label-tertiary,无底色)。chip 不参与 hover/点击(纯展示;点击查看文件属后续增强,不在本期)。
- **dep 行**中「阻塞」判定即 schema 规则:dep 指向的任务 status ∉ {done} → 阻塞。
- 焦点:卡片可聚焦(tabindex=0),`:focus-visible` 2px outline `--dsw-alias-link`,offset 2px;Enter/Space 触发展开。
- 卡片间距:列内 6px;同一泳道卡片高度不强制等高。

### 2.1 基元映射与回退

| 需求 | 基元用法 | 回退(若基元能力不足) |
|---|---|---|
| 状态点 | `StateDot{state}` | 自绘 8px 圆点,仅用 state-* token(见 §2.2) |
| scope 路径 | `PathLabel{path}`(字号 11px,label-tertiary) | 无 |
| scope 文件类型图标 | `FileTypeIcon{path}` 12px,置于 chip 内最左 | 无 |

### 2.2 状态 → 状态点映射(8 值)

| status | 状态点 | 说明 |
|---|---|---|
| draft | 空心点:1.5px 描边 label-quaternary | 未定稿,最弱 |
| pending | 实心 `state-idle-primary` | 等待中 |
| ready | 空心点:2px 描边 `state-business-primary` | 可执行,与 running 同色系但空心 |
| running | 实心 `state-business-primary` + 2s 脉冲(见 §7) | |
| done | 实心 `state-success-primary` | |
| failed | 实心 `state-error-primary` | |
| rejected | 实心 `state-error-secondary`(浅一档,区别人为否决) | |
| escalated | 实心 `state-warn-primary` | |

StateDot 若不接受自定义色/空心形态,按 §2.1 回退自绘,仍只用上表 token。

---

## 3. 工具条 `.eso-tb-toolbar`

- 高 40px,sticky 顶部,底色页面底,下边线 1px border-l1,padding 0 12px。工具条始终可见(加载/错误态也渲染)。
- **左组**(间距 8px):
  - 板名:13px/600 label-primary;超长省略,hover title 全名。加载中显示 72×10px 占位条(fill-l1,radius-sm)。
  - revision:`r12` 11px/400 label-tertiary,tabular-nums;revision 变更时淡入更新(150ms),无跳动。
  - watch 指示:6px StateDot,watch 连接时 `ongoing`(business-primary),未连接隐藏——不显示断开红点(异常表达留给板区错误条,避免双红)。
- **右组**(间距 4px):
  - 自动刷新 switch:28×16,track radius-full;off = `fill-l2` 底 + 12px 旋钮 label-quaternary;on = 底 `--dsw-alias-interactive-bg-hover-accent` + 旋钮页面底。这是三处彩色规则之外唯一的功能性 accent(与「accent hover」同类),on 状态旋钮不发光不加动效。
  - 刷新 icon button:28×28 ghost,图标 14px label-secondary,hover 底 `interactive-bg-hover`;title「刷新于 12:03:22」。刷新中图标不旋转(数据量小、请求快,旋转反而提示"慢")。
  - 筛选 icon button:28×28 ghost,仅当满足 §4 出现条件时渲染;有激活过滤时图标着 label-primary + 右上 4px `state-business-primary` 圆点。
- 工具条下沿与板区间不留额外分隔带。

## 4. 过滤行 `.eso-tb-filters`

- **出现时机(全自动,无用户配置)**:任务总数 ≥ 8 时,工具条右组出现筛选按钮;点击后在其下方展开过滤行。总数回落 < 8 且无激活过滤时按钮与行一并移除。
- **形态**:高 32px 内联行,底页面底,无独立边线(与工具条共享下边线);内容为水平 chip 串,溢出横向滚动。
- **chip**(高 24px、radius-full、padding 0 8px、11px/500):
  - 状态 chip = 6px 状态点 + 状态名 + 计数;未选中:透明底 + border-l1 + label-secondary;选中:`fill-l1` 底 + border-l2 + label-primary。多选。
  - 特殊 chip「仅看阻塞」:选中时文字用 `state-warn-label`、点用 warn(阻塞语义的唯一二次入口)。
  - 任一 chip 激活时,行尾出现「重置」11px 文字按钮(`--dsw-alias-link`)。
- 过滤导致的空泳道:泳道头计数变 0 并保留位置(见 §1);板区不出现"无结果"大空态——空泳道本身就是结果。
- 收起:再次点击筛选按钮;有激活过滤时按钮上的圆点提示不消失。

---

## 5. 三态设计(加载 / 空 / 错误)

统一原则:三态都发生在**板区内部**,工具条永不消失;不用全屏 spinner、不用插画、不用 toast。

- **加载(首次)**:工具条立即渲染(板名用占位条);板区显示 3 张骨架卡(高 64px、radius-md、bg layer-1),卡内两条骨架线(高 8/6px、bg `--dsw-alias-bg-skeleton`、radius-sm,宽度 70%/45%)。骨架脉动 1.5s ease-in-out 循环(opacity 1→0.55);窄模式与宽模式均如此(宽模式 3 张骨架放在第一列)。加载中不渲染泳道头。
- **空**:
  - 真空态(板上无任务):板区垂直居中,min-height 160px;内容三行居中——16px 中性图标(label-quaternary)、「暂无任务」13px/500 label-secondary、提示 12px label-tertiary「等待编排器创建任务」。无按钮。
  - 过滤空态(有任务但全被滤掉):仅在窄模式下可能出现整板无卡;文案 12px label-tertiary「无匹配任务」+「清除过滤」link 按钮。宽模式因空泳道保留占位,不触发。
- **错误**:
  - 首次加载失败:板区中央——8px error StateDot + 「任务板加载失败」13px/500 label-secondary + 错误信息 12px label-tertiary(单行截断,title 全文)+「重试」12px `--dsw-alias-link` 文字按钮。
  - 刷新失败且有旧数据:**板区顶部内联条**(高 28px、底 `fill-l1`、radius-sm、间距 8px、不 sticky):6px error StateDot + 12px label-secondary「刷新失败,显示上次数据」+ 时间 11px tertiary + 行尾「重试」link。旧数据保持可见可滚,不打断阅读;下次成功后整条淡出(150ms)。

---

## 6. 会话页头入口与徽标

- 入口:页头 icon button 28×28,图标 16px,默认 label-secondary,hover 底 `interactive-bg-hover` + 图标 label-primary;选中(面板打开)时图标 label-primary + 底 `fill-l1`。
- **running 计数徽标**:绝对定位于按钮右上角(offset 约 -2px,-2px)。
  - running ≥ 1:min-width 16px、高 16px、padding 0 4px、radius-full;底 `--dsw-alias-brand-primary`,文字 10px/600 白色(取产品反白 token),tabular-nums;> 99 显示「99+」。
  - running = 0:不显示徽标——包括板上存在 failed/escalated 时也不改用红色徽标(避免页头出现第二套语义色;异常详情属于面板内)。
  - 面板打开期间徽标照常计数(用户可能看的是别的 tab)。
- 无 board 数据(未初始化)时不渲染按钮态差异,徽标自然为 0 即隐藏。

## 7. 动效克制原则

只保留 4 个动效,其余一律不做:

| 动效 | 规格 | 为什么值得 |
|---|---|---|
| 卡片展开/收起 | 高度过渡 200ms `cubic-bezier(0.2, 0, 0, 1)`,chevron 同步旋转 180° | 渐进披露的核心反馈 |
| 状态变更/跨泳道移动 | 新位置卡片 opacity 0→1,150ms ease-out;**不做 FLIP 位移** | 自动刷新频繁,位移动画会变成持续噪音 |
| hover/press | 边线与底色 150ms ease | 唯一的可供性暗示 |
| running 状态点脉冲 | 2s 循环,opacity 1→0.4→1;外圈 12px 同色 40% 透明光圈淡入淡出;仅 running 且 watch 开启时 | running 是唯一需要"生命感"的状态 |

明令禁止:卡片入场滑入、泳道重排动画、徽标数字跳动/弹跳、switch 弹性回弹、阴影过渡、骨架以外的 shimmer。
`prefers-reduced-motion: reduce` → 全部过渡时长归 0,脉冲与骨架脉动移除。
页面不可见(document.hidden)时暂停脉冲与刷新动画类。

## 8. 深浅主题对比度检查点(实现后逐条验收)

1. **12px 正文**(desc、owner,label-secondary)在卡片底(layer-1)上,双主题 ≥ 4.5:1;token 不达标时该处升用 label-primary——13px 标题(primary)任何主题不得低于 4.5:1。
2. **阻塞徽标文字必须用 `state-warn-label`**(为文本设计);warn-primary 是图形色,浅色主题下叠在 fill-l1 上很可能 < 4.5:1,禁止用作文字。
3. **11px chip 文字**(label-tertiary)属弱化信息,允许 ≥ 3:1;但 title / desc / owner 永不降到 tertiary 以下。
4. **深色主题不用投影**:层级一律靠 border-l1 + 底色差;浅色主题同样只用 1px 边,保证双主题观感一致(也规避深色下阴影发脏)。
5. **骨架可见性**:`bg-skeleton` 与 layer-1 的亮度差双主题都要可感知(≥ 8%);深色主题骨架消失是最常见回归,验收必查。
6. **状态点作为非文本图形**(WCAG 1.4.11):各 state-* 相对卡片底 ≥ 3:1;failed 红、pending 灰在浅色底上易不达标——不达标时分别改用 `state-error-secondary` 与 label-quaternary。
7. **running 徽标反白文字**:深色主题下检查 brand-primary 变体与白色文字 ≥ 4.5:1;不达标时深色主题改用产品反白组合(label-primary-inverted 底 + 对应前景)。
8. **done 卡标题**用 label-secondary 而非 tertiary(§2),保证弱化但仍可读。
9. **焦点环**双主题同规格:2px `--dsw-alias-link` outline + 2px offset,任何主题下不得不可见。
10. **hover accent**(`interactive-bg-hover-accent`)作为底色时确认其透明度在双主题下均能提示命中区域,且不与选中态(border-l2 + fill-l1)混淆。

## 9. 类名清单(实现命名约定)

`.eso-tb-root` `.eso-tb-toolbar` `.eso-tb-board` `.eso-tb-filters` `.eso-tb-filter-chip` `.eso-tb-lane` `.eso-tb-lane-head` `.eso-tb-lane-empty` `.eso-tb-card` `.eso-tb-card-title` `.eso-tb-card-meta` `.eso-tb-card-badges` `.eso-tb-badge-blocked` `.eso-tb-chip` `.eso-tb-chip-more` `.eso-tb-card-detail` `.eso-tb-dep-row` `.eso-tb-skeleton` `.eso-tb-empty` `.eso-tb-error-strip`。
状态钩子用属性而非类:`.eso-tb-card[data-status="running"]`、`.eso-tb-root[data-eso-tb-wide]`、`.eso-tb-root[data-loading]`。

—— 完 ——
