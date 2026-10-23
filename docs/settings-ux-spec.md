# 插件设置页 — 信息架构与交互规格

> 版本 v1.0 · 设计文档（只规划不实现） · 载体：宿主插件菜单设置页
> slot 固定 `plugins.bundle.config`：容器宽约 640–900px，无路由、单页滚动，不可开右侧栏。
> 交互语言沿用 `docs/taskboard-sidebar-ux-spec.md`（渐进披露 / 键盘最小集 / 空态三件套 / §8 双语文案表格式）。
> 现状权威：`lib/client.js:909-1600`（ExpertSourcesSettings）与 `lib/client.js:330-354`（Remote 方法面）。

---

## 0. 设计原则（决策依据）

1. **单列扫视**：容器窄（640–900px），分区纵向堆叠是唯一自然布局；任何两栏方案直接排除。
2. **高频 ≤2 步**：启停某来源、应用推荐配置两条最高频路径必须在 2 步内完成（点击开关即第一步；确认门是安全必需的第二步，且仅对第三方启用出现一次）。
3. **只重组不删功能**：8 组功能全集保留（清单见 §1.2），Remote 方法面（`getSources/addSource/removeSource/setSourceEnabled/downloadSource/updateSource/setMirrorPrefixes/setDedupChoice/clearDedupChoice/saveCustom/deleteCustom/getCustom/setExpertEnabled`，乐观锁 `expectedRevision` 在 host 侧）语义不变。
4. **风险梯度确认**：不可逆 / 供应链风险操作走弹窗（alertdialog）；轻量可恢复操作走行内两步（danger 按钮二击）。层级见 §4。
5. **busy 单通道**：全局单一 `busy` 布尔（现有 mutate 通道语义保留），busy 期间所有写入口禁用，反馈收敛到顶部 notice/error + 来源行状态徽章，不引入 toast 队列。

---

## 1. 信息架构

### 1.1 布局选型：单列滚动 + 锚点分区

**候选方案**

- A. 分区导航（tab/侧栏锚点导航 + 分区切换）
- B. 单列分区渐进披露（所有分区纵向排列，常显，锚点跳转辅助）
- C. 折叠组（accordion，每分区默认折叠、组头常显）

**评价**

- 方案 A（tab 导航）：容器本身是宿主的"设置页"tab，内层再分 tab 会造成双重视觉层级；且 tab 隐藏了跨区关联（例如去重组与来源行 shadowed 徽章互为印证、conflicts 与 dedup 语义相邻），扫视成本上升。排除。
- 方案 C（折叠组）：内容量中等（来源数典型 3–6 行，自定义专家典型 0–10 行），全折叠时"找东西要先展开"反而加一步，违背高频 ≤2 步；折叠只在某一区超长时有益（见结论的局部折叠）。
- 方案 B（单列滚动）：与宿主"单页滚动"约束同构；用户在任务板侧栏规格中已被训练为"纵向扫读 + 渐进披露"心智。

**结论：采用 B —— 单列滚动 + 顶部锚点分区条**

- 顶部固定一条轻量锚点导航（推荐 · 来源 · 去重 · 自定义 · 镜像 · 添加），点击平滑滚动到对应分区（200ms，`prefers-reduced-motion` 时直接跳变）；**仅当对应分区存在时显示该锚点**（如无去重组/无冲突则不渲染其锚点）。
- 仅一处局部折叠：**来源行的专家文件列表**（disclosure，每行独立展开，非手风琴单开——用户常需对照两个来源的文件清单排查重名）。其余分区常显。
- 页面滚动时锚点条不高亮跟踪（scroll-spy 是锦上添花，v1 不做，保持简约）。

### 1.2 分区顺序与信息架构（8 组功能 → 6 分区 + 1 条全局反馈带）

| 序 | 分区（锚点） | 覆盖功能组 | 排序理由 |
|---|---|---|---|
| 0 | 页头 | ①页头+副标+重新加载 | 插件名为主标题（现状沿用），副标「专家来源管理」 |
| 1 | 推荐配置 | ②推荐配置预览流 | 一次性引导动作用户最先看到；完成后信息密度低不占视觉重心 |
| 2 | 来源列表 | ③来源行全集（徽标/状态/启停/下载/更新/删除/展开文件） | 核心管理区，条目最多 |
| 3 | 跨源去重 | ④去重组（代表选择/shadowed/规则标签）+ 跨源重名专家 conflicts 列表 | 与来源行的 shadowed 徽章语义联动，紧跟来源区；无组时整区隐藏 |
| 4 | 自定义专家 | ⑦新建/编辑表单、启停、两步删除、上限 200 | 自有写路径的第二管理区 |
| 5 | 镜像前缀 | ⑤textarea + 保存 | 低频配置，靠后 |
| 6 | 添加来源 | ⑥添加输入框 | 入口型动作收尾，符合"从管理到扩展"的心理动线 |
| — | 全局反馈带 | ⑧四个确认弹窗 + notice/error | 弹窗覆盖层不属于滚动流；notice/error 固定在锚点条之下（aria-live） |

