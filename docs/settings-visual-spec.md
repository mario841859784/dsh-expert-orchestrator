# 插件设置页 · 视觉设计规格（dsh-expert-orchestrator / .eso-set-*）

版本 v1.0 · 交付对象:前端实现 · 状态:可实施
范围:宿主插件菜单设置页（slot `plugins.bundle.config`，容器宽约 640–900px，深浅双主题）。
设计权威:与 docs/taskboard-visual-spec.md（v1.0）收敛为同一套设计系统——同 token、同圆角阶、同字号阶、同彩色纪律；本文只含设计规格，不含实现代码；只规划不改交互逻辑（ARIA/role/事件结构全部保持现状，仅替换视觉层）。

---

## 0. 设计基调与硬性约束

- **简约**:底色只有三层——页面底 / 卡片底 / 弱底;彩色只允许出现在 ①状态点 ②危险/警示徽标与红字状态 ③accent 交互反馈(含 switch on)。其余一律中性灰阶。
- **Token 硬约束**:颜色、圆角只允许引用产品主题变量(`--dsw-alias-*`、`--dsw-radius-*`);禁止十六进制字面量、禁止新设 CSS 自定义属性存颜色。圆角只用 xs(2)/sm(4)/md(8)/lg(12)。
- **唯一豁免字面量**:modal 遮罩 scrim 现无产品 token,暂用 `rgba(0,0,0,.5)`(深浅主题同值);primitives 提供 mask/scrim token 后立即替换——除此外零字面量。
- **实现形态**:CSS 为纯文本字符串 → 禁嵌套语法;选择器平铺,前缀 `.eso-set-`(与看板 `.eso-tb-*` 平行,互不覆盖)。
- **不用媒体查询**:宽度由宿主 slot 决定(640–900px 单列流),一套字号全程不换档。
- **弱化不靠透明度**:shadowed/disabled 弱化一律用语义色阶(label-tertiary/quaternary)与字重,不用 opacity 叠加(现 `.eso-dedup-member.shadowed{opacity:.55}` 与 `.eso-file-row.disabled{opacity:.5}` 均废除)。
- react 为唯一外部依赖;StateDot 基元优先复用(见 §3.2 回退规则)。

### Token 映射表(唯一的取值来源,与任务板同表扩展)

