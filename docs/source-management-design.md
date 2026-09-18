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

拉包 → sha256 验签 → tar 原样解包（不改名不改内容；symlink 成员跳过并记录 `skippedSymlinks`，绝不跟随）→ include/exclude 选文件 → 安全扫描（`SCAN_PATTERNS`：凭据 10 模式 + 指令注入 6 模式，与上架核查同源标准；命中处置按「扫描策略修订」节三分野：注册表来源确认后放行、自定义来源拒收）→ 写 `expert-sources/<id>/` 与 `.source-manifest.json`（独立标注层，记录 path/upstreamPath/sha256/channel/scanFindings/skippedSymlinks）→ 入册 sources.json → 重建 merged 视图。

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
| `downloadSource(id, channel<'github'\|'cdn'>, expectedRevision, ackScan?)` | | `SourcesSnapshot` | 进程内互斥（M5）；失败仅记 status 不 bump；扫描命中 → `confirmRequired`（ackField `ackScan`，见「扫描策略修订」节） |
| `updateSource(id, channel<'github'\|'cdn'>, expectedRevision, ackScan?)` | | `SourcesSnapshot` | 同上（update 语义） |
| `setMirrorPrefixes(prefixes: string[], expectedRevision)` | | `SourcesSnapshot` | ≤16 条，http(s) 前缀 |

`SourcesSnapshot = { revision, sources[], mirrorPrefixes[], conflicts[], confirmRequired? }`，sources 行含 `{id,name,upstream,license,installedVersion,enabled,builtin,status,statusDetail,lastUpdated, scanFindings?, skippedSymlinks?}`（scanFindings/skippedSymlinks 见「扫描策略修订」节；旧 client 对未声明行字段剥离不报错）。client 侧 `vObject` 对声明外字段剥离，故新增顶层 `confirmRequired` 对旧 client 向后兼容（被剥离、不报错）。

**conflicts 分类契约（v2.1.1，2026-09-18 用户裁决）**：basename 冲突由去重引擎分类（`classifyBasenameConflict`），快照的报警面 = **仅 `unresolved` 类**；roster.json 保留全量记录并携带 `class` 字段供审计。三类定义：

| class | 判定 | 报警 |
|---|---|---|
| `resolved-by-dedup` | 该 basename 的全部命中位于同一去重组（组内有 representative）——调用目标已由引擎消歧 | 否 |
| `basename-only` | 命中分属不同专家身份（name/title 归一后不同，或至少一方身份不可判定且非全部相同）——不同专家恰好同文件名 | 否 |
| `unresolved` | 全部命中同一归一身份却未被任何去重组覆盖——防御性分支（未来来源）；必须保留报警 | 是 |

快照 `conflicts[]` 条目形状不变（`{expert, sources}`，client `conflictEntrySchema` 兼容），仅内容过滤为 unresolved 类；roster.json `conflicts[]` 条目新增 `class` 字段（数组结构不变，向后兼容）。`computeConflicts` 优先消费 merged/roster.json 的分类结果（前提：roster 覆盖的来源集合与当前启用集合完全一致），roster 缺失/不可读/不覆盖时回退旧的全量 basename 计算（保守方向：宁可多报警）。

**M3 确认门（host 强制，UI 需配合）**：`setSourceEnabled` 启用**非注册表来源**（`kind='custom'`：用户自加 GitHub 仓库 / 本地路径）时要求显式确认：

1. 首次启用未携带 `ackRisks === true`（第 4 个位置参数，boolean，可省略）：**拒绝**——不改任何状态、不 bump revision，返回快照附 `confirmRequired = { id, method: 'setSourceEnabled', ackField: 'ackRisks', reason }` 标记；
2. client 收到 `confirmRequired` 后弹确认框（明示「启用将把第三方专家提示词载入模型上下文」），确认后以 `remote.setSourceEnabled(id, true, revision, true)` 重试；
3. 确认成功的启用持久化 `confirmedAt`（sources.json entry 字段），后续启停不再要求 ack；禁用操作永远不需要 ack；
4. 注册表来源（kind='download'/legacy-frozen）与 bundled-core 不走确认门。

> client 侧配套（前端专家，以本契约为准联调）：descriptor `setSourceEnabled` 追加第 4 形参 `jsonParameter("ackRisks", "boolean", vBoolean())`（可选语义由 host 判空实现），`sourcesSnapshotSchema` 顶层追加可选 `confirmRequired`，toggle onChange 检查返回快照的 `confirmRequired` 触发确认弹窗后携带 `true` 重试。