- 锚点词条复用现有分区标题（`rec.title` / `dedup.title` / `custom.title` / `mirrors.title` / `add.title`），来源区锚点用 `settings.subtitle`；不新增分区命名，减少文案表增量。

### 1.3 高频路径 ≤2 步验证

| 高频路径 | 步骤 |
|---|---|
| 启停某来源 | 点行内 switch（第 1 步）。内置/已确认过的来源到此完成；**仅第三方来源首次启用**弹确认门（第 2 步，确认后同类来源不再重复弹——是否"已确认"由 host ackRisks 机制裁决，UI 不记忆）。停用永远 1 步。 |
| 推荐一键配置 | 点「应用推荐配置」（第 1 步）→ 预览弹窗点「确认执行」（第 2 步）。无变更时预览直接显示"已符合推荐"，确认钮禁用，零误操作。 |
| 添加来源 | 粘贴 URL + Enter（或点「添加」）＝ 1 步。 |
| 更新某来源 | 点「更新」（1 步；仅扫描命中时追加确认门）。 |

---

## 2. 全局状态机（组件级）

```
[loading] ──getSources 成功──▶ [ready]
    │                             │
    └─失败─▶ [loading+error] ─重试─┘
[ready] ─任意写入口─▶ [busy] ─成功→ accept(快照)+notice ─▶ [ready]
                        │
                        ├─确认门标记(ackRisks/ackScan)─▶ [ready+弹窗]（快照不采纳或部分采纳）
                        │
                        └─失败→ error + getSources 快照刷新 → [ready]（行内状态取 host 侧最新）
```

- **loading**：`settings.loading` 提示 + 骨架可省（条目少，文字提示足够，保持简约）；失败时 error（`role=alert`）+「重新加载」按钮（复用页头 reload）。
- **busy**：单一布尔。所有写入口（按钮/switch/select/提交）`disabled={busy}`；页头「重新加载」同样禁用。反馈三通道：① 触发行的状态徽章（`status.downloading` 等，host 驱动）② 顶部 notice（`aria-live=polite`）③ 按钮 disabled 本身。**不做**全局 spinner 遮罩——遮盖上下文且与行级状态重复。
- **乐观锁冲突**（host 返回 `conflict` 类 Error）：按普通失败路径处理——error 提示 + 失败后快照刷新（现状 `mutate` 的 catch 已实现 `remote.getSources()` 回拉），刷新后 revision 取最新，用户重试即可成功。文案沿用 `custom.err.conflict`（通用化为全局冲突提示，见 §8 词条改动说明）。
- **错误恢复（快照刷新）**：所有写失败路径统一 `refreshAfterError`：`getSources()` 成功则 `accept` 新快照（行状态/statusDetail 与 host 对齐），快照刷新失败则保留原 error 提示。notice 在新错误出现时清空，避免旧成功消息与新错误并置。
- **空态**：来源列表空 → `sources.empty`（指引添加）；自定义专家空 → `custom.empty`（指引新建）；去重组空 → 整区不渲染（非空才出现，同任务板"异常泳道非空置顶"逻辑）；conflicts 空 → 不渲染。

---

## 3. 逐区块交互规格

### 3.1 页头（功能组①）

- 左：`settings.title`（插件名，H3）+ `settings.subtitle`（副标）；右：「重新加载」按钮。
- 重新加载 = 只读 mutate（`getSources`），成功不给 notice（无变化提示是负资产，沿用现状空 okMessage）。

### 3.2 推荐配置预览流（功能组②）

状态机：`idle →（点应用）→ preview（弹窗）→ 确认 → applying（busy）→ done / error`。

