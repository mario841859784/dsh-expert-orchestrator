# 专家来源管理 · 先行调研设计依据（T1）

> 调研人：工程效率工程师 ｜ 任务板：`.expert-taskboards/expert-sources-v2.json` T1 ｜ 基线：dsh-expert-orchestrator HEAD `eafa0de`，DSH 宿主 `0.1.6-alpha.1`（`/usr/lib/node_modules/@deepseek-ai/dsh`）
> 调研临时产物（上游 shallow clone、CDN 实测文件、diff 脚本）全部位于 `/tmp/t1research/`，本文落盘后清理。
> 结论均基于实际读到的源码与实测数据；未经核验处已显式标注。

---

## 第一节 dsh 设置页契约（以 MichengAI/dsh-agency-agents 公开源码为准）

**证据源**：`/tmp/t1research/dsh-agency-agents`（shallow clone，HEAD `30bd326`，package.json 版本 0.1.44），对照本机安装副本 `/root/.dsh/profiles/web/node_modules/@michengai/dsh-agency-agents/` 与宿主包 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/`、`@deepseek-ai/dsh-settings/`、`@deepseek-ai/dsh-settings-file/`、`@deepseek-ai/dsh-client-modules/`。

### 1.1 事实

**a) 第三方插件如何注册设置页**

- `package.json` 声明两段 DSH 专有元数据：
  - `dsh.client.inject`：数组，列出插件客户端代码依赖的宿主 client 包。agency-agents 注入 7 个：`@deepseek-ai/dsh-client-runtime`、`dsh-client-connection`、`dsh-client-locale`、`dsh-api-remotes`、`dsh-client-ui-settings`、`dsh-client-ui-input-trigger`、`dsh-client-ui-primitives`；并配 `"platform": "web"`（`package.json` 的 `dsh.client` 段）。
  - `dsh.bundle.patch: "./cordis.patch.yml"`：宿主装载插件时合并的服务补丁（见 c）。
- 宿主侧读取该声明的是 `@deepseek-ai/dsh-client-modules`（`lib/index.js` 校验 `dsh.client.platform / inject / external / immediately` 字段）；插件浏览器端产物 `lib/client.js` 是 **CJS 包裹格式**：banner `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {`、footer `return module.exports; } });`（`tsdown.config.ts` outputOptions）。externals 只允许平台冻结模块表：`react`、`react/jsx-runtime`、`react-dom(/client)`、`@deepseek-ai/cordis`、`dsh-client-ui-slots`、`dsh-client-web-react`、`dsh-client-ui-primitives`、`dsh-client-ui-attachment`、`dsh-client-schema-form`，其余依赖一律内联。
- `package.json` 的 `exports["./client"]` 指向 `lib/client.js`；客户端入口文件 `src/client/index.ts` 导出：
  - `export const inject = ['slots', 'inputTriggers', 'locale', 'remote', 'sessions', 'conversation']`（所需宿主客户端服务）；
  - `export async function apply(ctx): Promise<() => void>`（返回卸载函数）。
- **设置面板注册就一句**（`src/client/index.ts:1358`）：
  ```ts
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'agency-agents', order: 16, label: () => t('settings.nav'), locale: NS, icon: 'expert' },
    (props) => React.createElement(ExpertCardsSettings, { ...props, remote, getActive, ... })
  ))
  ```
  即：面板 = 向宿主 `slots` 服务的 `settings.section` 槽位注册一个 `{name, id, order, label, locale, icon}` 描述 + React 渲染函数；`label` 是 thunk 以跟随语言切换；页面标题、检索、开关等 UI 全部由插件自绘（`React.createElement` + 手动注入 `<style>`，无宿主表单组件依赖）。样式注释明确「设置页版式对齐 dsh-skills-manager」。

**b) 设置数据持久化在哪**

- **宿主 settings 服务 + profile 的 `settings.yaml`**，不是插件私有存储：
  - 插件 host 侧在 `apply(ctx, config)` 中调用 `ctx.settings.installSection(ctx, 'agency-agents', agencySettingsSchema, { enabled: [], customExperts: [] }, { setSource, onChange, validate })`（`src/index.ts:537`，经 `settings-compat.ts` 兼容 RC 的模块级 `installSettingsSection` 与 alpha.2 的 `ctx.settings.installSection` 两种形态）。
  - 读取 `ctx.settings.get('agency-agents')`；写入 `ctx.settings.mutate(ns, [{op:'set'|'unset', path:[...]}], expectedRevision)`；乐观锁修订号经 `ctx.settings.describe().find(item => item.ns === ns).revision` 获取（`src/index.ts:525-536`、`src/remote.ts` getEnabled）。
  - 物理落盘：`@deepseek-ai/dsh-settings-file` 源码中出现 `settings.yaml`（`.yaml`/`.json` 双格式支持）；本机实证 `/root/.dsh/settings.yaml` 第 64 行起存在顶层键 `agency-agents:`，其下 `enabled:`（slug 列表）与 `customExperts: []` —— 与 schema 完全对应。

**c) host 侧如何读到 UI 侧配置（enabled → 花名册注册的传导链）**

- **传输层是 Typert Remote（双向 RPC）**，不是轮询文件：
  - host 侧：`src/remote.ts` 定义 `export default class AgencyAgentsRemote extends TypertRemoteService`，构造器 `super(ctx, 'agencyAgents')` 并 `this.ctx.typert.register(TYPERT)` 注册严格描述符；方法用 `@Remote('getCatalog' | 'getEnabled' | 'setEnabled' | 'getPrompt' | ...)` 标记。`setEnabled` 内部走 `expert-library.setEnabled` → `ctx.settings.mutate`（带 expectedRevision 冲突检测，错误文案含 "changed since it was read"）。
  - 严格契约 client/host 共用一份：`src/remote-contract.ts` 的 `AGENCY_AGENTS_DESCRIPTORS`（每方法 `id: '<pkg>#agencyAgents/<method>'`、zod 参数/结果 codec），client 侧 `src/client/remote.ts` 的 `TYPERT_REMOTE: TypertRemoteContribution { package, descriptors }`，客户端经 `await ctx.remote.$mount(TYPERT_REMOTE)` 挂载后 `ctx.get('remote.agencyAgents')` 得到可调用 API（`src/client/index.ts:1303-1306` 注释明确不能直接读 `ctx.remote.agencyAgents`，会死锁）。
  - **网关发现靠 cordis.patch.yml 根服务插入**（`cordis.patch.yml` 全文）：`- insert: [- { id: agency-agents-remote, name: '@michengai/dsh-agency-agents/remote' }, - { id: agency-agents, name: '@michengai/dsh-agency-agents' }]`，注释说明「供 api-gateway 从根服务表发现 agencyAgents Remote 路由」。
- **host 侧消费 enabled 的具体 API/键**：
  - `ctx.settings.get('agency-agents').enabled`（string[] slug）为唯一存储键；`settingsSource()` 闭包实时读取；
  - 工具注册时按 `enabledSet()` 过滤：`list_experts` 只列已启用（`src/index.ts:571-592`），`summon_expert` 对未启用专家抛 `error.expertDisabled`（`src/index.ts:633`）；
  - `ctx.reflect.provide(AGENCY_PERSONA_SERVICE='agencyAgentsPersona', personaSource)` 与 `AGENCY_LIBRARY_SERVICE` 供 remote 层复用（`src/index.ts:568-569`）；
  - systemPrompt 段 `agency:experts`（order 117）向模型声明花名册模式（`src/index.ts:722-730`）。

**d) 复刻该模式的最小接口清单**

| # | 层 | 接口 | 说明 |
|---|----|------|------|
| 1 | package.json | `dsh.client.inject` + `dsh.client.platform: "web"`；`exports["./client"]`；`dsh.bundle.patch` | 宿主 client-modules 读取 |
| 2 | 构建 | `lib/client.js` = CJS + `window.__ModuleLoader__.load` banner/footer；externals 限平台冻结模块表 | tsdown/rollup 产出 |
| 3 | client 入口 | `inject` 数组 + `apply(ctx) => disposer` | |
| 4 | client UI | `ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label, locale, icon}, render))` | 面板注册唯一必需调用 |
| 5 | client 数据 | `ctx.remote.$mount(TYPERT_REMOTE)` → `ctx.get('remote.<ns>')`；TS 侧声明 `TypertRemoteNamespaceMap` | 双向数据通道 |
| 6 | host 注册 | `apply(ctx, config)` + `Config` schemastery schema；`ctx.typert.register(TYPERT)`（host 严格描述符） | |
| 7 | host 存储 | `ctx.settings.installSection(ctx, ns, schema, entry, hooks)`；读 `ctx.settings.get(ns)`、写 `ctx.settings.mutate(ns, ops, expectedRevision)`、修订 `ctx.settings.describe()` | 落盘 profile `settings.yaml` 顶层 ns 键 |
| 8 | host 网关 | `cordis.patch.yml` insert 根服务 `<id>-remote → <pkg>/remote` | 使 UI→host RPC 可达 |

### 1.2 结论

设置页 = 「slot 注册一个 React 面板 + Typert Remote 双向通道 + host settings 服务持久化」三件套；无任何私有存储或自建 API 端点。

### 1.3 对实现的建议

- 来源管理设置页复用同一模式：`dsh-expert-orchestrator` 的 package.json 增加 `dsh.client.inject`（至少 `dsh-client-ui-settings`、`dsh-api-remotes`、`dsh-client-locale`、`dsh-client-ui-slots`/`primitives`）并产出 `lib/client.js`；面板注册 `settings.section` 槽位。
- 来源包清单、已装来源、sha256 记录等持久化走 `ctx.settings.installSection` 新命名空间（如 `expert-sources`），自动获得 `settings.yaml` 持久化、revision 乐观锁与 UI↔host 通道；下载/验签执行逻辑放在 host 侧 Remote 方法（UI 不直接发起 GitHub 请求，天然规避浏览器 CORS）。
- 版本差异注意：agency-agents 的 `settings-compat.ts` 专门桥接 RC（模块级 `installSettingsSection`/`settingsNamespace`）与 alpha.2（`ctx.settings.installSection`）两代 API；本机为 0.1.6-alpha.1，实现时按 alpha.2 形态直调并保留兼容分支。
- 下载到本地的来源包文件属文件系统资产，不走 settings；settings 只存「来源元数据 + 文件清单哈希」，与 agency-agents 把 persona 正文留在 assets/、把 enabled 状态留在 settings.yaml 的分工一致。

---

## 第二节 CDN 可达性实测

**证据源**：2025-07（本会话）自本机 curl 实测，原始产物在 `/tmp/t1research/cdn/`（已随清理删除，数据记录于下表）。测试文件为从上游仓库实际取到的真实路径。

### 2.1 可达矩阵（通道 × 对象类型）

| 通道 | 对象类型 | URL 样例 | 状态 | 延迟 | 字节数 | 备注 |
|------|----------|----------|------|------|--------|------|
| jsDelivr | 仓库单文件 | `cdn.jsdelivr.net/gh/VoltAgent/awesome-claude-code-subagents@main/categories/01-core-development/api-designer.md` | **200** | 1085ms | 6115B | 与 raw 内容一致 |
| jsDelivr | 仓库单文件 | `.../gh/wshobson/agents@main/plugins/api-scaffolding/agents/backend-architect.md` | **200** | 1398ms | 18352B | 深层路径可用 |
| jsDelivr | 目录树 API | `data.jsdelivr.com/v1/packages/gh/VoltAgent/awesome-claude-code-subagents@main?structure=flat` | **200** | — | 165 个文件清单 | 可用于来源包文件枚举 |
| jsDelivr | 错误路径 | `.../gh/wshobson/agents@main/agents/backend-architect.md`（不存在） | 404 | 1674ms | 81B | 路径猜错时报 404 而非 200 空内容 |
| GitHub 直连 | raw 单文件 | `raw.githubusercontent.com/VoltAgent/.../api-designer.md` | **200** | 522ms | 6115B | 本机直连可用 |
| GitHub 直连 | archive | `codeload.github.com/VoltAgent/.../tar.gz/refs/heads/main` | **200** | 1164ms | 349472B | tar.gz 可解开 |
| GitHub 直连 | API | `api.github.com/repos/VoltAgent/awesome-claude-code-subagents` | **200** | 615ms | 8018B | |
| ghproxy.net | archive 代理 | `ghproxy.net/https://github.com/VoltAgent/.../archive/refs/heads/main.tar.gz` | **200** | 2671ms | 349472B | **sha256 与直连一致**（`052250b1…95ac`） |
| gh-proxy.com | archive 代理 | `gh-proxy.com/https://github.com/VoltAgent/.../archive/refs/heads/main.tar.gz` | **200** | 1935ms | 349472B | **sha256 与直连一致** |
| gh-proxy.com | archive 代理 | `gh-proxy.com/https://github.com/wshobson/agents/archive/refs/heads/main.tar.gz` | **200** | 2523ms | 2368295B | tar 完整性 ok |
| mirror.ghproxy.com | archive 代理 | 同上格式 | **000（失败）** | 436ms | 0B | `Could not resolve host: mirror.ghproxy.com`，DNS 不可解析 |