宿主侧按 `@deepseek-ai/dsh-typert-protocol` 的 prototype Remote 标记打标（无原生装饰器语法的 shim：以最小 context shim 调 `Remote(name)` 工厂再执行收集到的 initializer）。网关发现走 cordis.patch 根服务插入（与 agency-agents 同型）。T3 侧需：`ctx.remote.$mount` 带同名命名空间的 client contribution + 设置面板 `settings.section` 槽位注册。

### classic pack（release source-packs-v1）

`scripts/build-classic-pack.mjs`：从 git HEAD 自动发现 67 个 `来源:` 文件 → 浅 fetch 4 注册表 pinned commit（git fetch 失败自动回退 codeload archive 通道，TLS 重试一次）→ frontmatter 剥离 + 空白级归一化（行尾空白/首尾空行/连续空行压缩；对应 T1「62 逐字节一致 + 5 个多 1 空行」的口径）正文比对，basename+正文唯一匹配锚定 → `awesome-claude-code-subagents/`(62) + `wshobson-agents/`(4) + `agency-agents-zh/`(1) 三项目分子目录零改名零改内容（注：任务书原文「两项目」按 62+4+1 的实际上游分布落为三个子目录）→ MANIFEST.json（逐文件 sha256）→ tgz。sha256 `1865d469d415095102aa696094cf63ef57b25611cf12bd438b195be014a0e778`，已回填注册表 pack.sha256，并上传 GitHub release tag `source-packs-v1`。

---

## 扫描策略修订（用户裁决 · host 侧实施记录）

> 落盘物：`lib/index.js`、`lib/remote.js`、本节。安全裁决三分野：①注册表来源扫描命中 → 警告 + 用户确认放行；②symlink 成员 → 一律跳过并记录（不再整包拒收）；③自定义/本地路径来源扫描命中 → 维持硬拒。红线遵守：仅改上述三个文件；未 commit/push。

### 策略三分野（host 强制）

| 场景 | 旧行为 | 新行为（本修订） |
|------|--------|------------------|
| 注册表来源（source-registry.json、pinned sha256）扫描命中 | 整包拒收（`scanRejected`，零落盘） | **命中不拒收**：首次无确认下载中止安装（零落盘、revision 不动），返回快照附 `confirmRequired = { id, method: 'downloadSource'\|'updateSource', ackField: 'ackScan', reason }` + 命中明细持久化；用户确认后携带 `ackScan: true` 重试 → 正常入册，命中明细持久化进 sources.json（`scanFindings` ≤100 条 + `scanAckAt` 时间戳 + `.source-manifest.json` 亦记 `scanFindings`），行 status 置 `ok` |
| tar 成员 / 本地文件 symlink | 归档含 symlink 成员 → 整包拒收；本地内层 symlink 静默跳过 | **一律跳过并记录**：`collectSkippedSymlinks`（lstat，绝不跟随），rel 路径随来源持久化为 `skippedSymlinks`（≤100 条，manifest 亦记），不拒整包、不进入安装/扫描/merged 流水线。本地来源 **symlink 根目录仍拒收**（M2b 语义不变：根被跳过=无可安装内容，且属独立注入防护面） |
| 自定义/本地路径来源扫描命中 | 整包拒收 | **维持硬拒不变**（`security scan rejected …` → `scanRejected`），不提供 ackScan 放行路径 |

sha256 验签失败（archive pin / pack / MANIFEST 逐文件）维持硬拒不变；M1 来源 id 白名单与路径前缀断言不变。

### Remote 契约变更（供前端对齐）

1. `downloadSource(id, channel<'github'\|'cdn'>, expectedRevision, ackScan?)` 与 `updateSource(...同型)`：**新增第 4 位置参数 `ackScan`（boolean，可省略，与 `ackRisks` 同型）**。旧 client 传 3 参 → host 得 `ackScan=undefined` → 走确认分支，向后兼容。
2. 快照新增**可选行字段** `scanFindings: [{file,line,kind,name}] | null` 与 `skippedSymlinks: string[] | null`（null = 从未安装/未产生）。确认分支的 pending 快照另附**顶层** `scanFindings`（client `sourcesSnapshotSchema` 已声明可选顶层字段，作为确认弹窗的命中明细兜底；`confirmRequired` 内嵌字段会被严格 codec 剥离，故不放内层）。client 侧 `sourceEntrySchema` 为 vObject 严格 codec，旧 client 对未声明字段**剥离不报错**；前端对齐时在 `sourceEntrySchema` 追加这两个可选字段即可渲染命中/跳过明细。
3. 确认分支**不新增 status 枚举值**（client `SOURCE_STATUSES` 为固定枚举，新增值会导致校验失败）：pending 状态复用 `scanRejected` + `statusDetail`（`security scan: N finding(s) — awaiting ackScan confirmation …`）；确认入册后置 `ok`。前端如需区分文案，可在 `scanFindings != null && status === 'scanRejected'` 时显示「待确认」。
4. `confirmRequired` 标记复用既有 `ackMarkerSchema = { id, method, ackField, reason }`（reason ≤256）；`method` 取值 `downloadSource` / `updateSource`，`ackField` 恒为 `'ackScan'`。前端对齐：download/update 的返回快照若带 `confirmRequired`，弹确认框（明示命中明细与风险）后以第 4 参 `true` 重试；descriptor 需为 `downloadSource`/`updateSource` 追加 `jsonParameter("ackScan", "boolean", vBoolean())`。
5. `setSourceEnabled` 的 M3 ackRisks 门不受影响（注册表来源带 `scanFindings` 启停无需再次确认）。