- 预览弹窗（`rec.previewTitle`）内容 = 现状计划三类：`willDownload` / `willEnableOnly` / `willDisable`，空列表类不渲染；全空显示 `rec.noChanges` 且确认钮禁用。`recommendedNote` 有则尾部透出（`rec.noteLabel`）。
- 确认后批量执行链（沿用现状）：以最新快照 revision 起链，逐推荐来源 `downloadSource(github, ackScan:false)` → 扫描命中自动 `ackScan:true` 重发并计数（**不再逐个弹窗**，命中明细保留在来源行）→ `setSourceEnabled(true, ackRisks:true)`；再逐非推荐来源 `setSourceEnabled(false, ackRisks:true)`。builtin 与 custom 伪来源恒跳过。
- 任一步失败即中断：error + 快照刷新；`rec.doneScan` 透出扫描命中计数。
- busy 期间预览入口与弹窗两钮禁用；预览中 Esc/取消即丢弃计划（无副作用）。

### 3.3 来源列表（功能组③）

**行解剖（收起态一行）**：名称 + 徽标组（builtin / recommended / custom / legacy 冻结提示）+ upstream 链接 + license/版本 meta + 状态徽章（`role=status`，含 statusDetail、扫描命中计数、跳过符号链接计数）+ 操作区。

**状态机（行级）**：

```
[idle] ─启停/下载/更新/删除─▶ [busy(行级复用全局 busy)]
  下载/更新中: status=downloading（host 驱动，行级持久）
  终态异常: verifyFailed / scanRejected / error + statusDetail（红）
  正常: ok
```

- `downloading = status==='downloading' || busy`；该行全部写操作禁用（沿用现状 `disabled: downloading`）。**其他行**仅受全局 busy 禁用（按钮 disabled），状态徽章仍可读——busy 是全局互斥，但不冻结信息展示。

**操作规格**：

| 操作 | 触发 | 确认层级 | 成功反馈 |
|---|---|---|---|
| 启停 switch | 点 switch | 启用第三方（非 builtin）→ ack 确认门弹窗（`ackRisks:false` 首发探测，确认后 `true` 重发）；停用/内置直接执行 | `sources.enabledDone` / `sources.disabledDone` |
| GitHub 下载 | 点按钮 | 无预确认；扫描命中 → 扫描确认弹窗（`ackScan:false` 首发探测） | `sources.downloadStarted` |
| CDN 下载 | 点按钮 | 同上 | 同上 |
| 更新 | 点按钮 | 同上（channel=cdn，沿用现状） | `sources.updateStarted` |
| 删除 | danger 按钮二击（行内两步：首击变「确认删除」，再击执行；失焦复位） | 行内两步 | `sources.removed` |
| 展开文件列表 | disclosure 按钮 `▾/▸` + 计数 | 无 | — |

- **行展开行为**：每行独立 disclosure（`aria-expanded`/`aria-controls`），非手风琴；同一时刻可多行展开（排查重名需对照）。切换来源行展开不关闭其他行。展开区 = 文件清单：路径（等宽）+ 名称/title + 徽章（已停用红 / shadowed / custom）+ per-file 启停 switch（`setExpertEnabled`）；custom 伪来源行整体置灰，文件行开关禁用并显示 `custom.manageHint`（管理走自定义专家区）。
- **徽标语义**：`sources.builtin`（title=builtinHint，不可停用/删除）；legacy 来源（`sources.legacyHint`）可停用但删除入口冻结（按 id 冻结，与 host 拒绝一致）；recommended 徽标与去重 shadowed 徽章颜色区分。
- **删除可用性**：`removable = !builtin && !legacy && !custom伪来源`，与 host `removeSource` 拒绝面一致，UI 不提供会被拒绝的入口。

### 3.4 跨源去重组（功能组④）

- 每组一张卡：头 = 规则标签（`dedup.rule.*`，未知规则原样透出不猜测）+「恢复默认」（`clearDedupChoice`）。
- 成员行：名称 + 来源徽标 + title + 文件路径 + 代表徽章（`dedup.representative` 高亮）或 shadowed 徽章（弱化样式）。非代表成员有「设为代表」（`setDedupChoice`）。
- 交互：选代表 / 恢复默认均走 mutate（1 步，无确认——可随时再改，低风险）；成功 notice `dedup.done` / `dedup.cleared`。
- **conflicts 子区**（未消解重名）：dedup 组下方列出 unresolved 冲突（`conflicts.item`），纯只读展示 + `conflicts.classes` 说明三分类过滤规则；resolved-by-dedup 与 basename-only 不出现。
- 整区（含 conflicts）仅在快照有数据时渲染，锚点条同步隐藏。