| 语义 | Token |
|---|---|
| 页面底(设置页根/工具条/弹窗遮罩之上) | `--dsw-alias-bg-base` |
| 卡片底(来源行/去重组/弹窗/自定义专家行) | `--dsw-alias-bg-layer-1` |
| 弱底(徽标/chip/错误条/骨架条) | `--dsw-alias-fill-l1`(次选 `--dsw-alias-fill-l2`) |
| 边线 默认/hover/激活 | `--dsw-alias-border-l1` / `-l2` / `-l3` |
| 文字 强/正文/弱/最弱 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-quaternary` |
| accent 交互(hover、链接、switch on、focus 环) | `--dsw-alias-interactive-bg-hover-accent`、`--dsw-alias-link`、`--dsw-alias-interactive-bg-hover` |
| 状态图形 | `--dsw-alias-state-idle-primary`、`state-business-primary`、`state-success-primary`、`state-error-primary`、`state-error-secondary`、`state-warn-primary` |
| 警示文本 | `--dsw-alias-state-warn-label`(扫描命中/软删提示等 warn 小字专用) |
| **危险文本(danger-label)** | primitives 现无 `state-danger-label`;**映射与回退**:红字状态首选 `--dsw-alias-state-error-primary` 作文字色,双主题逐一验收 ≥4.5:1;任一主题不达标 → 回退组合「6px `state-error-primary` 状态点 + 文字 label-primary」(红点保语义,文字保对比),禁止改用 warn 系 |
| 反白(无) | 设置页不使用反白徽标(对比任务板 running 计数徽标,本页无该元素) |
| 骨架 | `--dsw-alias-bg-skeleton` |
| 遮罩 | `rgba(0,0,0,.5)`(唯一豁免,见上) |
| 圆角 | `--dsw-radius-xs / sm / md / lg` |

字号阶(全页统一):11 / 12 / 13 / 14px;字重 400 / 500 / 600;行高 15 / 17 / 18 / 20px。
对应关系:14px=页头主标;13px=区块标题/行内名称;12px=正文/表单/按钮/状态;11px=徽标/chip/辅助。
间距基数 4px,只用 4 / 6 / 8 / 12 / 16;区块之间 16px + 1px border-l1 分隔(沿用现 eso-section 的 border-top 结构)。

---

## 1. 页面骨架

```
┌ .eso-set-root(bg-base · padding 16px · 单列 flex · gap 16px · font-size 12px 基准) ┐
│ ① 页头 .eso-set-header(高 36px,sticky 可省——页不长,不做 sticky)                 │
│ ② 页级描述 .eso-set-desc(12px label-secondary)                                   │
│ ③ 页级错误条/操作回执 .eso-set-alert / .eso-set-notice                           │
│ ② 推荐配置区 → ③ 冲突区(条件渲染) → ④ 来源列表 → ⑤ 自定义专家区                  │
│ → ⑥ 去重组区(条件渲染) → ⑦ 镜像前缀区 → ⑧ 添加来源区                             │
│ ⑨ 四个确认弹窗(Portal 内 fixed,见 §8)                                           │
└───────────────────────────────────────────────────────────────────┘
```

- 页面底色 `bg-base`,不做页级卡片包裹;每个区块自身是卡片(layer-1)或无底分区,与看板「拒绝灰底拼盘」同原则。
- 区块统一样式 `.eso-set-section`:border-top 1px border-l1 + padding-top 12px(首个区块无 border-top)。
- 900px 宽上限下内容不再拉伸:来源行/表单行 max-width 100%,textarea 与输入框全宽;不设内容居中容器(与任务板全屏 1440 居中不同,宿主 slot 已限宽)。

### ① 页头

- 布局 flex,gap 8px,align center:主标 h3 14px/600 label-primary(插件名,超长省略)——副标 11px/400 label-tertiary「专家来源管理」——spacer——「重新加载」按钮(§7 按钮规格)。
- 副标与主标基线对齐;margin-left 8px;不换行。
- 描述行 `settings.desc` 独立一行,12px/400 label-secondary。

### ③ 页级反馈(错误条 / 回执)

- **错误条** `.eso-set-alert`(role=alert 保留):高自适应(单行 28px)、bg fill-l1、radius-sm、padding 4px 12px、gap 8px;内容 = 6px `state-error-primary` 圆点 + 12px label-secondary 错误文本(pre-wrap)。**废除现红底红字红边**(防与行内红字状态双红,与任务板错误条同构);`white-space:pre-wrap` 保留。
- **回执** `.eso-set-notice`(aria-live=polite 保留):min-height 20px,11px label-tertiary;无底无边,不做 toast、不做淡入动效。

---

## 2. 推荐配置区(预览流)

- 区块头:标题 13px/600 label-primary「推荐配置」+ 描述 12px label-secondary;右上「应用推荐配置」按钮(默认态)。
- 应用点击后不改行内布局——预览完全在弹窗完成(§8.3),区块内无第二形态。
- 应用中(busy):按钮 disabled;描述行右侧出现 11px label-tertiary 文案「正在应用推荐配置…」(复用 rec.applying 词条,不新增 spinner)。

## 3. 来源列表

### 3.1 来源行解剖

```
┌ .eso-set-row(bg layer-1 · border 1px border-l1 · radius-md · padding 10px 12px) ─┐
│ R1  [名称 13px/600 label-primary] —6px— [徽标×n] —6px— [upstream 链接 12px link,  │
│      截断 240px] —6px— [许可/版本 meta 11px label-tertiary]                      │
│ R2  margin-top 6px  [6px 状态点] —4px— [状态文字 12px/500] —8px—                 │
│      [statusDetail 11px label-tertiary] / [扫描命中徽标] / [跳过 symlink 徽标]    │
│ R3  margin-top 8px  [switch 启用] —6px— [下载 GitHub] [下载 CDN] [更新]          │
│      [▾ 文件列表（n）] —6px— [删除 danger 按钮]         (均 24px 高,详见 §7)      │
│ R4  展开区(仅 expanded):margin-top 8px · padding 8px 0 0 12px · border-left      │
│      1px border-l1(替代现 2px 左线) · 每行 24px,行间 4px                          │
└───────────────────────────────────────────────────────────────────────┘
```

- 行内主信息 `flex-wrap:wrap`(窄容器 640px 时 meta 换行可接受);行间垂直 gap 8px。
- **hover**:仅边线 border-l1 → border-l2(150ms);不用阴影、不用上浮。行不可整行点击(与看板不同,行内控件多,整行可点会误触)。
- **展开按钮**:文案保留「文件列表（n）」+ 前缀 ▸/▾ 字符(不改逻辑);`aria-expanded` 已有,保留。展开区文件行:
  - 文件路径 11px label-tertiary(word-break:break-all);专家名 12px/500 label-secondary;title 11px label-tertiary;
  - 「已停用」= 11px danger 文字映射(§0 token 表,见 §9 验收 2);「已遮蔽」「自定义」= 中性徽标;
  - 行级 switch 同 §7;custom 伪来源行整行置灰:名称 label-secondary、路径 label-quaternary、switch disabled + 尾部「在自定义专家区管理」11px label-tertiary。
- **禁用态语义**:`.eso-set-row[data-locked]`(builtin)仅隐藏不可用操作(现状已按条件渲染),不加视觉衰减;`[data-frozen]`(legacy)以 11px label-tertiary 提示「随包迁移，不可删除」。

### 3.2 来源状态 → 状态点/文字映射

| status | 状态点 | 状态文字 |
|---|---|---|
| ok | 实心 `state-success-primary` | 12px/500 label-secondary「正常」 |
| downloading | 实心 `state-business-primary` + 2s 脉冲(同任务板 running 规格:opacity 1→0.4→1 外圈光圈) | 12px/500 label-secondary「下载中…」 |
| verifyFailed | 实心 `state-error-secondary` | 12px/600 **danger 文字映射**「验签失败」 |
| scanRejected | 实心 `state-error-primary` | 12px/600 danger 文字「安全扫描拒绝」 |
| error | 实心 `state-error-primary` | 12px/600 danger 文字「出错」 |

- statusDetail 一律 11px/400 label-tertiary,独立一行,不参与红字。
- 「扫描命中：n 项」徽标:18px 高、radius-sm、底 fill-l1、11px/600 `state-warn-label` 文字 + 12px 同色警示图标(复用任务板阻塞徽标规格,它是本区块除状态点外唯一暖色);title 悬浮显命中明细(逻辑不变)。
- StateDot 若不接受自定义色/脉冲 → 自绘 6px 圆点回退(仅用上表 token),与任务板 §2.1 同规则。

### 3.3 徽标体系(全部 18px 高 · radius-sm · 底 fill-l1 · 11px)

| 徽标 | 文字色 | 字重 | 备注 |
|---|---|---|---|
| 内置 builtin | label-tertiary | 500 | title 提示不可停用/删除(逻辑不变) |
| 推荐 recommended | label-secondary | 600 | 不上色——彩色纪律只留状态/危险;600 字重即层级 |
| 自定义 custom | label-tertiary | 500 | |
| 分区 division | label-tertiary | 400 | custom 行内 |
| 当前代表 representative | label-secondary | 600 | 去重组内,可加 1px border-l2 区别于普通徽标 |
| 已遮蔽 shadowed | label-quaternary | 400 | |
| 扫描命中 | **state-warn-label** | 600 | 唯一暖色徽标(见 3.2) |

## 4. 跨源重名去重组

- 组容器 `.eso-set-dedup`:bg layer-1、border 1px border-l1、radius-md、padding 8px 12px、内部 gap 6px(与来源行同卡基)。
- 组头:规则徽标(§3.3 中性)+ spacer + 「恢复默认」文字按钮(11px `--dsw-alias-link`)。
- 成员行(高 24px,flex wrap,gap 6px):
  - 代表成员:名称 12px/600 label-primary + 来源徽标 + 「当前代表」徽标;
  - shadowed 成员:名称 12px/400 **label-tertiary** + 来源徽标 + 「已遮蔽」徽标 + 「设为代表」link 文字按钮(11px link);**废除 opacity:.55**;
  - 文件路径 11px label-tertiary break-all。
- 组间距 8px;组内成员间 4px。

## 5. 镜像前缀区 / 添加来源区

- **镜像前缀**:区块头(13px/600 标题 + 12px label-secondary 描述,默认前缀列表内联在描述尾部 11px label-tertiary);textarea `.eso-set-textarea`:全宽、min-height 72px、bg layer-1(废除 transparent——双主题下与页底拉开一层)、border 1px border-l1、radius-sm、padding 6px 8px、12px/400 label-primary;focus:border-l3 + 2px outline `--dsw-alias-link` offset 0(表单控件焦点环贴边);下方「保存镜像前缀」按钮。校验失败走页级错误条(逻辑不变)。
- **添加来源**:单行 flex gap 8px:输入框 `.eso-set-input`(同 textarea 底/边/焦点规格,高 28px、radius-sm、padding 4px 8px)+「添加」按钮;placeholder 11px label-quaternary。Enter 提交逻辑不变。

## 6. 自定义专家区

- 区块头:标题 13px/600 + 配额 `n / 200` 11px/500 label-tertiary tabular-nums(接近上限不加色;满员时配额文字转 **state-warn-label** 并以「删除后可新建」提示,「新建」按钮 disabled)。
- **列表态**:行规格同 §3.1 来源行(卡片基),行内容 = emoji + 名称 13px/600 + 徽标(自定义/分区)+ 字数 11px tertiary + slug 11px tertiary;操作 = switch + 「编辑」+「删除」(danger)。两步删除确认(§6.1)。
- **表单态**(customForm 展开时替换列表入口行,`aria-label` 不变):`.eso-set-form` 单列 gap 8px,卡内渲染(bg layer-1 容器):
  - 表单行 `.eso-set-form-row`:label 12px/500 label-secondary(min-width 140px)+ 控件(§5 输入规格);
  - prompt textarea rows=8、下方 11px label-tertiary 字数「提示词 n 字」(接近 20000 上限转 state-warn-label);
  - slug 只读行:值 12px label-tertiary;复制来源行:「复制自 …」11px tertiary;正文读取失败 11px danger 文字;
  - 底部动作区复用弹窗按钮排(右对齐 gap 8px):「取消」ghost +「保存」danger 确认钮(见 §7 按钮语义:表单保存即写操作,沿用现 eso-btn danger 形态)。
- 降级态(customExpertsError):11px danger 文字映射,role=alert 保留。

### 6.1 行内两步删除(来源行删除 / 自定义专家删除,同一规格)

- 第一步:「删除」danger 按钮;点击后原位换字「确认删除」+ 自定义专家行额外出现 11px `state-warn-label` 软删提示(词条不变);blur 复位逻辑不变。
- 「确认删除」态 = danger 按钮的 **filled 强调形态**:边框与文字同 danger token(§0 映射),底 fill-l1——不加新颜色,只加底。
- 视觉上无弹窗、无倒计时;这是现状交互,规格只定义其形态。

## 7. 控件规格(全页统一)

- **按钮** `.eso-set-btn`:高 24px、padding 0 10px、radius-sm、bg transparent、border 1px border-l1、12px/500 label-secondary;hover:边线 border-l2 + 文字 label-primary + 底 `interactive-bg-hover`(150ms);active:底 fill-l1;disabled:opacity .5(仅此一处允许 opacity,因 disabled 豁免对比度,但仍需可辨识,见 §9.4);`:focus-visible` 2px outline link offset 2px。
  - danger 变体 `.eso-set-btn[data-danger]`:边框/文字用 §0 danger 映射;hover 同上但底 fill-l1;用于删除/确认执行/确认安装/确认启用。
  - link 文字按钮 `.eso-set-linkbtn`:无边无底,11/12px `--dsw-alias-link`,hover 下划线;用于「恢复默认」「重置」类。
- **switch(替换原生 checkbox)**:28×16、radius-full;off = 底 fill-l2 + 12px 旋钮 label-quaternary;on = 底 `interactive-bg-hover-accent` + 旋钮 bg-base;disabled = opacity .5;`:focus-visible` 2px outline link offset 2px;`role="switch"` + `aria-checked` + 原 `aria-label` 全部保留(on 旋钮不发光不回弹,与任务板同规格)。实现可保留 input[type=checkbox] + 外观覆盖,以最小化逻辑改动。
- **输入框/textarea/select**:统一 §5 规格;select 同 input(高 28px,原生箭头保留);`max-width:320px` 的行内约束保留。
- **图标**:本页无图标按钮;命中徽标内 12px 警示图标为唯一图标。

## 8. 弹窗统一规格(四个确认弹窗 + 复用于表单动作排)

对齐现 `.eso-modal-*` 结构,全部 token 化:

- **遮罩** `.eso-set-modal-overlay`:fixed inset 0、z-index 1000、bg 遮罩 token(§0 豁免)、padding 16px、flex 居中;Escape 关闭逻辑不变。
- **弹窗** `.eso-set-modal`:max-width 440px、width 100%、bg layer-1、border 1px border-l2、radius-lg(12)、padding 16px;**废除 box-shadow**(层级靠遮罩 + border,与任务板 §8.4 一致;深色主题阴影发脏)。
- **标题** `.eso-set-modal-title`:13px/600 label-primary,margin 0 0 8px;风险类弹窗(ack/scan)标题前置 6px `state-error-primary` 圆点(红色语义唯一入口)。
- **正文** `.eso-set-modal-body`:12px/400 label-secondary,行高 17px,margin 0 0 12px;说明性小字(扫描/软删/镜像说明)11px label-tertiary。
- **清单** `.eso-set-modal-list`:max-height 180px overflow auto、12px label-secondary、word-break:break-all;扫描命中清单每项前置 4px `state-warn-primary` 方点;「另有 n 项未列出」11px label-tertiary。
- **动作区** `.eso-set-modal-actions`:右对齐 flex gap 8px、margin-top 4px;次按钮(取消)ghost、主按钮(确认执行/确认启用/确认安装/确认删除)danger 变体;`disabled=busy` 现状保留。
- 四弹窗差异仅内容:ack(风险说明+圆点标题)、scan(命中清单)、rec(三组清单:「将下载并启用/将启用/将停用」各为 11px tertiary 组题 + 条目列表;无变更时仅正文行)、remove(现有行内两步确认,**不在弹窗内**,保持 §6.1)。
- 弹窗不做入场缩放/淡入动效(见 §9 动效清单外一律禁止)。

## 9. 动效(全页仅 4 个,与任务板同口径)

| 动效 | 规格 |
|---|---|
| hover/press | 边线/底色 150ms ease(唯一可供性暗示) |
| 文件列表展开 | 高度过渡 200ms cubic-bezier(0.2,0,0,1),▾/▸ 同步切换 |
| 行状态变更 | 新快照渲染的行 opacity 0→1 150ms ease-out(不做位移) |
| downloading 状态点脉冲 | 2s 循环 opacity 1→0.4→1(同任务板 running) |

禁止:弹窗入场动画、徽标跳动、switch 回弹、阴影过渡、shimmer。`prefers-reduced-motion: reduce` → 过渡归 0、脉冲移除;`document.hidden` 暂停脉冲。

## 10. CSS 命名方案与迁移对照表

命名:`.eso-set-*` 前缀(与看板 `.eso-tb-*` 平行;两者并存于同一注入块,互不冲突)。状态钩子用属性不用类:`.eso-set-row[data-locked]`、`.eso-set-status[data-tone="danger"]`、`.eso-set-badge[data-kind="recommended"]`、`.eso-set-dedup-member[data-shadowed]`、`.eso-set-file-row[data-disabled]`、`.eso-set-btn[data-danger]`。

旧类名 → 新类名(实现者全局替换,DOM 结构与事件逻辑不动;`.eso-alert[role=alert]` 为死样式,随迁移删除):

| 旧 | 新 | | 旧 | 新 |
|---|---|---|---|---|
| .eso-panel | .eso-set-root | | .eso-btn.danger | .eso-set-btn[data-danger] |
| .eso-title | .eso-set-title | | .eso-toggle | .eso-set-switch |
| .eso-desc | .eso-set-desc | | .eso-section | .eso-set-section |
| .eso-toolbar | .eso-set-header | | .eso-section-title | .eso-set-section-title |
| .eso-spacer | .eso-set-spacer | | .eso-subtitle | .eso-set-subtitle |
| .eso-error | .eso-set-alert | | .eso-dedup | .eso-set-dedup |
| .eso-notice | .eso-set-notice | | .eso-dedup-head | .eso-set-dedup-head |
| .eso-conflicts | .eso-set-conflicts | | .eso-dedup-member | .eso-set-dedup-member |
| .eso-conflicts-title | .eso-set-conflicts-title | | .eso-dedup-member.shadowed | [data-shadowed] |
| .eso-list | .eso-set-list | | .eso-dedup-file | .eso-set-path |
| .eso-row | .eso-set-row | | .eso-hint | .eso-set-hint |
| .eso-row-main | .eso-set-row-main | | .eso-textarea | .eso-set-textarea |
| .eso-name | .eso-set-name | | .eso-input | .eso-set-input |
| .eso-badge | .eso-set-badge | | .eso-add | .eso-set-add |
| .eso-badge.rec/.rep | [data-kind] | | .eso-modal-overlay | .eso-set-modal-overlay |
| .eso-link | .eso-set-link | | .eso-modal | .eso-set-modal |
| .eso-meta | .eso-set-meta | | .eso-modal-title | .eso-set-modal-title |
| .eso-status | .eso-set-status | | .eso-modal-body | .eso-set-modal-body |
| .eso-status.red | [data-tone="danger"] | | .eso-modal-actions | .eso-set-modal-actions |
| .eso-status-detail | .eso-set-status-detail | | .eso-modal-list | .eso-set-modal-list |
| .eso-actions | .eso-set-actions | | .eso-form | .eso-set-form |
| .eso-btn | .eso-set-btn | | .eso-form-row | .eso-set-form-row |
| | | | .eso-form-label | .eso-set-form-label |
| | | | .eso-files | .eso-set-files |
| | | | .eso-file-row(.disabled) | .eso-set-file-row([data-disabled]) |

颜色债清零对照(实现时逐项删除字面量):`#e5484d`×4 处 → danger 文字映射/状态点 token;`rgba(229,72,77,.08/.45)` → fill-l1/alert 重构;`#fff`+`#1f2328`(modal) → layer-1 + label token;全部 `rgba(128,128,128,*)` 边线 → border-l1/l2;`.eso-modal` 的 box-shadow → 删除。