### 验收记录（/tmp 沙箱，真拉上游）

- agency-agents @ad9264e（274 文件）真拉：无 ack → `confirmRequired`（7 条命中）+ 零落盘 + revision 不动；`ackScan:true` 重试 → 入册 fileCount=274、`scanFindings` 7 条可查（sources.json 与快照行均可见）。
- wshobson-agents @4236bb9 真拉（上游含 symlink `CLAUDE.md → AGENTS.md`）：不再拒收，正常入册（202 文件），`skippedSymlinks = ["CLAUDE.md"]` 持久化；symlink 未跟随、未落盘。
- 自定义含凭据本地来源：仍整包拒收（`scanRejected`），零落盘。
- 既有 39+48 冒烟回归（symlink 断言按裁决更新后）+ M1/M2 PoC（M1 全拒、本地 symlink 根拒收、sha256 失配拒收）全过；归档 symlink 成员整包拒收用例按裁决改为「跳过+记录」断言。
- 无 git commit/push；在途改动未触碰。

## 跨源智能去重 + 推荐配置（T4 · host 侧实施记录）

> 落盘物：`lib/index.js`、`lib/remote.js`、`source-registry.json`、本节。背景用户反馈：『跨源重名专家太容易触发，考虑智能去重』『现有几个专家来源对用户来说选择困难，需要推荐配置』。红线遵守：仅改上述四个授权文件（`lib/client.js` 由并行前端专家负责）；未 commit/push。

### 去重契约（与 client/协议逐字对齐）

`SourcesSnapshot` 新增顶层 `dedupGroups[]`：**仅含启用来源中 >1 成员的组**，元素结构：

```
{ key, members: [{ sourceId, file, name, title }], representative: { sourceId, file }, rule }
```

分组规则（重叠链接经 union-find 传递合并）：
- **a) 同名跨源/同源重名**：规范化 name 一致即成组（规范化 = NFKC 折叠 + 小写 + 剥离全部空白/标点/符号码点，`"Backend Architect" === "backend-architect"`）；name 缺失时以规范化 title 兜底作为键材料；
- **b) 中英对照**：`agency-agents` 与 `agency-agents-zh`（`DEDUP_AGENCY_PAIR`，lib/index.js 导出）**同相对路径视为同一专家**。实测两上游（@ad9264e / @da1542f）均为 `<domain>/<domain>-<slug>.md` 布局，路径相等即可靠链接，name/title 归一仅作对子外的一般规则——zh 文件 frontmatter `name` 为中文（如 `后端架构师`），与英文对位文件名归一后不等，故对子规则必须存在；
- **c) 跨源同 title 不同 name 不强归组**，title 仅随 member 透出供 UI 参考（member.title 取 frontmatter `title:` 或首个非代码围栏 H1）。

组 key 命名空间（不透明字符串，client 原样回传 setDedupChoice）：对子链接的组取最小公共相对路径 `pair:<rel>`；纯同名组取首个 (rank, file) 成员的键材料 `name:<norm>`。`rule` ∈ `agency-path-pair`（成员全为对子来源）| `mixed`（对子 + 同名链接并存）| `name-match`。

**代表规则（优先级降序）**：
1. `sources.json` 的 `dedup.choice[key] = sourceId`（用户手动，见新 Remote 方法）——非成员/stale choice 静默忽略回落；
2. `preferLang`（sources.json `dedup.preferLang` 显式设置 > registry `defaults.preferLang`，缺省 `'zh'`）——**仅作用于 agency 对子**（`agency-agents-zh` 优先于 `agency-agents`；对子外来源 lang 视为 null 不参与）；
3. 注册表顺序（rank：bundled-core=0 < legacy-adapted=1 < registry 顺序 2+i < 自定义 1000+state 序）；
4. 首个启用来源（(rank, file) 稳定排序）。