（注：README.md 经 jsDelivr 取 wshobson 仓库亦 200/948ms/10444B；VoltAgent 仓库当前分支为 `main`。）

### 2.2 结论

- 「GitHub 直连 + 大陆 CDN 加速双按钮」两种通道在本机均实测可达；jsDelivr 适合**单文件/清单粒度**（含 `data.jsdelivr.com` 的目录树 API，可直接枚举来源包文件），ghproxy 类镜像适合 **archive 粒度**，且字节级一致（sha256 相同，可先直连后镜像重试，验签逻辑对两条通道透明）。
- 镜像可用性波动大：3 个候选中 1 个 DNS 级失效（mirror.ghproxy.com），实现需按序回退 + 超时兜底（实测 2–3s 量级延迟）。

### 2.3 对实现的建议

- 下载策略：直连优先 → 失败按镜像列表回退（ghproxy.net、gh-proxy.com 实测可用）；所有通道产物统一走 sha256 验签，镜像内容与直连一致已实证，无需区分信任级。
- 来源包文件枚举可先用 `data.jsdelivr.com` 树 API（免 clone、免 GitHub API 配额），archive 通道用于整体下载。

---

## 第三节 历史改名 diff（本地 66+1 个带来源文件 vs 上游当前 HEAD）

**证据源**：shallow clone（main HEAD）`VoltAgent/awesome-claude-code-subagents@ca7a50b`、`wshobson/agents@4236bb9`、`jnMetaCode/agency-agents-zh@da1542f`；本地 `skills/expert-orchestration/experts/` 中带 `来源:` frontmatter 的文件共 **67 个**（62 VoltAgent + 4 wshobson + 1 agency-agents-zh）。逐文件对比脚本与明细：`/tmp/t1research/renamediff.py`、`rename_table.json`（临时产物，用后即删）。