### 3.5 镜像前缀（功能组⑤）

- textarea 逐行一个前缀；说明行含默认值透出（`mirrors.default`）。
- 本地校验：保存时逐行 `^https?:\/\//` 检查，不过 → error `mirrors.invalid`，**不发起请求**（快照不动）。
- 保存 = mutate（`setMirrorPrefixes`），成功 `mirrors.saved`。
- **脏态提示（新增）**：textarea 内容 ≠ 快照值时，保存钮从 disabled(busy) 之外的常态变为强调态，旁边灰字「有未保存的更改」；不做离开页面拦截（宿主容器无路由钩子，且输入无破坏性）。
- v1 不做逐行增删 UI（textarea 是现状语义，保留）。

### 3.6 添加来源（功能组⑥）

- 输入框 + 「添加」按钮；Enter 提交与按钮提交同路径。
- 本地短路校验 `looksLikeSourceUrl`，不过 → error `add.invalid`，不发请求。
- 成功：`add.success` + 快照刷新（mutate 返回快照）+ 清空输入框。新来源以未安装状态出现在来源列表（用户需再点下载——在 `add.success` 文案中已说明）。

### 3.7 自定义专家（功能组⑦）

- 区头：标题 + 配额 `n / 200`；满员时「新建」禁用 + `custom.limitReached` 提示。
- **表单**（新建/编辑共用，替换区工具条，收起态=列表）：name(≤40) / description(≤160) / prompt(textarea ≤20000) / division(可选 ≤64) / emoji(可选 ≤16) / enabled switch；编辑态顶部只读 slug。本地只做非空短路，精确校验归 host（Error.key → `custom.err.*` 双语分支）。
- **复制预填**：工具条「来源专家」select（分组按来源）+「从来源专家复制」→ 表单预填元数据，异步 `getExpertContent` 读正文填 prompt（loading 提示 `custom.copyLoading`；失败 `custom.copyFailed`，表单保留可手填）。
- **行内启停**：switch → `getCustom` 取详情 → `saveCustom(enabled 翻转)`（custom 伪来源对 `setExpertEnabled` readonly，UI 不发起）。busy 期间禁用。
- **删除**：danger 按钮二击（行内两步，首击旁现软删除提示 `custom.deleteSoftHint`）；`deleteCustom` 为软删除（同 slug 可重建恢复）。成功 `custom.deleted`。
- **降级态**：`customExpertsError` 非空 → 区头下红色 `role=alert` 降级提示，列表不渲染但表单/新建仍可用（host 侧错误按快照恢复）。
- quota `n/200` 上限为 `CUSTOM_QUOTA_MAX`，与 host `limit` 错误双保险。

### 3.8 四个确认弹窗（功能组⑧，统一规格）

| 弹窗 | 触发 | 关键内容 | 确认动作 | 取消动作 |
|---|---|---|---|---|
| 启用第三方确认（ack） | 第三方来源启用探测命中确认门 | 风险说明（自动扫描≠安全审查） | `setSourceEnabled(true, ackRisks:true)` | 关闭 + notice「已取消启用，来源保持停用」 |
| 下载扫描确认（scan） | 下载/更新探测命中扫描规则 | sha256 已验签声明 + 命中明细（前 10 条 + `…另有 {count} 项`） | `downloadSource/updateSource(ackScan:true)` | 关闭 + notice「已取消，本次下载未安装」 |
| 推荐配置预览（rec） | 点「应用推荐配置」 | 三类计划清单 + note；空计划确认钮禁用 | 批量执行链（§3.2） | 丢弃计划，无副作用 |
| 来源删除确认（remove） | 来源行删除二击 | ——（现状为行内两步，无弹窗） | `removeSource` | 失焦/再点复位 |

- **统一弹窗规格**：overlay 点击不关闭（风险确认不允许误关）；Esc 关闭 = 取消；取消钮 `autoFocus`（安全默认在取消侧）；确认钮 danger 样式 + busy 禁用；`role=alertdialog aria-modal=true aria-labelledby=标题 aria-describedby=正文`。
- 弹窗打开时全局 busy 保持互斥（探测请求已结束但用户裁决期间其他写入口仍禁用——`ackPending/scanPending/recPending` 非空时视为逻辑 busy 的延伸，v1 沿用现状实现：确认门存在期间 busy 已释放，但弹窗 overlay 阻断下层交互，语义等价）。
- 弹窗互斥：同一时刻最多一个确认门（现状三个 state 互斥由触发顺序天然保证；规格上约定后打开者关闭前者）。