## 11. 深浅主题对比度验收清单(实现后逐条验收;1–8 沿用任务板口径,9–14 为设置页特有)

1. **12px 正文**(desc/statusDetail/hint,label-secondary)在 layer-1 上双主题 ≥4.5:1;不达标升 label-primary。
2. **danger 红字状态**(verifyFailed/scanRejected/error/已停用/降级提示):`state-error-primary` 作 12px/600 文字在 layer-1 上双主题 ≥4.5:1;任一不达标 → 回退「error 状态点 + label-primary 文字」(§0 映射),禁止 3:1 放行红字。
3. **11px 徽标文字**(内置/推荐/自定义/已遮蔽,label-tertiary/quaternary)允许 ≥3:1;但名称/状态文字永不降到 tertiary 以下;「推荐」「当前代表」(600 字重)≥3:1。
4. **disabled 控件可辨识**:按钮/switch disabled 态(opacity .5)与可用态在双主题下肉眼可区分(border 残留 ≥3:1 或形态差异);custom 置灰行不整行 opacity,逐文字换色阶。
5. **无投影**:全页含弹窗零 box-shadow;层级靠 border + 三层底色。
6. **状态点非文本图形**(WCAG 1.4.11):各状态色相对 layer-1 ≥3:1;error 系浅色底不达标时用 `state-error-secondary` 顶替并保留文字语义。
7. **焦点环双主题可见**:2px `--dsw-alias-link` outline(+2px offset;表单控件 offset 0)任何主题不得消失。
8. **hover accent 不与选中混淆**:`interactive-bg-hover` hover 底 vs fill-l1 徽标底/确认删除 filled 态,双主题可区分。
9. **warn 徽标文字**「扫描命中：n」「确认删除」软删提示必须用 `state-warn-label`(为文本设计),禁止 warn-primary 作文字。
10. **danger 按钮**(删除/确认执行)边框与文字 = danger 映射 token,在 layer-1 与 fill-l1 两种底上双主题 ≥4.5:1(文字);不达标同规则 2 回退(点 + label-primary 文字 + border-l2)。
11. **表单控件在 layer-1 上自证**:输入框/textarea 底改 layer-1 后,与所在卡片(同为 layer-1)必须靠 1px border-l1 区分出可编辑区域;深色主题重点验收(border 不可见即回归)。
12. **shadowed 成员**(label-tertiary)≥3:1 且永不 quaternary 以下用于名称;slug/路径允许 quaternary ≥3:1。
13. **scrim 上的弹窗文字对比**按弹窗自身底色(layer-1)计算,遮罩不参与;scrim 下页面内容不要求达标。
14. **switch 双态可辨**:off(fill-l2 + 旋钮 quaternary)vs on(accent 底)双主题亮度差可感知;深色主题 off 态旋钮不得消失。

—— 完 ——