### 3.1 逐文件结论表（汇总维度；明细 67 行见 `/tmp/t1research/rename_table.json`，其内容已全部核验）

| 维度 | 结果 |
|------|------|
| 文件名改名 | **0 / 67**。本地文件名与上游当前文件名逐一相同（VoltAgent 在 `categories/<分区>/` 下，wshobson 在 `plugins/<插件>/agents/` 下） |
| frontmatter `name` 改动 | **66 / 67 保持一致**；唯一例外 `marketing-search-growth-orchestrator.md`（zh 来源）：上游 `name: 搜索增长编排器`，本地改用英文 slug 作 name |
| frontmatter 结构改动（全部 67 个） | 删除上游 `description`（+`tools`/`model`，部分文件还有 `emoji`/`color`）；新增 `title`、`division`、`适用任务`（= 原 description 原文）、`来源`；zh 文件额外有 `禁入任务`/`典型交付` |
| 正文（frontmatter 之后）差异 | **67 / 67 正文实质零改动**：62 个逐字节一致（仅行尾空白差异）；5 个（build-engineer、cli-developer、legacy-modernizer、refactoring-specialist、slack-expert）仅多 1 个空行 |
| wshobson 4 文件映射 | `arm-cortex-expert.md→plugins/arm-cortex-microcontrollers/agents/`、`dgx-spark-ops-engineer.md→plugins/dgx-spark-ops/agents/`、`julia-pro.md→plugins/julia-development/agents/`、`llm-finetuning-architect.md→plugins/llm-finetuning/agents/`（同名文件跨插件存在，按内容相似度=1.0 定位，无歧义） |