---

## 4. 危险操作确认层级（决策表）

| 操作 | 不可逆？ | 供应链风险？ | 层级 | 理由 |
|---|---|---|---|---|
| 启用第三方来源 | 否（可停用） | **是**（persona 入上下文） | **弹窗**（ack） | 风险知情确认需要完整句子，行内两步放不下 |
| 下载/更新（扫描命中） | 否 | **是** | **弹窗**（scan） | 命中明细是结构化清单，需列表排版 |
| 推荐批量执行 | 间接（批量停用） | 是（含下载） | **弹窗**（rec 预览） | 批量影响面必须先可见 |
| 删除来源 | **是**（需重新下载） | 否 | **行内两步** | 后果单一明确，二击足够；弹窗会增加打断感 |
| 删除自定义专家 | 软删除（可恢复） | 否 | **行内两步** | 可恢复 → 最低层级；首击旁现软删除说明 |
| 恢复默认代表 / 设为代表 | 否（随时可改） | 否 | 无确认 | 低风险高频微调 |
| 保存镜像前缀 | 否 | 否 | 本地校验，无确认 | 校验失败不落盘 |

原则：**弹窗只给"风险知情"与"批量影响面"，行内两步给"不可逆但单一"，其余靠校验与可逆性兜底。**

---

## 5. 无障碍与键盘（最小集）

- **焦点管理（弹窗）**：打开 → 焦点移入弹窗（取消钮，`autoFocus`）；Tab 循环限制在弹窗内（focus trap：Tab/Shift+Tab 在首尾元素间循环）；关闭 → 焦点还原到触发元素（启停 switch / 下载钮 / 推荐钮）。Esc = 取消并还原焦点。
- **aria**：
  - 弹窗：`role=alertdialog` + `aria-modal` + labelledby/describedby（沿用现状）。
  - 启停：`role=switch`（或 checkbox+switch 语义），`aria-label` = `sources.toggle {name}`（沿用）；`aria-checked` 反映状态。
  - 行展开：`button[aria-expanded]` + `aria-controls`（disclosure pattern），展开区 `role=region` + `aria-labelledby` 指向展开按钮。
  - 状态徽章：`role=status`（沿用）；行内错误/全局错误 `role=alert`；notice 带 `aria-live=polite`（沿用）。
  - 锚点导航：`nav[aria-label=页面分区]`；只读徽章（builtin 等）title 提示进 accName 补充。
- **键盘最小集**：
  - **Tab**：顺序 = 视觉顺序（页头 → 推荐钮 → 锚点条 → 各分区交互元素 → 弹窗 trap）；全部功能 Tab 可达，无键盘陷阱。
  - **Esc**：关弹窗（=取消）；收起当前聚焦的展开行（焦点回 disclosure 按钮）。
  - **Enter**：添加来源输入框 Enter 提交（沿用）；自定义表单 Enter 提交（form submit，沿用）；disclosure 按钮 Enter/Space 切换。
  - v1 不做 ↑/↓ roving（列表短，Tab 已够；与任务板"规模自觉"同理由）。
- **视觉**：状态五值（ok/downloading/verifyFailed/scanRejected/error）= 颜色 + 文字徽章双通道（现状已有文字，不依赖颜色）；焦点环 2px 高对比；`prefers-reduced-motion` 时锚点平滑滚动改直接跳变。文本对比度 ≥ WCAG 2.1 AA（亮/暗两套 token 均过检）。

---

## 6. 空态三件套

| 态 | 触发 | 文案（沿用词条） | 动作 |
|---|---|---|---|
| 加载态 | 快照未返回 | `settings.loading` | — |
| 来源空 | sources 为空 | `sources.empty`（指引添加） | 锚点/滚动到添加区 |
| 自定义专家空 | customExperts 空 | `custom.empty` | 「新建」按钮就在同区，无需额外引导 |
| 去重/conflicts 空 | 无组/无冲突 | 整区不渲染（锚点同步隐藏） | — |
| 加载失败 | getSources 拒绝 | `status.error` + detail | 「重新加载」 |

---

## 7. 中英文案对照（zh / en）

> 格式沿用 taskboard-sidebar-ux-spec §8。**现有词条尽量复用，标注「沿用」**；仅列新增/改动。

### 7.1 沿用词条（节选全集索引，实现时以 `lib/client.js:359-486` zh 表为准）