**shadowed 语义**：非代表成员在 `merged/roster.json` 对应行标注 `shadowed: true`（代表行不设该字段）。文件保留在各自 source 目录与 merged/ 视图，**不删除、不移动、不影响安全扫描状态**；协议侧读取花名册时 shadowed 行仅作展示降级提示。

### Remote 契约变更（供前端对齐）

1. 新增 `setDedupChoice(key, sourceId, expectedRevision) → SourcesSnapshot`：pin 某去重组的代表来源，持久化为 `dedup.choice[key]`；未知 key / 非成员 sourceId / 过期 expectedRevision 均拒绝；no-op（choice 已相等）**不 bump revision**。
2. 新增 `clearDedupChoice(key, expectedRevision) → SourcesSnapshot`：恢复默认代表规则；已默认时 no-op 不 bump revision。
3. 两方法与既有变更方法同型：expectedRevision 乐观锁 + sources-state 互斥锁（`withSourcesLock`）；返回完整新快照。
4. `getSources` 及全部变更方法返回的快照新增顶层 `dedupGroups[]`（如上）与 `recommendedNote: string | null`（registry 顶层推荐说明透传）；registry 来源行新增 `recommended: boolean`（bundled-core 隐含恒启，**不设**该字段）。严格 codec 对未声明字段剥离不报错，旧 client 向后兼容；前端对齐时在 `sourcesSnapshotSchema`/`sourceEntrySchema` 追加可选字段即可。
5. 去重引擎纯函数化并导出（lib/index.js）：`normalizeExpertName`、`parseExpertIdentity`、`buildDedupGroups(entries, {choice, preferLang})`、`computeDedupGroups(dst, state, registry)`、`DEDUP_AGENCY_PAIR`，便于单测与协议侧复用。

### 推荐配置数据（source-registry.json）

- `sources[].recommended`：`awesome-claude-code-subagents=true`、`agency-agents-zh=true`、`wshobson-agents=false`、`agency-agents=false`（中文用户推荐集；bundled-core 隐含恒启不设标记）；
- 顶层 `recommendedNote`：双语一句推荐说明，快照透传；
- `defaults.preferLang: "zh"`：去重代表规则缺省语言偏好（用户显式设置优先；当前无独立 Remote 方法，预留 settings 扩展）。

### roster 格式升级

`merged/roster.json` 新增 `rosterFormat: 2`、行级 `name`/`title`/`shadowed`、顶层 `dedupGroups` 与 `dedup: { preferLang, choice }`；`mergedStateHash` 输入追加格式标签 `roster-dedup-v1`，保证既有部署升级后首次 apply 强制重建一次花名册（实测旧哈希 → 重建后 rosterFormat=2）。格式 <2 的旧 roster 读取时 `dedupGroups` 返回空数组（不猜测、不报错），待重建自愈。

### 验收记录（/tmp 沙箱）

- 专项套件 `/tmp/eso-dedup-test/test-dedup.mjs`：**52/52 全过**，覆盖 ①同源重名/跨源同名/中英对照分组与代表（含 rank、preferLang、choice 覆盖、stale choice 忽略、传递合并 mixed）②choice 覆盖与 clear（乐观锁拒绝、未知 key 拒绝、非成员拒绝、no-op 不 bump）③shadowed 不删盘（merged 与 source 目录文件均存在、翻转后标注正确）④快照含 `dedupGroups`/`recommended`/`recommendedNote` 且 Remote 层可消费（结构断言）⑤旧 roster 不崩溃 + 升级路径自愈。
- 既有冒烟回归重跑：`/tmp/eso-smoke/smoke-rest.mjs` **51/51**、`smoke-a.mjs` **45/45** 全过（日志 run-t4-rest.log / run-a-dyn2.log，smoke-a 修正版重跑于 2026-09-18 21:27 CST）。注：①两脚本断言 `apply().migration` 返回值系 7b775e0 之前的旧契约，/tmp 沙箱脚本已按现契约（迁移数经落账态代理验证）适配后重跑；②smoke-a 的 descriptor 断言已改为**动态口径**——数量与参数签名从 `lib/client.js` 导出的 `EXPERT_SOURCES_DESCRIPTORS` 与 `lib/remote.js` 服务原型提取比对，不硬编码 7/9（T4 去重新增 `setDedupChoice`/`clearDedupChoice` 后实测 9==9 对齐）；旧 44/44 记录系 T4 前静态断言（硬编码 7）口径、已不可复现，由本条取代；仓库内无测试文件改动。
- 无 git commit/push；未触碰 `lib/client.js` 及任何非授权文件。