（局限性：shallow clone 仅含上游当前 HEAD，未追溯历史提交里的改名记录；「历史改名」以「本地副本 vs 上游今天的状态」为口径。）

### 3.2 结论

- 本仓现有 67 个副本对上游是「**文件名与正文原样、仅 frontmatter 适配**」的导入方式：文件名零改名、正文零改写，适配全部集中在 frontmatter（description→适用任务、加 title/division/来源、删 tools/model）。
- 这与两个决策的关系：
  - **classic 包按上游原样不改名**：与现状完全兼容——现有副本的文件名/正文本就是上游原样；classic 包可直接复用同一批文件（或直接以 sha256 锚定上游文件）。
  - **旧副本迁移为 legacy-adapted 冻结来源**：旧副本相对上游的全部差异可机器描述为「frontmatter 适配层 + 正文逐字节一致」，迁移时冻结对象明确（差异只在 frontmatter，6 个字段级别改动）。

### 3.3 对实现的建议

- classic 来源包不必重新搬运文件：以「上游文件名 + sha256」作为 classic 包文件指纹，校验现有 experts/ 内同名文件正文哈希一致即可挂账为 classic 内容（62+4 全部会通过；唯一 name 字段差异属 frontmatter 适配，不进正文哈希）。
- legacy-adapted 冻结来源的登记粒度建议为「文件级：上游 repo/路径 + 上游文件 sha256 + 本地 frontmatter 适配规则版本」，无需逐文件人工审差异（本表已给出全量结论）。
- agency-agents-zh 文件的 name 中英差异（`搜索增长编排器` vs 英文 slug）在来源名+原名合并花名册时需保留双名（这正是「来源名+原名」字段设计要覆盖的场景实例）。