`settings.title / settings.subtitle / settings.desc / settings.reload / settings.loading / sources.* （含 empty/builtin/builtinHint/legacyHint/license/version/notInstalled/toggle/enable/removeToggle/downloadGithub/downloadCdn/update/remove/removeConfirm/removed/enabledDone/ackTitle/ackBody/ackConfirm/ackCancel/ackCancelled/disabledDone/scanTitle/scanBody/scanConfirm/scanCancel/scanCancelled/scanFindingsTitle/scanMore/scanHits/skippedSymlinks/downloadStarted/updateStarted） / rec.* （title/desc/apply/applying/previewTitle/willDownload/willEnableOnly/willDisable/noChanges/noteLabel/scanHint/confirm/cancel/done/doneScan/recommended） / dedup.* （title/desc/rule.*/representative/shadowed/setChoice/clearChoice/done/cleared） / status.* （idle/downloading/verifyFailed/scanRejected/error/ok） / conflicts.* （title/desc/item/classes） / mirrors.* （title/desc/save/saved/default/invalid） / add.* （title/placeholder/submit/success/invalid） / custom.* （title/empty/desc/quota/new/copy/copyPick/copyFrom/copyLoading/copyFailed/edit/delete/deleteConfirm/deleteSoftHint/deleted/saved/toggled/done/form.*/limitReached/disabledBadge/badge/manageHint/promptLength/err.*） / files.toggle / files.empty`

en 侧逐 key 对齐（zh 为 key 集真相源），不在此重复。

### 7.2 新增 / 改动词条

| Key | zh | en | 说明 |
|---|---|---|---|
| `nav.label`（新增） | 页面分区 | Page sections | 锚点导航 nav aria-label |
| `nav.sources`（新增） | 来源 | Sources | 来源区锚点文字（区别于副标「专家来源管理」的短形式） |
| `nav.recommended`（新增） | 推荐 | Recommended | 锚点短形式（复用语义，文字与 `rec.title` 一致亦可，独立 key 便于缩短） |
| `nav.dedup`（新增） | 去重 | Dedup | 锚点短形式 |
| `nav.custom`（新增） | 自定义 | Custom | 锚点短形式 |
| `nav.mirrors`（新增） | 镜像 | Mirrors | 锚点短形式 |
| `nav.add`（新增） | 添加 | Add | 锚点短形式 |
| `mirrors.dirty`（新增） | 有未保存的更改 | Unsaved changes | textarea 脏态提示 |
| `settings.conflictGeneric`（改动） | 状态冲突：页面数据已过期，已刷新，请重试。 | State conflict: page data was stale and has been refreshed. Please retry. | 乐观锁冲突通用文案（原 `custom.err.conflict` 语义泛化为全局；`custom.err.conflict` 保留给自定义专家区） |
| `sources.expandHint`（新增） | 展开 {name} 的专家文件 | Toggle expert files of {name} | disclosure aria-label（现有按钮文字 `files.toggle` 保留为可见文字） |

---

## 8. 决策速查（One-line decisions)

1. 布局 = 单列滚动 + 顶部锚点分区条（无 tab、无全折叠）；仅来源文件清单做行级 disclosure。
2. 分区顺序：页头 → 推荐 → 来源 → 去重（含 conflicts）→ 自定义专家 → 镜像 → 添加；空区整区隐藏。
3. 高频路径验证：启停 1–2 步、推荐 2 步、添加 1 步、更新 1 步。
4. 确认层级：风险知情/批量影响面 → 弹窗（ack/scan/rec）；不可逆单一后果 → 行内两步（删除来源/自定义专家）；低风险可逆 → 无确认。
5. busy = 全局单通道（沿用 mutate 语义），写入口全禁用，反馈走行状态徽章 + notice/error 三通道，无 spinner 遮罩。
6. 乐观锁冲突 = 失败路径统一快照刷新（getSources 回拉），文案 `settings.conflictGeneric`，用户重试即可。
7. 弹窗统一：alertdialog + focus trap + 焦点还原 + 取消侧 autoFocus + Esc=取消；overlay 点击不关。
8. 键盘最小集：Tab 视觉序、Esc 关弹窗/收行、Enter 提交；不做 roving（列表短）。
9. 文案：现状 zh 表全量沿用；仅新增锚点导航 7 词条 + 脏态 + 通用冲突文案 + disclosure aria 共 10 词条。
10. 只重组不删功能：8 组功能与 14 个 Remote 方法面语义全部保留。