---

## 附：已检查文件清单

- 上游源码：`dsh-agency-agents` 的 `package.json`、`tsdown.config.ts`、`cordis.patch.yml`、`src/index.ts`、`src/remote.ts`、`src/remote-contract.ts`、`src/settings-compat.ts`、`src/expert-library.ts`（grep 级）、`src/client/index.ts`、`src/client/remote.ts`；宿主包 `dsh-client-modules/lib/index.js`（grep 级）、`dsh-settings/lib/index.js`（grep 级）、`dsh-settings-file/lib/index.js`（grep 级）、`dsh-client-ui-settings/package.json`。
- 本仓：`skills/expert-orchestration/experts/` 全部 78 个文件的来源标注、67 个带来源文件的逐文件 diff；`/root/.dsh/settings.yaml`（agency-agents 段，只读核验）。
- 未检查：agency-agents 的 test/、scripts/、playwright 配置；宿主 web 前端装载链其余部分（仅核到 `window.__ModuleLoader__` 契约与 client-modules 声明解析）。

---

## 实现记录（T2 · 后端架构师 · host 侧运行时）

> 对应任务板 `.expert-taskboards/expert-sources-v2.json` T2。版本号未动（package.json 仍 1.5.0；2.0.0 由协议接线任务统一升）。部署标记内部修订号 `1.5.0+sources1`（lib/index.js `DEPLOY_REV`）仅用于触发一次 PROTOCOL 刷新，把 source-registry.json 落进既有部署，不属于版本声明。

### 落盘物

| 文件 | 内容 |
|------|------|
| `lib/index.js` | 部署器（语义保留）+ 来源运行时：`CORE_EXPERTS`(11)、`loadRegistry`/`loadSourcesState`、`installSource`、`setSourceEnabled`、`rebuildMergedView`、`readMergedRoster`、`migrateLegacyExperts`、`scanSecurity`、`fetchBuffer`（TLS 重置重试一次）、`resolveChannels`、`globToRegExp` |
| `lib/remote.js` | `TypertRemoteService` 子类，命名空间 `expertSources`；protocol 包不可解析时降级为普通 cordis 服务（不拖垮插件装载） |
| `skills/expert-orchestration/source-registry.json` | 来源注册表（随包，PROTOCOL 刷新） |
| `cordis.patch.yml` | 追加根服务 `expert-sources-remote → dsh-expert-orchestrator/lib/remote.js`（package.json 无 exports 字段，深路径直接可解析，未动 package.json） |
| `NOTICE` | 四个上游 MIT 署名 |
| `scripts/build-classic-pack.mjs` | classic 包构建（git grep HEAD `来源:` 自动发现 67 文件 → 浅 fetch pinned commit → frontmatter 剥离+空白级归一化正文比对锚定 → 打 tgz+MANIFEST+sha256） |
| `skills/expert-orchestration/experts/` | 出厂仅 11 core（67 个带 `来源:` 文件移除；上游原文件由 classic pack 锚定，运行时由迁移语义接管） |

### 存储布局（部署副本 targetDir 下）

```
~/.dsh/.agent-presets/expert-orchestrator/
├── skills/expert-orchestration/experts/     # 11 core，随 DEPLOY_REV 刷新
├── skills/expert-orchestration/source-registry.json
└── expert-sources/
    ├── sources.json                         # {version, sources:[{id,enabled,kind,version,sha256,upstream,lastSync,fileCount}], mergedStateHash}
    ├── legacy-adapted/                      # 迁移产物（冻结本地来源，默认启用）+ .source-manifest.json
    ├── <source-id>/                         # 原样解包（零改名零改内容）+ .source-manifest.json（独立标注层）
    └── merged/                              # stable 视图：bundled-core/ 恒在 + <source-id>/<上游相对路径>/；roster.json 含跨源重名标注
```

### 注册表（source-registry.json v1，4 来源）

| id | 上游 | pinned ref | archive sha256（codeload@ref 实测） | include | 许可 |
|----|------|-----------|--------------------------------------|---------|------|
| awesome-claude-code-subagents | VoltAgent/awesome-claude-code-subagents | ca7a50b764…cb89 | 13bf5a78…6e2e1 | `categories/**/*.md` (171) | MIT |
| wshobson-agents | wshobson/agents | 4236bb91f8…620 | 254ffad3…5140 | `plugins/*/agents/*.md` (202) | MIT |
| agency-agents | msitarzewski/agency-agents | ad9264e309…604 | c6cae326…d627 | `*/*.md` (278, 排 .github/README 等) | MIT |
| agency-agents-zh | jnMetaCode/agency-agents-zh | da1542f56c…fde | 72453d57…5104 | `*/*.md` (276, 排 .github/README 等) | MIT |

下载通道（有序回退）：① GitHub 直连 `codeload.github.com/<repo>/tar.gz/<ref>` → ② 镜像 `{prefix}https://github.com/<repo>/archive/<ref>.tar.gz`，前缀默认 `ghproxy.net`、`gh-proxy.com`（T1 实测可达且 sha256 与直连一致），可用 env `DSH_GH_MIRROR_PREFIXES`（逗号分隔）覆盖 → ③ release pack 兜底（离线，classic 锚定子集）。所有通道统一 sha256 验签（archive 通道对 pinned archive 哈希、pack 通道对整包哈希+MANIFEST 逐文件哈希），不匹配即拒收并终止安装。pinned commit 保证验签哈希长期有效；升级来源 = 注册表改 ref+sha256。

### 安装流水

拉包 → sha256 验签 → tar 原样解包（不改名不改内容）→ include/exclude 选文件 → 安全扫描（`SCAN_PATTERNS`：凭据 10 模式 + 指令注入 6 模式，与上架核查同源标准；命中即拒收，安装目录不落任何文件）→ 写 `expert-sources/<id>/` 与 `.source-manifest.json`（独立标注层，记录 path/upstreamPath/sha256/channel）→ 入册 sources.json → 重建 merged 视图。

### 迁移（apply 时，幂等）

`migrateLegacyExperts`：部署副本 experts/ 中非 11 core 的 `*.md` → rename 进 `expert-sources/legacy-adapted/`，注册 `legacy-adapted`（kind=legacy-frozen，默认启用，sha256=文件清单聚合哈希）。0 丢失（move 非删除）；再次 apply 无非 core 文件即空转。PROTOCOL/USER_DATA 语义：`experts/` 从 USER_DATA（只缺才补）改入 PROTOCOL（随 DEPLOY_REV 刷新，只含 core）；lessons.md 仍为 USER_DATA。

### Remote 契约（供 T3 设置页接线）

命名空间 `expertSources`（cordis 服务键同名）；7 方法（unary，JSON 序列化，网关按 descriptor 形参顺序**位置传参**；全部变更方法带 `expectedRevision` 乐观锁，失败不 bump）：

| 方法 | 参数（位置序） | 返回 | 备注 |
|------|----------------|------|------|
| `getSources()` | — | `SourcesSnapshot` | |
| `addSource(input{url,name}, expectedRevision)` | | `SourcesSnapshot` | GitHub repo URL 或本地路径；id 由 host 白名单派生（M1） |
| `removeSource(id, expectedRevision)` | | `SourcesSnapshot` | id 白名单校验 + 路径前缀断言（M1）；legacy-adapted/bundled-core 拒删 |
| `setSourceEnabled(id, enabled, expectedRevision, ackRisks?)` | | `SourcesSnapshot` | **M3 确认门，见下** |
| `downloadSource(id, channel<'github'\|'cdn'>, expectedRevision)` | | `SourcesSnapshot` | 进程内互斥（M5）；失败仅记 status 不 bump |
| `updateSource(id, channel<'github'\|'cdn'>, expectedRevision)` | | `SourcesSnapshot` | 同上（update 语义） |
| `setMirrorPrefixes(prefixes: string[], expectedRevision)` | | `SourcesSnapshot` | ≤16 条，http(s) 前缀 |

`SourcesSnapshot = { revision, sources[], mirrorPrefixes[], conflicts[], confirmRequired? }`，sources 行含 `{id,name,upstream,license,installedVersion,enabled,builtin,status,statusDetail,lastUpdated}`。client 侧 `vObject` 对声明外字段剥离，故新增顶层 `confirmRequired` 对旧 client 向后兼容（被剥离、不报错）。

**M3 确认门（host 强制，UI 需配合）**：`setSourceEnabled` 启用**非注册表来源**（`kind='custom'`：用户自加 GitHub 仓库 / 本地路径）时要求显式确认：

1. 首次启用未携带 `ackRisks === true`（第 4 个位置参数，boolean，可省略）：**拒绝**——不改任何状态、不 bump revision，返回快照附 `confirmRequired = { id, method: 'setSourceEnabled', ackField: 'ackRisks', reason }` 标记；
2. client 收到 `confirmRequired` 后弹确认框（明示「启用将把第三方专家提示词载入模型上下文」），确认后以 `remote.setSourceEnabled(id, true, revision, true)` 重试；
3. 确认成功的启用持久化 `confirmedAt`（sources.json entry 字段），后续启停不再要求 ack；禁用操作永远不需要 ack；
4. 注册表来源（kind='download'/legacy-frozen）与 bundled-core 不走确认门。

> client 侧配套（前端专家，以本契约为准联调）：descriptor `setSourceEnabled` 追加第 4 形参 `jsonParameter("ackRisks", "boolean", vBoolean())`（可选语义由 host 判空实现），`sourcesSnapshotSchema` 顶层追加可选 `confirmRequired`，toggle onChange 检查返回快照的 `confirmRequired` 触发确认弹窗后携带 `true` 重试。

宿主侧按 `@deepseek-ai/dsh-typert-protocol` 的 prototype Remote 标记打标（无原生装饰器语法的 shim：以最小 context shim 调 `Remote(name)` 工厂再执行收集到的 initializer）。网关发现走 cordis.patch 根服务插入（与 agency-agents 同型）。T3 侧需：`ctx.remote.$mount` 带同名命名空间的 client contribution + 设置面板 `settings.section` 槽位注册。

### classic pack（release source-packs-v1）

`scripts/build-classic-pack.mjs`：从 git HEAD 自动发现 67 个 `来源:` 文件 → 浅 fetch 4 注册表 pinned commit（git fetch 失败自动回退 codeload archive 通道，TLS 重试一次）→ frontmatter 剥离 + 空白级归一化（行尾空白/首尾空行/连续空行压缩；对应 T1「62 逐字节一致 + 5 个多 1 空行」的口径）正文比对，basename+正文唯一匹配锚定 → `awesome-claude-code-subagents/`(62) + `wshobson-agents/`(4) + `agency-agents-zh/`(1) 三项目分子目录零改名零改内容（注：任务书原文「两项目」按 62+4+1 的实际上游分布落为三个子目录）→ MANIFEST.json（逐文件 sha256）→ tgz。sha256 `1865d469d415095102aa696094cf63ef57b25611cf12bd438b195be014a0e778`，已回填注册表 pack.sha256，并上传 GitHub release tag `source-packs-v1`。
