/**
 * dsh-expert-orchestrator — client bundle（专家来源设置面板）
 *
 * 宿主装载契约（对照 dsh-client-modules 校验与 MichengAI/dsh-agency-agents 先例）：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 限平台冻结模块表（此处仅 require react）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name, key, locale}, render))`（keyed，key = 组合包 npm 包名）。
 *   - 数据通道：Typert Remote（`ctx.remote.$mount(TYPERT_REMOTE)` 后 `ctx.get('remote.expertSources')`）；
 *     所有写操作经 Remote 调 host 侧，host 落 profile settings.yaml 顶层 `expert-sources` 键
 *     （ctx.settings.installSection/mutate，乐观锁 revision 随快照返回）。
 *   - 严格 descriptor 与 host 共用本文件导出的 EXPERT_SOURCES_DESCRIPTORS，避免两侧契约漂移；
 *     codec 同时带 `create()`（alpha.2）与 `schema`（alpha.1）两种形态（本机宿主 0.1.6-alpha.1）。
 *
 * Remote 契约（与 docs/source-management-design.md 最小接口清单及 host lib/remote.js 方法集对应）：
 *   namespace/service 均为 `expertSources`；descriptor id 形如
 *   `dsh-expert-orchestrator#expertSources/<method>`。方法集：
 *     getSources()                                        → SourcesSnapshot
 *     addSource(input{url,name}, expectedRevision)        → SourcesSnapshot
 *     removeSource(id, expectedRevision)                  → SourcesSnapshot
 *     setSourceEnabled(id, enabled, expectedRevision, ackRisks)  → SourcesSnapshot
 *       （M3 安全确认门：非注册表来源首次启用，未携带 ackRisks:true 时 host 返回
 *        需确认标记且不生效；客户端弹确认对话框（告知：第三方来源 persona 将进入
 *        模型上下文，已过自动扫描但非安全审查），用户确认后带 ackRisks:true 重发，
 *        拒绝则保持停用。停用与注册表来源不受影响。最终签名以 host 侧投递说明为准。）
 *     downloadSource(id, channel<'github'|'cdn'>, rev, ackScan)  → SourcesSnapshot
 *       （下载扫描确认门：sha256 验签通过但内容扫描命中时，host 返回 scanFindings +
 *        confirmRequired 标记且不落地安装；客户端弹双语警告对话框（列命中明细，明示
 *        「已过 sha256 验签；内容为第三方 persona，自动扫描非安全审查」），确认后带
 *        ackScan:true 重发，取消则中止。skippedSymlinks 清单随快照返回，来源行内展示。
 *        标记/字段命名以 host 侧投递说明为准，客户端按宽松形态兼容。）
 *     updateSource(id, channel<'github'|'cdn'>, rev, ackScan)    → SourcesSnapshot（同上扫描确认门）
 *     setMirrorPrefixes(prefixes: string[], rev)          → SourcesSnapshot
 *     setDedupChoice(key, sourceId, rev)                  → SourcesSnapshot
 *       （T4 智能去重：pin 某去重组的代表来源；key 为快照 dedupGroups[].key
 *        不透明字符串原样回传，sourceId 必须为组内成员；host 乐观锁拒绝过期 rev。）
 *     clearDedupChoice(key, rev)                          → SourcesSnapshot（恢复默认代表规则）
 *   快照新增顶层 `dedupGroups[]`（仅含启用来源中 >1 成员的组：
 *     {key, members:[{sourceId,file,name,title}], representative:{sourceId,file}, rule}，
 *     rule ∈ agency-path-pair(中英对照) | mixed | name-match(同名)；非代表成员在
 *     merged 花名册标注 shadowed，仅展示降级、不动文件）与 `recommendedNote`
 *     （registry 顶层双语推荐说明透传）；registry 来源行新增 `recommended` 标记。
 *   下载/验签/安全扫描均在 host 侧执行（UI 不直接发起 GitHub 请求，规避浏览器 CORS）。
 *   cordis.patch.yml 需由 host 侧插入根服务 `expert-sources-remote → dsh-expert-orchestrator/remote`。
 */

window.__ModuleLoader__.load({
	id: "dsh-expert-orchestrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-expert-orchestrator client: react 不可用");
		}
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-expert-orchestrator";
		var NS = "expertSources";
		var REMOTE_NS = "expertSources";
		// BUILTIN_SOURCE_ID / LEGACY_SOURCE_ID 移至下方「纯函数区」（SET-PURE，与
		// computeRecommendedPlan 同源自包含，供 test/client-settings.selftest.mjs 提取）。
		/**
		 * 默认镜像前缀（与 host 侧 source-registry.json defaults 对齐）：
		 * host 实际链为 GitHub 直连优先 → 此处镜像前缀按序回退 → release pack 兜底，
		 * 下载后 sha256 验签；jsDelivr 不支持 archive，不在回退链内。
		 */
		var DEFAULT_MIRROR_PREFIXES = [
			"https://ghproxy.net/",
			"https://gh-proxy.com/",
		];
		/** 来源状态枚举（与 host 侧快照契约一致）。 */
		var SOURCE_STATUSES = ["idle", "downloading", "verifyFailed", "scanRejected", "error", "ok"];
		/** 下载通道枚举：github=直连优先（镜像兜底）；cdn=镜像优先（直连兜底）。 */
		var DOWNLOAD_CHANNELS = ["github", "cdn"];
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用）
		function vString(min, max) {
			return {
				parse(value) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item) {
			return {
				parse(value) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map((entry) => item.parse(entry));
				},
			};
		}
		function vNullable(inner) {
			return {
				parse(value) {
					if (value === null) return null;
					return inner.parse(value);
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner) {
			return {
				parse(value) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Remote 契约 schema（与 host 侧共用真相）
		var sourceInputSchema = vObject({
			url: vString(1, 512),
			name: vString(0, 80),
		});
		/**
		 * 宽松 finding 记录：host 侧命中明细字段名未冻结（file/rule/detail 等以投递为准），
		 * 逐 key 字符串化并截断，未知字段不拒收（快照解析不得因明细形态漂移而失败）。
		 */
		function vLooseRecord() {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(value)) {
						var item = value[key];
						if (item == null) continue;
						var text = typeof item === "string" ? item
							: typeof item === "number" || typeof item === "boolean" ? String(item)
							: null;
						if (text !== null) out[key] = text.length > 200 ? text.slice(0, 200) + "…" : text;
					}
					return out;
				},
			};
		}
		var scanFindingSchema = vLooseRecord();
		var sourceEntrySchema = vObject({
			id: vString(1, 128),
			name: vString(1, 128),
			upstream: vString(0, 512),
			license: vString(0, 128),
			installedVersion: vNullable(vString(1, 64)),
			enabled: vBoolean(),
			builtin: vBoolean(),
			status: vEnum(SOURCE_STATUSES),
			statusDetail: vNullable(vString(0, 512)),
			lastUpdated: vNullable(vString(0, 64)),
			// 扫描命中明细/跳过符号链接：host 随快照按行携带（可选，缺席=无）。
			scanFindings: vOptional(vArray(scanFindingSchema)),
			skippedSymlinks: vOptional(vArray(vString(0, 512))),
			// T4 推荐配置：registry 来源行推荐标记（bundled-core 不设；缺席=false）。
			recommended: vOptional(vBoolean()),
			// v2.2 行级专家清单与 custom 伪来源标记（宽松可选，旧 host 不投递）。
			files: vOptional(vArray(fileEntrySchema)),
			custom: vOptional(vBoolean()),
		});
		var conflictEntrySchema = vObject({
			expert: vString(1, 128),
			sources: vArray(vString(1, 128)),
		});
		/** M3/下载扫描确认门标记（快照内 `confirmRequired` 对象；字段宽松可选，兼容 host 投递形态漂移）。 */
		var ackMarkerSchema = vObject({
			id: vOptional(vString(1, 128)),
			method: vOptional(vString(0, 64)),
			ackField: vOptional(vString(0, 64)),
			reason: vOptional(vString(0, 256)),
		});
		/** T4 去重组成员：merged 花名册行级身份（name/title 可缺省，仅透出供 UI 参考）。 */
		var dedupMemberSchema = vObject({
			sourceId: vString(1, 128),
			file: vString(1, 512),
			name: vNullable(vString(0, 256)),
			title: vNullable(vString(0, 512)),
		});
		/**
		 * T4 去重组：仅含启用来源中 >1 成员的组。key 为不透明字符串
		 * （pair:<rel> / name:<norm>），client 原样回传 setDedupChoice；
		 * representative 为默认或用户手动（dedup.choice）选出的代表。
		 */
		var dedupGroupSchema = vObject({
			key: vString(1, 256),
			members: vArray(dedupMemberSchema),
			representative: vObject({ sourceId: vString(1, 128), file: vString(1, 512) }),
			rule: vString(0, 64),
		});
		/** v2.2 行级专家（来源行展开清单 + per-expert 启停）：enabled 为 roster 布尔，
		 *  disabled 为显式停用（host expertEnabled 缺省=启用、只存停用项）。 */
		var fileEntrySchema = vObject({
			file: vString(1, 512),
			slug: vOptional(vString(1, 128)),
			name: vNullable(vString(0, 256)),
			title: vNullable(vString(0, 512)),
			enabled: vBoolean(),
			shadowed: vOptional(vBoolean()),
			disabled: vOptional(vBoolean()),
			custom: vOptional(vBoolean()),
		});
		/** v2.2 自定义专家摘要（顶层 customExperts[]；prompt 不下发只给长度）。 */
		var customExpertSummarySchema = vObject({
			slug: vString(1, 128),
			name: vString(1, 256),
			description: vString(1, 512),
			division: vNullable(vString(0, 64)),
			emoji: vNullable(vString(0, 32)),
			promptLength: vInt(0),
			enabled: vBoolean(),
		});
		/** v2.2 自定义专家详情（getCustom 结果；prompt 全文随行）。 */
		var customExpertDetailSchema = vObject({
			slug: vString(1, 128),
			name: vString(1, 256),
			description: vString(1, 512),
			prompt: vString(1, 21000),
			division: vNullable(vString(0, 64)),
			emoji: vNullable(vString(0, 32)),
			enabled: vBoolean(),
			createdAt: vNullable(vString(0, 64)),
			updatedAt: vNullable(vString(0, 64)),
		});
		/** v2.2 saveCustom 输入（schema 上限放宽，精确校验由 host 产出 Error.key）。 */
		var customExpertInputSchema = vObject({
			slug: vOptional(vString(1, 128)),
			name: vString(1, 256),
			description: vString(1, 500),
			prompt: vString(1, 21000),
			division: vOptional(vNullable(vString(0, 64))),
			emoji: vOptional(vNullable(vString(0, 32))),
		});
		/** v2.2 收口 getExpertContent 结果：只读 persona 正文访问器。 */
		var expertContentSchema = vObject({
			content: vString(1, 200000),
		});
		var sourcesSnapshotSchema = vObject({
			revision: vInt(0),
			sources: vArray(sourceEntrySchema),
			mirrorPrefixes: vArray(vString(0, 256)),
			conflicts: vArray(conflictEntrySchema),
			confirmRequired: vOptional(ackMarkerSchema),
			// 下载扫描确认门：最近一次下载/更新的命中明细与跳过符号链接（顶层兜底，行级优先）。
			scanFindings: vOptional(vArray(scanFindingSchema)),
			skippedSymlinks: vOptional(vArray(vString(0, 512))),
			// T4 智能去重：启用来源中 >1 成员的去重组（缺席=旧 host 投递，按无组渲染）。
			dedupGroups: vOptional(vArray(dedupGroupSchema)),
			// T4 推荐配置：registry 顶层双语推荐说明（缺席/null=无说明）。
			recommendedNote: vOptional(vNullable(vString(0, 1024))),
			// v2.2 自定义专家摘要与降级错误（缺席=旧 host 投递，按空列表渲染）。
			customExperts: vOptional(vArray(customExpertSummarySchema)),
			customExpertsError: vOptional(vNullable(vString(0, 512))),
		});
		var channelParameter = vEnum(DOWNLOAD_CHANNELS);
		var revisionParameter = vInt(0);
		//#endregion

		//#region Typert Remote 严格 descriptor（host/client 共用；形态对照 agency-agents remote-contract）
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function sourceMethod(method, parameters, resultSchema) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec("ExpertSourcesState", resultSchema || sourcesSnapshotSchema),
			};
		}
		var EXPERT_SOURCES_DESCRIPTORS = [
			sourceMethod("getSources", []),
			sourceMethod("addSource", [jsonParameter("input", "ExpertSourceInput", sourceInputSchema), jsonParameter("expectedRevision", "number", revisionParameter)]),
			sourceMethod("removeSource", [jsonParameter("id", "string", vString(1, 128)), jsonParameter("expectedRevision", "number", revisionParameter)]),
			sourceMethod("setSourceEnabled", [jsonParameter("id", "string", vString(1, 128)), jsonParameter("enabled", "boolean", vBoolean()), jsonParameter("expectedRevision", "number", revisionParameter), jsonParameter("ackRisks", "boolean", vBoolean())]),
			sourceMethod("downloadSource", [jsonParameter("id", "string", vString(1, 128)), jsonParameter("channel", "string", channelParameter), jsonParameter("expectedRevision", "number", revisionParameter), jsonParameter("ackScan", "boolean", vBoolean())]),
			sourceMethod("updateSource", [jsonParameter("id", "string", vString(1, 128)), jsonParameter("channel", "string", channelParameter), jsonParameter("expectedRevision", "number", revisionParameter), jsonParameter("ackScan", "boolean", vBoolean())]),
			sourceMethod("setMirrorPrefixes", [jsonParameter("prefixes", "string[]", vArray(vString(0, 256))), jsonParameter("expectedRevision", "number", revisionParameter)]),
			// T4 智能去重：key 为快照 dedupGroups[].key（不透明字符串，≤256 与 host assertDedupKey 对齐），
			// sourceId 必须为组内成员（host 侧拒绝非成员）；与既有变更方法同型乐观锁。
			sourceMethod("setDedupChoice", [jsonParameter("key", "string", vString(1, 256)), jsonParameter("sourceId", "string", vString(1, 128)), jsonParameter("expectedRevision", "number", revisionParameter)]),
			sourceMethod("clearDedupChoice", [jsonParameter("key", "string", vString(1, 256)), jsonParameter("expectedRevision", "number", revisionParameter)]),
			// v2.2 自定义专家 CRUD 与 per-expert 启停（Agency expert-library 语义；
			// 错误按 host Error.key（invalid/duplicate/limit/readonly/conflict/missing）双语分支渲染。
			// custom 伪来源的启停走 saveCustom 的 enabled 参数（setExpertEnabled 对其 readonly 拒绝）。
			sourceMethod("saveCustom", [jsonParameter("input", "CustomExpertInput", customExpertInputSchema), jsonParameter("enabled", "boolean", vBoolean()), jsonParameter("expectedRevision", "number", revisionParameter)]),
			sourceMethod("deleteCustom", [jsonParameter("slug", "string", vString(1, 128)), jsonParameter("expectedRevision", "number", revisionParameter)]),
			// P7：清空软删除记录（无实变不 bump revision）。RPC 契约先到位；
			// 设置面板「清空已删除」按钮 UI 接线为移交项（T7/后续）。
			sourceMethod("cleanupCustomDeleted", [jsonParameter("expectedRevision", "number", revisionParameter)]),
			sourceMethod("getCustom", [jsonParameter("slug", "string", vString(1, 128))], customExpertDetailSchema),
			sourceMethod("setExpertEnabled", [jsonParameter("ref", "ExpertEnableRef", vObject({ sourceId: vString(1, 128), file: vString(1, 512) })), jsonParameter("enabled", "boolean", vBoolean()), jsonParameter("expectedRevision", "number", revisionParameter)]),
			// v2.2 收口 getExpertContent：只读 persona 正文（custom 伪来源 host 拒绝；
			// 路径穿越/缺失由 host seatbelt 按 missing 拒绝）。独立 result codec。
			sourceMethod("getExpertContent", [jsonParameter("ref", "ExpertEnableRef", vObject({ sourceId: vString(1, 128), file: vString(1, 512) }))], expertContentSchema),
		];
		var TYPERT_REMOTE = { package: PLUGIN_ID, descriptors: EXPERT_SOURCES_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式）
		var zh = {
			"settings.title": "dsh-expert-orchestrator",
			"settings.subtitle": "专家来源管理",
			"settings.desc": "管理专家来源包：启用、下载、更新与删除。",
			"settings.reload": "重新加载",
			"settings.loading": "正在加载来源…",
			"sources.empty": "暂无来源，请在下方添加自定义来源。",
			"sources.builtin": "内置",
			"sources.builtinHint": "内置来源不可停用或删除。",
			"sources.legacyHint": "随包迁移，不可删除。",
			"sources.license": "许可",
			"sources.version": "已装版本",
			"sources.notInstalled": "未安装",
			"sources.toggle": "启用 {name}",
			"sources.enable": "启用",
			"sources.removeToggle": "删除 {name}",
			"sources.downloadGithub": "GitHub 直连下载",
			"sources.downloadCdn": "大陆 CDN 加速",
			"sources.update": "更新",
			"sources.remove": "删除",
			"sources.removeConfirm": "确认删除",
			"sources.removed": "来源已删除。",
			"sources.enabledDone": "来源已启用。",
			"sources.ackTitle": "启用第三方来源「{name}」",
			"sources.ackBody": "第三方来源的 persona 将进入模型上下文。该来源已通过自动扫描，但自动扫描不等于安全审查，请自行确认信任该来源。",
			"sources.ackConfirm": "确认启用",
			"sources.ackCancel": "取消",
			"sources.ackCancelled": "已取消启用，来源保持停用。",
			"sources.disabledDone": "来源已停用。",
			"sources.scanTitle": "安装扫描命中的来源「{name}」",
			"sources.scanBody": "该下载已通过 sha256 验签；内容为第三方 persona，自动扫描非安全审查。命中明细如下，请自行确认是否信任并继续安装。",
			"sources.scanConfirm": "确认安装",
			"sources.scanCancel": "取消",
			"sources.scanCancelled": "已取消，本次下载未安装。",
			"sources.scanFindingsTitle": "扫描命中明细：",
			"sources.scanMore": "…另有 {count} 项命中未列出",
			"sources.scanHits": "扫描命中：{count} 项",
			"sources.skippedSymlinks": "已跳过符号链接：{count} 项",
			"sources.downloadStarted": "下载已开始，状态见来源行。",
			"sources.updateStarted": "更新已开始，状态见来源行。",
			"rec.title": "推荐配置",
			"rec.desc": "一键下载并启用推荐来源，并停用其余非内置来源；bundled-core 内置来源不受影响。",
			"rec.apply": "应用推荐配置",
			"rec.applying": "正在应用推荐配置…",
			"rec.previewTitle": "应用推荐配置（预览）",
			"rec.willDownload": "将下载并启用：",
			"rec.willEnableOnly": "将启用（已下载）：",
			"rec.willDisable": "将停用其余非内置、非推荐来源：",
			"rec.noChanges": "当前配置已符合推荐，无需变更。",
			"rec.noteLabel": "说明：",
			"rec.scanHint": "下载已过 sha256 验签；内容为第三方 persona，自动扫描非安全审查。若下载命中扫描规则将按本次确认继续，明细保留在来源行供查看。",
			"rec.confirm": "确认执行",
			"rec.cancel": "取消",
			"rec.done": "推荐配置已应用。",
			"rec.doneScan": "推荐配置已应用（{count} 项下载携带扫描命中，明细见来源行）。",
			"rec.recommended": "推荐",
			"dedup.title": "跨源去重",
			"dedup.desc": "同一专家在多个来源重复时仅代表来源生效；非代表成员灰显（shadowed），可手动指定代表或恢复默认规则。",
			"dedup.rule.agency-path-pair": "中英对照",
			"dedup.rule.name-match": "同名",
			"dedup.rule.mixed": "中英对照 + 同名",
			"dedup.representative": "当前代表",
			"dedup.shadowed": "已遮蔽",
			"dedup.setChoice": "设为代表",
			"dedup.clearChoice": "恢复默认",
			"dedup.done": "代表来源已更新。",
			"dedup.cleared": "已恢复默认代表规则。",
			"status.idle": "空闲",
			"status.downloading": "下载中…",
			"status.verifyFailed": "验签失败",
			"status.scanRejected": "安全扫描拒绝",
			"status.error": "出错",
			"status.ok": "正常",
			"conflicts.title": "跨源重名专家",
			"conflicts.desc": "以下专家名称在多个来源中同时存在，调用时需指定来源：",
			"conflicts.item": "{expert}：{sources}",
			"mirrors.title": "镜像前缀",
			"mirrors.desc": "GitHub 直连优先，失败后按序回退的镜像前缀（下载后 sha256 验签），每行一个；清空保存即恢复默认（ghproxy 类）。",
			"mirrors.save": "保存镜像前缀",
			"mirrors.saved": "镜像前缀已保存。",
			"mirrors.default": "默认：{list}",
			"mirrors.invalid": "镜像前缀需以 http:// 或 https:// 开头。",
			"add.title": "添加自定义来源",
			"add.placeholder": "GitHub 仓库 URL（https://github.com/owner/repo）或本地路径",
			"add.submit": "添加",
			"add.success": "来源已添加，请下载后使用。",
			"add.invalid": "请输入 GitHub 仓库 URL 或本地路径。",
			"custom.title": "自定义专家",
			"custom.empty": "暂无自定义专家。",
			"custom.desc": "自定义专家进入合并花名册（可与来源专家重名，由去重引擎归组）。启停在此管理；来源专家的启停在对应来源行。",
			"custom.quota": "{count} / {max}",
			"custom.new": "新建自定义专家",
			"custom.copy": "从来源专家复制为自定义",
			"custom.copyPick": "选择来源专家：",
			"custom.copyFrom": "复制自：{origin}",
			"custom.copyLoading": "正在读取来源专家正文并预填…",
			"custom.copyFailed": "正文读取失败，请手动粘贴提示词。",
			"custom.edit": "编辑",
			"custom.delete": "删除",
			"custom.deleteConfirm": "确认删除",
			"custom.deleteSoftHint": "删除为软删除：记录保留在 custom-experts.json，可用相同 slug 重建恢复。",
			"custom.deleted": "自定义专家已删除。",
			"custom.saved": "自定义专家已保存。",
			"custom.toggled": "启用状态已更新。",
			"custom.done": "操作已完成。",
			"custom.form.name": "名称",
			"custom.form.description": "描述",
			"custom.form.prompt": "提示词（prompt）",
			"custom.form.division": "分区（可选）",
			"custom.form.emoji": "图标 emoji（可选）",
			"custom.form.slug": "slug（只读）",
			"custom.form.enabled": "启用",
			"custom.form.submit": "保存",
			"custom.form.cancel": "取消",
			"custom.limitReached": "自定义专家数量已达上限（{max}），删除后可新建。",
			"custom.disabledBadge": "已停用",
			"custom.badge": "自定义",
			"custom.manageHint": "在自定义专家区管理",
			"custom.promptLength": "提示词 {count} 字",
			"custom.err.invalid": "输入不合法：请检查名称（1-40）、描述（1-160）、提示词（1-20000）与分区、emoji 格式。",
			"custom.err.duplicate": "同名自定义专家已存在（活跃列表内不可重名；与来源专家重名允许，会由去重引擎归组）。",
			"custom.err.limit": "自定义专家数量已达上限（200）。",
			"custom.err.readonly": "内置与来源专家只读：请在对应来源行管理。",
			"custom.err.conflict": "状态冲突：快照已过期，请刷新后重试。",
			"custom.err.missing": "目标专家不存在（可能已被删除）。",
			"files.toggle": "专家文件",
			"files.empty": "该来源暂无文件清单。",
			"conflicts.classes": "冲突三分类：resolved-by-dedup（去重已消解）与 basename-only（仅同名文件）不报警，此处仅列 unresolved（未消解歧义）项。",
			"nav.label": "分区导航",
			"nav.recommended": "推荐配置",
			"nav.sources": "专家来源",
			"nav.dedup": "去重",
			"nav.custom": "自定义专家",
			"nav.mirrors": "镜像",
			"nav.add": "添加来源",
			"mirrors.dirty": "镜像前缀有未保存修改",
			"settings.conflictGeneric": "保存冲突：设置已被其他窗口修改，请刷新后重试。",
			"sources.expandHint": "展开或收起 {name} 的专家文件列表",
			"tb.title": "任务板",
			"tb.guide.desc": "四泳道任务板：需要注意 / 进行中 / 待处理 / 已完成。",
			"tb.lane.attention": "需要注意",
			"tb.lane.running": "进行中",
			"tb.lane.todo": "待处理",
			"tb.lane.done": "已完成",
			"tb.lane.fold": "折叠或展开该泳道",
			"tb.badge.aria": "任务板，{n} 个进行中",
			"tb.blocked": "阻塞",
			"tb.blocked.n": "阻塞 {n}",
			"tb.failed": "失败",
			"tb.waiting": "等待 {taskId}（{owner} · {status}）",
			"tb.copyId": "复制任务 ID",
			"tb.copied": "已复制",
			"tb.refresh": "刷新",
			"tb.refresh.at": "刷新于 {time}",
			"tb.updatedCount": "已更新 · {n} 项变化",
			"tb.updatedAgo": "{n} 分钟前更新",
			"tb.updatedJust": "刚刚更新",
			"tb.autorefresh": "自动刷新",
			"tb.autorefresh.off": "自动刷新已关闭",
			"tb.filter": "筛选",
			"tb.filter.reset": "重置",
			"tb.filter.clear": "清除过滤",
			"tb.filter.blockedOnly": "仅看阻塞",
			"tb.filter.empty.title": "无匹配任务",
			"tb.status.draft": "草稿",
			"tb.status.pending": "待处理",
			"tb.status.ready": "就绪",
			"tb.status.running": "进行中",
			"tb.status.done": "已完成",
			"tb.status.failed": "失败",
			"tb.status.rejected": "已拒绝",
			"tb.status.escalated": "已升级",
			"tb.status.unknown": "未知状态",
			"tb.empty.noBoard.title": "还没有任务板",
			"tb.empty.noBoard.body": "编排器会在会话工作区 .expert-taskboards/ 下创建任务板（顶层恰一个 *.json 时展示）。确认编排已启动后点击「重新检测」。",
			"tb.empty.noBoard.guide": "查看使用说明",
			"tb.empty.ambiguous.title": "检测到多个任务板",
			"tb.empty.ambiguous.body": "任务板目录下有多个 *.json，只读看板不做猜测。请保留唯一一个文件后重新检测。",
			"tb.empty.ambiguous.chat": "来自聊天链接",
			"tb.empty.broken.title": "任务板格式无法解析",
			"tb.empty.broken.body": "文件不是有效的任务板 JSON（缺 tasks，或任务缺 id/title/status）。",
			"tb.empty.board.title": "任务板已就绪，还没有任务",
			"tb.empty.board.body": "编排器尚未创建任何任务。",
			"tb.redetect": "重新检测",
			"tb.error.title": "任务板加载失败",
			"tb.error.retry": "重试",
			"tb.error.stale": "刷新失败，显示上次数据",
			"tb.help.body": "任务板是只读看板：编排器在会话工作区 .expert-taskboards/ 下维护 *.json，本面板自动展示其四泳道视图（需要注意 / 进行中 / 待处理 / 已完成）。顶栏可开关自动刷新；任务较多时提供状态、负责人与「仅看阻塞」筛选。点击卡片展开详情。",
			"tb.aria.owner": "负责人 {owner}",
			"tb.aria.blocked": "，{n} 项阻塞",
			"tb.detail.summary": "摘要",
			"tb.complete.title": "全部完成",
			"tb.complete.count": "{done}/{total} 已完成",
			"tb.aria.allDone": "全部任务已完成",
			"tb.aria.laneFolded": "已完成泳道已折叠，{n} 项已隐藏",
			"tb.aria.laneExpanded": "已完成泳道已展开",
			"tb.aria.filtered": "筛选后 {n} 项",
			"tb.scope.count": "{n} 个文件",
			"tb.lane.empty": "无任务",
		};
		var en = {
			"settings.title": "dsh-expert-orchestrator",
			"settings.subtitle": "Expert source management",
			"settings.desc": "Manage expert source packages: enable, download, update and remove.",
			"settings.reload": "Reload",
			"settings.loading": "Loading sources…",
			"sources.empty": "No sources yet. Add a custom source below.",
			"sources.builtin": "Built-in",
			"sources.builtinHint": "The built-in source cannot be disabled or removed.",
			"sources.legacyHint": "Migrated with the package; cannot be removed.",
			"sources.license": "License",
			"sources.version": "Installed version",
			"sources.notInstalled": "Not installed",
			"sources.toggle": "Enable {name}",
			"sources.enable": "Enable",
			"sources.removeToggle": "Remove {name}",
			"sources.downloadGithub": "Download via GitHub",
			"sources.downloadCdn": "Mainland CDN",
			"sources.update": "Update",
			"sources.remove": "Remove",
			"sources.removeConfirm": "Confirm remove",
			"sources.removed": "Source removed.",
			"sources.enabledDone": "Source enabled.",
			"sources.ackTitle": "Enable third-party source \"{name}\"",
			"sources.ackBody": "Personas from this third-party source will enter the model context. It has passed the automated scan, but an automated scan is not a security review — confirm that you trust this source.",
			"sources.ackConfirm": "Enable anyway",
			"sources.ackCancel": "Cancel",
			"sources.ackCancelled": "Enable cancelled; the source stays disabled.",
			"sources.disabledDone": "Source disabled.",
			"sources.scanTitle": "Install source \"{name}\" with scan hits",
			"sources.scanBody": "The download passed sha256 verification; the content is third-party personas. The automated scan is not a security review. Hit details are listed below — confirm that you trust it before installing.",
			"sources.scanConfirm": "Install anyway",
			"sources.scanCancel": "Cancel",
			"sources.scanCancelled": "Cancelled; this download was not installed.",
			"sources.scanFindingsTitle": "Scan hit details:",
			"sources.scanMore": "…{count} more hits not listed",
			"sources.scanHits": "Scan hits: {count}",
			"sources.skippedSymlinks": "Skipped symlinks: {count}",
			"sources.downloadStarted": "Download started; see the row status.",
			"sources.updateStarted": "Update started; see the row status.",
			"rec.title": "Recommended setup",
			"rec.desc": "Download and enable the recommended sources in one click and disable the other non-built-in ones; the built-in bundled-core source is untouched.",
			"rec.apply": "Apply recommended setup",
			"rec.applying": "Applying the recommended setup…",
			"rec.previewTitle": "Apply recommended setup (preview)",
			"rec.willDownload": "Will download and enable:",
			"rec.willEnableOnly": "Will enable (already downloaded):",
			"rec.willDisable": "Will disable the other non-built-in, non-recommended sources:",
			"rec.noChanges": "The current setup already matches the recommendation; nothing to change.",
			"rec.noteLabel": "Note:",
			"rec.scanHint": "Downloads passed sha256 verification; the content is third-party personas and an automated scan is not a security review. Downloads that trip scan rules continue as confirmed here, and their details stay visible on the source rows.",
			"rec.confirm": "Apply now",
			"rec.cancel": "Cancel",
			"rec.done": "Recommended setup applied.",
			"rec.doneScan": "Recommended setup applied ({count} downloads carried scan hits; see the source rows).",
			"rec.recommended": "Recommended",
			"dedup.title": "Cross-source dedup",
			"dedup.desc": "When the same expert exists in several sources only the representative takes effect; non-representative members are shadowed. Pick a representative manually or restore the default rule.",
			"dedup.rule.agency-path-pair": "EN↔ZH pair",
			"dedup.rule.name-match": "Same name",
			"dedup.rule.mixed": "EN↔ZH pair + same name",
			"dedup.representative": "Current representative",
			"dedup.shadowed": "Shadowed",
			"dedup.setChoice": "Set as representative",
			"dedup.clearChoice": "Restore default",
			"dedup.done": "Representative source updated.",
			"dedup.cleared": "Default representative rule restored.",
			"status.idle": "Idle",
			"status.downloading": "Downloading…",
			"status.verifyFailed": "Verification failed",
			"status.scanRejected": "Rejected by security scan",
			"status.error": "Error",
			"status.ok": "OK",
			"conflicts.title": "Duplicate experts across sources",
			"conflicts.desc": "These expert names exist in multiple sources; specify the source when summoning:",
			"conflicts.item": "{expert}: {sources}",
			"mirrors.title": "Mirror prefixes",
			"mirrors.desc": "Mirror prefixes tried in order after the GitHub direct fetch fails (downloads are sha256-verified), one per line; save empty to restore defaults (ghproxy-style).",
			"mirrors.save": "Save mirror prefixes",
			"mirrors.saved": "Mirror prefixes saved.",
			"mirrors.default": "Default: {list}",
			"mirrors.invalid": "Mirror prefixes must start with http:// or https://.",
			"add.title": "Add a custom source",
			"add.placeholder": "GitHub repository URL (https://github.com/owner/repo) or local path",
			"add.submit": "Add",
			"add.success": "Source added. Download it to make it available.",
			"add.invalid": "Enter a GitHub repository URL or a local path.",
			"custom.title": "Custom experts",
			"custom.empty": "No custom experts yet.",
			"custom.desc": "Custom experts join the merged roster (same-name as source experts is allowed; the dedup engine groups them). Enable them here; per-expert toggles for source experts live on their source rows.",
			"custom.quota": "{count} / {max}",
			"custom.new": "New custom expert",
			"custom.copy": "Copy from a source expert",
			"custom.copyPick": "Pick a source expert:",
			"custom.copyFrom": "Copied from: {origin}",
			"custom.copyLoading": "Fetching the source expert prompt and prefilling…",
			"custom.copyFailed": "Failed to read the prompt; paste it manually.",
			"custom.edit": "Edit",
			"custom.delete": "Delete",
			"custom.deleteConfirm": "Confirm delete",
			"custom.deleteSoftHint": "Deletion is soft: the record stays in custom-experts.json and can be restored by re-creating with the same slug.",
			"custom.deleted": "Custom expert deleted.",
			"custom.saved": "Custom expert saved.",
			"custom.toggled": "Enabled state updated.",
			"custom.done": "Done.",
			"custom.form.name": "Name",
			"custom.form.description": "Description",
			"custom.form.prompt": "Prompt",
			"custom.form.division": "Division (optional)",
			"custom.form.emoji": "Emoji icon (optional)",
			"custom.form.slug": "slug (read-only)",
			"custom.form.enabled": "Enabled",
			"custom.form.submit": "Save",
			"custom.form.cancel": "Cancel",
			"custom.limitReached": "Custom expert limit reached ({max}); delete one to create more.",
			"custom.disabledBadge": "Disabled",
			"custom.badge": "Custom",
			"custom.manageHint": "Manage in the custom experts section",
			"custom.promptLength": "Prompt {count} chars",
			"custom.err.invalid": "Invalid input: check name (1-40), description (1-160), prompt (1-20000) and division/emoji formats.",
			"custom.err.duplicate": "A custom expert with the same name already exists (no duplicates among active customs; same-name with source experts is allowed and grouped by dedup).",
			"custom.err.limit": "Custom expert limit reached (200).",
			"custom.err.readonly": "Built-in and source experts are read-only: manage them on their source rows.",
			"custom.err.conflict": "State conflict: the snapshot expired, please reload and retry.",
			"custom.err.missing": "Target expert not found (it may have been deleted).",
			"files.toggle": "Expert files",
			"files.empty": "No file listing for this source.",
			"conflicts.classes": "Conflict classes: resolved-by-dedup (already grouped) and basename-only (same filename only) never alarm; only unresolved ambiguities are listed here.",
			"nav.label": "Section navigation",
			"nav.recommended": "Recommended",
			"nav.sources": "Sources",
			"nav.dedup": "Deduplication",
			"nav.custom": "Custom experts",
			"nav.mirrors": "Mirrors",
			"nav.add": "Add a source",
			"mirrors.dirty": "Unsaved mirror prefix changes",
			"settings.conflictGeneric": "Save conflict: settings were changed elsewhere. Refresh and try again.",
			"sources.expandHint": "Expand or collapse expert files for {name}",
			"tb.title": "Task Board",
			"tb.guide.desc": "Four-lane task board: Needs attention / Running / Pending / Done.",
			"tb.lane.attention": "Needs attention",
			"tb.lane.running": "Running",
			"tb.lane.todo": "Pending",
			"tb.lane.done": "Done",
			"tb.lane.fold": "Collapse or expand this lane",
			"tb.badge.aria": "Task Board, {n} running",
			"tb.blocked": "Blocked",
			"tb.blocked.n": "Blocked {n}",
			"tb.failed": "Failed",
			"tb.waiting": "Waiting for {taskId} ({owner} · {status})",
			"tb.copyId": "Copy task ID",
			"tb.copied": "Copied",
			"tb.refresh": "Refresh",
			"tb.refresh.at": "Refreshed at {time}",
			"tb.updatedCount": "Updated · {n} changes",
			"tb.updatedAgo": "Updated {n} min ago",
			"tb.updatedJust": "Updated just now",
			"tb.autorefresh": "Auto refresh",
			"tb.autorefresh.off": "Auto refresh is off",
			"tb.filter": "Filter",
			"tb.filter.reset": "Reset",
			"tb.filter.clear": "Clear filters",
			"tb.filter.blockedOnly": "Blocked only",
			"tb.filter.empty.title": "No matching tasks",
			"tb.status.draft": "Draft",
			"tb.status.pending": "Pending",
			"tb.status.ready": "Ready",
			"tb.status.running": "Running",
			"tb.status.done": "Done",
			"tb.status.failed": "Failed",
			"tb.status.rejected": "Rejected",
			"tb.status.escalated": "Escalated",
			"tb.status.unknown": "Unknown status",
			"tb.empty.noBoard.title": "No task board yet",
			"tb.empty.noBoard.body": "The orchestrator creates the board under the session workspace .expert-taskboards/ (shown when there is exactly one top-level *.json). Start an orchestration session, then re-detect.",
			"tb.empty.noBoard.guide": "View guide",
			"tb.empty.ambiguous.title": "Multiple task boards found",
			"tb.empty.ambiguous.body": "Several *.json files exist in the board directory; the read-only board does not guess. Keep exactly one file, then re-detect.",
			"tb.empty.ambiguous.chat": "From chat link",
			"tb.empty.broken.title": "Task board could not be parsed",
			"tb.empty.broken.body": "The file is not a valid task board JSON (missing tasks, or a task lacks id/title/status).",
			"tb.empty.board.title": "Task board is ready — no tasks yet",
			"tb.empty.board.body": "The orchestrator has not created any tasks.",
			"tb.redetect": "Re-detect",
			"tb.error.title": "Failed to load task board",
			"tb.error.retry": "Retry",
			"tb.error.stale": "Refresh failed, showing last data",
			"tb.help.body": "The task board is read-only: the orchestrator maintains *.json under the session workspace .expert-taskboards/ and this panel shows its four-lane view (Needs attention / Running / Pending / Done). Toggle auto refresh in the toolbar; with many tasks, filter by status, owner or blocked-only. Click a card to expand details.",
			"tb.aria.owner": "owner {owner}",
			"tb.aria.blocked": ", blocked by {n}",
			"tb.detail.summary": "Summary",
			"tb.complete.title": "All done",
			"tb.complete.count": "{done}/{total} completed",
			"tb.aria.allDone": "All tasks are completed",
			"tb.aria.laneFolded": "Done lane collapsed, {n} items hidden",
			"tb.aria.laneExpanded": "Done lane expanded",
			"tb.aria.filtered": "{n} items after filter",
			"tb.scope.count": "{n} files",
			"tb.lane.empty": "No tasks",
		};
		/** 双语 key 集一致性自检：缺漏仅告警不致崩溃，交付前以脚本核验为全。 */
		function assertSameKeys(a, b) {
			var missing = Object.keys(a).filter((key) => !(key in b));
			var extra = Object.keys(b).filter((key) => !(key in a));
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-expert-orchestrator] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除）
		// 设置页 T2：类名前缀 .eso-set-*，全量 token 化（--dsw-alias-*/--dsw-radius-*，零十六进制字面量；
		// 唯一豁免：弹窗 scrim rgba(0,0,0,.5)）。与任务板 .eso-tb-* 同一设计系统（docs/settings-visual-spec.md v1.0 §10）。
		var CSS = [
			// —— 骨架：单列滚动 + 区块 16px gap + border-top 分隔（首个区块豁免）
			".eso-set-root{position:relative;display:flex;flex-direction:column;gap:16px;padding:16px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;}",
			".eso-set-header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:36px;}",
			".eso-set-title{margin:0;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);}",
			".eso-set-subtitle{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-desc{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);}",
			".eso-set-spacer{flex:1;}",
			// —— 顶部锚点分区条
			".eso-set-nav{display:flex;flex-wrap:wrap;gap:4px;}",
			".eso-set-navbtn{display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;cursor:pointer;transition:background 150ms ease,border-color 150ms ease,color 150ms ease;}",
			".eso-set-navbtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}",
			".eso-set-navbtn:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			// —— 全局反馈带（错误条 role=alert / 操作回执 aria-live=polite）
			".eso-set-alert{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:28px;padding:4px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-fill-l1);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}",
			".eso-set-notice{min-height:20px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;}",
			// —— 分区
			".eso-set-section{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;scroll-margin-top:8px;}",
			".eso-set-section[data-first]{border-top:0;padding-top:0;}",
			".eso-set-section-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}",
			".eso-set-section-title{margin:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);}",
			".eso-set-quota{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}",
			".eso-set-quota[data-full]{color:var(--dsw-alias-state-warn-label);}",
			".eso-set-hint{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);}",
			".eso-set-fineprint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-dangertext{font-size:11px;font-weight:600;color:var(--dsw-alias-state-error-primary);}",
			// —— 来源行
			".eso-set-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}",
			".eso-set-row{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);animation:eso-set-appear 150ms ease-out;}",
			".eso-set-row:hover{border-color:var(--dsw-alias-border-l2);}",
			".eso-set-row[data-greyed] .eso-set-name{font-weight:600;color:var(--dsw-alias-label-secondary);}",
			".eso-set-row-main{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;}",
			".eso-set-name{min-width:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-word;}",
			".eso-set-link{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-link);text-decoration:underline;text-underline-offset:2px;}",
			".eso-set-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-status{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}",
			".eso-set-status[data-tone=\"danger\"]{color:var(--dsw-alias-state-error-primary);font-weight:600;}",
			".eso-set-status-detail{display:block;width:100%;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);word-break:break-all;}",
			".eso-set-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}",
			// —— 按钮（24px 高）/ 链接按钮
			".eso-set-btn{display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:22px;cursor:pointer;transition:background 150ms ease,border-color 150ms ease,color 150ms ease;}",
			".eso-set-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}",
			".eso-set-btn:active:not(:disabled){background:var(--dsw-alias-fill-l1);}",
			".eso-set-btn:disabled{opacity:0.5;cursor:not-allowed;}",
			".eso-set-btn[data-danger]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}",
			".eso-set-btn[data-danger]:hover:not(:disabled){background:var(--dsw-alias-fill-l1);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}",
			".eso-set-btn[data-danger][data-confirm]{background:var(--dsw-alias-fill-l1);}",
			".eso-set-btn[data-dirty]{background:var(--dsw-alias-fill-l1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}",
			".eso-set-btn:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-set-linkbtn{border:0;background:none;padding:0;font-size:11px;color:var(--dsw-alias-link);cursor:pointer;}",
			".eso-set-linkbtn:hover{text-decoration:underline;text-underline-offset:2px;}",
			".eso-set-linkbtn:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			// —— 徽标（18px 高，fill-l1 底，data-kind 语义色阶，弱化不靠透明度）
			".eso-set-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-fill-l1);font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
			".eso-set-badge[data-kind=\"recommended\"],.eso-set-badge[data-kind=\"representative\"]{font-weight:600;color:var(--dsw-alias-label-secondary);}",
			".eso-set-badge[data-kind=\"representative\"]{border:1px solid var(--dsw-alias-border-l2);padding:0 5px;}",
			".eso-set-badge[data-kind=\"shadowed\"]{font-weight:400;color:var(--dsw-alias-label-quaternary);}",
			".eso-set-badge[data-kind=\"builtin\"],.eso-set-badge[data-kind=\"custom\"]{font-weight:500;}",
			".eso-set-warnbadge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-fill-l1);font-size:11px;font-weight:600;color:var(--dsw-alias-state-warn-label);white-space:nowrap;}",
			".eso-set-warnbadge svg{width:12px;height:12px;flex:none;}",
			// —— 状态点（6px 自绘，data-tone 映射；downloading 2s 脉冲）
			".eso-set-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-quaternary);}",
			".eso-set-dot[data-tone=\"ok\"]{background:var(--dsw-alias-state-success-primary);}",
			".eso-set-dot[data-tone=\"downloading\"]{background:var(--dsw-alias-state-business-primary);animation:eso-set-pulse 2s ease-in-out infinite;}",
			".eso-set-dot[data-tone=\"verifyFailed\"]{background:var(--dsw-alias-state-error-secondary);}",
			".eso-set-dot[data-tone=\"scanRejected\"],.eso-set-dot[data-tone=\"error\"],.eso-set-dot[data-tone=\"danger\"]{background:var(--dsw-alias-state-error-primary);}",
			".eso-set-dot[data-tone=\"idle\"]{background:var(--dsw-alias-state-idle-primary);}",
			// —— switch（28×16，input checkbox 外观覆盖；off=fill-l2/quaternary 旋钮，on=accent/bg-base 旋钮）
			".eso-set-toggle{display:inline-flex;align-items:center;gap:6px;}",
			".eso-set-switch{appearance:none;-webkit-appearance:none;position:relative;width:28px;height:16px;margin:0;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-fill-l2);cursor:pointer;flex:none;transition:background 150ms ease;}",
			".eso-set-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-quaternary);transition:transform 150ms ease,background 150ms ease;}",
			".eso-set-switch:checked{background:var(--dsw-alias-interactive-bg-hover-accent);}",
			".eso-set-switch:checked::after{transform:translateX(12px);background:var(--dsw-alias-bg-base);}",
			".eso-set-switch:disabled{opacity:0.5;cursor:not-allowed;}",
			".eso-set-switch:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			// —— 行内展开（文件列表）：grid 0fr→1fr 高度过渡 200ms，行级 disclosure 可多开
			".eso-set-detailwrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows 200ms cubic-bezier(0.2,0,0,1);}",
			".eso-set-row[data-expanded] .eso-set-detailwrap{grid-template-rows:1fr;}",
			".eso-set-detailwrap > .eso-set-files{min-height:0;overflow:hidden;} ",
			// 折叠态把文件列表移出 Tab 序（visibility 延迟随高度过渡，展开即恢复可聚焦）
			".eso-set-detailwrap > .eso-set-files{visibility:hidden;transition:visibility 0s linear 200ms;}",
			".eso-set-row[data-expanded] .eso-set-detailwrap > .eso-set-files{visibility:visible;transition:visibility 0s;}",
			".eso-set-files{list-style:none;margin:0;padding:8px 0 0 12px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px;}",
			".eso-set-file-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:24px;}",
			".eso-set-file-name{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}",
			".eso-set-path{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;}",
			".eso-set-file-row[data-disabled] .eso-set-path{color:var(--dsw-alias-label-quaternary);}",
			// —— 去重组（shadowed 语义色阶，禁 opacity 弱化）
			".eso-set-dedup{display:flex;flex-direction:column;gap:6px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);}",
			".eso-set-dedup:hover{border-color:var(--dsw-alias-border-l2);}",
			".eso-set-dedup-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}",
			// conflicts 子区：11px tertiary 弱化层（并入去重区，整区空则隐藏）
			".eso-set-conflicts{display:flex;flex-direction:column;gap:4px;}",
			".eso-set-conflictstitle{margin:0;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-conflicts ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-member{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:24px;font-size:12px;}",
			".eso-set-member-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".eso-set-member[data-shadowed] .eso-set-member-name{font-weight:400;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-member[data-shadowed] .eso-set-path{color:var(--dsw-alias-label-quaternary);}",
			// —— 表单
			".eso-set-form{display:flex;flex-direction:column;gap:8px;}",
			".eso-set-formcard{display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);}",
			".eso-set-form-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}",
			".eso-set-form-label{min-width:140px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}",
			".eso-set-input,.eso-set-select,.eso-set-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:4px 8px;font:inherit;font-size:12px;}",
			".eso-set-input:focus,.eso-set-select:focus,.eso-set-textarea:focus{outline:2px solid var(--dsw-alias-link);outline-offset:0;}",
			".eso-set-textarea{min-height:72px;resize:vertical;padding:6px 8px;line-height:17px;}",
			".eso-set-promptcount{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}",
			".eso-set-promptcount[data-warn]{color:var(--dsw-alias-state-warn-label);}",
			".eso-set-add{display:flex;gap:8px;}",
			".eso-set-add .eso-set-input{flex:1;width:auto;}",
			".eso-set-dirty{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			// —— 弹窗（统一 alertdialog 规格：max-width 440 / layer-1 / border-l2 / radius-lg / 零投影；scrim 为唯一豁免色）
			".eso-set-modal-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5);}",
			".eso-set-modal{display:flex;flex-direction:column;gap:8px;width:100%;max-width:440px;padding:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary);}",
			".eso-set-modal-title{display:flex;align-items:center;gap:6px;margin:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);}",
			".eso-set-modal-body{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}",
			".eso-set-modal-list{max-height:180px;overflow:auto;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;}",
			".eso-set-modal-list li{position:relative;padding-left:10px;}",
			".eso-set-modal-list[data-warn] li::before{content:\"\";position:absolute;left:0;top:7px;width:4px;height:4px;background:var(--dsw-alias-state-warn-primary);}",
			".eso-set-modal-grouptitle{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-modal-more{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-set-modal-actions{display:flex;justify-content:flex-end;gap:8px;}",
			// —— 动效（仅 4 个；reduced-motion 归零；document.hidden 经 data-eso-set-hidden 暂停脉冲）
			"@keyframes eso-set-appear{from{opacity:0;}to{opacity:1;}}",
			"@keyframes eso-set-pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}",
			".eso-set-root[data-eso-set-hidden] .eso-set-dot[data-tone=\"downloading\"]{animation:none;}",
			"@media (prefers-reduced-motion: reduce){.eso-set-root *,.eso-set-root *::before,.eso-set-root *::after{animation:none !important;transition:none !important;}}",
		].join("\n");
		//#endregion

		//#region 工具
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message}}。 */
		function unwrap(result) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			throw new Error(detail);
		}
		/**
		 * M3 安全确认门（与 host 侧 ack 门配套，最终标记形态以 host 投递说明为准）：
		 * 未携带 ackRisks:true 启用非注册表来源时，host 返回需确认标记而不生效。
		 * 兼容两种返回形态，判定集中于此，host 签名落地后只需改这一处：
		 *   (a) RemoteResult 错误：error.code 命中约定码，或 message 命中关键词；
		 *   (b) 快照返回值内标记字段：host 落地形态为 `confirmRequired` 对象
		 *       （{id, method, ackField, reason}）；布尔旧形态
		 *       （ackRequired / needsAck / pendingAck === true）继续兼容。
		 */
		var ACK_REQUIRED_RE = /ackRisks|ack[_ -]?required|EXPERT_SOURCE_ACK|需要确认|确认后/i;
		var ACK_MARKER_FIELDS = ["ackRequired", "needsAck", "pendingAck"];
		function isAckRequiredError(error) {
			if (error == null) return false;
			return error.code === "expertSourceAckRequired" || ACK_REQUIRED_RE.test(String(error.message || ""));
		}
		function hasAckMarker(value) {
			if (value == null || typeof value !== "object") return false;
			if (ACK_MARKER_FIELDS.some(function (key) { return value[key] === true; })) return true;
			return value.confirmRequired != null && typeof value.confirmRequired === "object";
		}
		/**
		 * 下载扫描确认门（与 M3 ack 门同构；标记形态以 host 投递说明为准，宽松兼容）：
		 * sha256 验签通过但内容扫描命中时，host 返回 scanFindings + confirmRequired
		 * 标记且不落地安装；客户端弹双语警告对话框，确认后带 ackScan:true 重发。
		 */
		var SCAN_CONFIRM_RE = /ackScan|scan[_ -]?confirm|EXPERT_SOURCE_SCAN|扫描命中|扫描确认/i;
		function isScanConfirmError(error) {
			if (error == null) return false;
			return error.code === "expertSourceScanConfirmRequired" || SCAN_CONFIRM_RE.test(String(error.message || ""));
		}
		/** 命中明细提取：快照顶层优先，confirmRequired 内嵌兜底。 */
		function getScanFindings(value) {
			if (value == null || typeof value !== "object") return null;
			var direct = value.scanFindings;
			if (Array.isArray(direct) && direct.length > 0) return direct;
			var marker = value.confirmRequired;
			if (marker != null && typeof marker === "object") {
				var nested = marker.scanFindings;
				if (Array.isArray(nested) && nested.length > 0) return nested;
			}
			return null;
		}
		/** 扫描确认门标记判定：ackScan/download/update 语义的 confirmRequired 才触发确认流。 */
		function hasScanConfirmMarker(value) {
			if (value == null || typeof value !== "object") return false;
			var marker = value.confirmRequired;
			if (marker == null || typeof marker !== "object") return false;
			if (marker.ackField === "ackScan" || marker.method === "downloadSource" || marker.method === "updateSource") return true;
			// 宽松兜底：非 ackRisks 的确认门且携带命中明细时按扫描门处理。
			return marker.ackField !== "ackRisks" && getScanFindings(value) != null;
		}
		// —— 纯函数区（SET-PURE）：自包含、无组件闭包引用，供 test/client-settings.selftest.mjs
		// 按标记提取后以 new Function 直接执行——被测代码即交付代码（先例：TB-PURE）。
		// SET-PURE-BEGIN
		/** 宿主内置来源 id：不可停用、不可删除。 */
		var BUILTIN_SOURCE_ID = "bundled-core";
		/** legacy 迁移冻结来源：host 侧拒删（随包迁移数据），UI 隐藏删除按钮。 */
		var LEGACY_SOURCE_ID = "legacy-adapted";
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** v2.2 host Error.key 提取：优先 e.key，其次 message 前缀 `key:`，兜底正文词匹配。 */
		var CUSTOM_ERROR_KEYS = ["invalid", "duplicate", "limit", "readonly", "conflict", "missing"];
		function errorKeyOf(cause) {
			if (cause != null && typeof cause.key === "string" && CUSTOM_ERROR_KEYS.indexOf(cause.key) >= 0) return cause.key;
			var text = messageOf(cause);
			for (var index = 0; index < CUSTOM_ERROR_KEYS.length; index++) {
				var key = CUSTOM_ERROR_KEYS[index];
				if (text.slice(0, key.length + 1) === key + ":") return key;
			}
			var match = /\b(invalid|duplicate|limit|readonly|conflict|missing)\b/i.exec(text);
			return match == null ? null : match[1].toLowerCase();
		}
		function firstText(record, keys) {
			for (var key of keys) {
				var text = record[key];
				if (typeof text === "string" && text !== "") return text;
			}
			return "";
		}
		/** 命中明细单行摘要：host 字段名未冻结（file/rule/detail 等以投递为准），逐组取首选字段。 */
		function findingText(finding) {
			if (finding == null || typeof finding !== "object") return String(finding);
			var parts = [];
			var primary = firstText(finding, ["file", "path", "entry", "target", "expert"]);
			var rule = firstText(finding, ["rule", "pattern", "match", "category", "reason"]);
			var detail = firstText(finding, ["detail", "message", "excerpt", "line", "description"]);
			if (primary !== "") parts.push(primary);
			if (rule !== "") parts.push(rule);
			if (detail !== "") parts.push(detail);
			if (parts.length === 0) {
				for (var key of Object.keys(finding)) {
					if (finding[key]) parts.push(finding[key]);
					if (parts.length >= 2) break;
				}
			}
			return parts.join(" · ") || "—";
		}
		var GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;
		var LOCAL_PATH_RE = /^(~\/|\/|\.\/|\.\.\/)[^\s]*$/;
		function looksLikeSourceUrl(value) {
			return GITHUB_URL_RE.test(value) || LOCAL_PATH_RE.test(value);
		}
		function parseMirrorPrefixes(text) {
			return String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
		}
		/** 镜像前缀校验：全部须为 http(s) 绝对地址前缀。 */
		function mirrorPrefixesValid(list) {
			return list.every(function (prefix) { return /^https?:\/\//.test(prefix); });
		}
		/** 来源状态 → 状态点 data-tone（visual-spec §3.2 唯一映射表；未知状态回退 idle，不崩溃）。 */
		function statusToneOf(source) {
			var status = source != null ? source.status : null;
			if (status === "ok") return "ok";
			if (status === "downloading") return "downloading";
			if (status === "verifyFailed" || status === "scanRejected" || status === "error") return status;
			return "idle";
		}
		/** 状态 → 状态文字 data-tone（verifyFailed/scanRejected/error 走 danger 文字映射）。 */
		function statusTextToneOf(source) {
			var status = source != null ? source.status : null;
			return status === "verifyFailed" || status === "scanRejected" || status === "error" ? "danger" : null;
		}
		/**
		 * T4 推荐计划（按快照 recommended/recommendedNote 渲染，bundled-core 不动）：
		 * download=推荐来源未下载；enableOnly=已下载未启用；disable=非内置、非推荐且启用中。
		 */
		function computeRecommendedPlan(snap) {
			var download = [];
			var enableOnly = [];
			var disable = [];
			for (var source of snap.sources) {
				if (source.builtin === true || source.id === BUILTIN_SOURCE_ID) continue;
				// v2.2 custom 伪来源不参与推荐配置（启停在自定义专家区管理）。
				if (source.custom === true) continue;
				if (source.recommended === true) {
					if (source.installedVersion === null) download.push(source);
					else if (source.enabled !== true) enableOnly.push(source);
				} else if (source.enabled === true) {
					disable.push(source);
				}
			}
			return {
				download: download,
				enableOnly: enableOnly,
				disable: disable,
				note: typeof snap.recommendedNote === "string" ? snap.recommendedNote : null,
			};
		}
		// SET-PURE-END
		//#endregion

		/**
		 * T2 统一弹窗 Tab 焦点圈闭（ux-spec §5 focus trap）：纯 DOM、非 hook，供 overlay onKeyDown 调用。
		 * shift+Tab 在首元素上→跳末元素；Tab 在末元素上→跳首元素；容器为空时兜底聚焦容器自身。
		 */
		function esoSetTrapDialogTab(event, container) {
			if (container == null) return;
			var nodes = container.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
			var focusable = [];
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (node.disabled === true) continue;
				if (node.offsetParent === null && node !== container) continue; // 不可见（含折叠 detailwrap）不可聚焦
				focusable.push(node);
			}
			if (focusable.length === 0) {
				event.preventDefault();
				container.focus();
				return;
			}
			var first = focusable[0];
			var last = focusable[focusable.length - 1];
			if (event.shiftKey && (event.target === first || !container.contains(event.target))) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && event.target === last) {
				event.preventDefault();
				first.focus();
			}
		}

		//#region 面板组件
		/**
		 * 专家来源设置面板。
		 * @param props t 为宿主注入的翻译函数（locale: NS，语言切换自动重渲染）；
		 *        remote 为挂载后的 `remote.expertSources` API。
		 */
		function ExpertSourcesSettings(props) {
			var t = props.t;
			var remote = props.remote;
			var state = React.useState(null);
			var snapshot = state[0];
			var setSnapshot = state[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			var confirmState = React.useState(null);
			var confirmId = confirmState[0];
			var setConfirmId = confirmState[1];
			/** M3 确认门：待用户确认启用的来源（null=无待确认）。 */
			var ackPendingState = React.useState(null);
			var ackPending = ackPendingState[0];
			var setAckPending = ackPendingState[1];
			/** 下载扫描确认门：待用户确认的扫描命中（null=无待确认）。 */
			var scanPendingState = React.useState(null);
			var scanPending = scanPendingState[0];
			var setScanPending = scanPendingState[1];
			/** T4 推荐配置：待确认的预览计划（null=无待确认；{download,enableOnly,disable,note}）。 */
			var recPendingState = React.useState(null);
			var recPending = recPendingState[0];
			var setRecPending = recPendingState[1];
			var mirrorState = React.useState(null);
			var mirrorText = mirrorState[0];
			var setMirrorText = mirrorState[1];
			var addState = React.useState("");
			var addUrl = addState[0];
			var setAddUrl = addState[1];
			// v2.2 自定义专家：表单（null=收起）、行内删除两步确认、来源行展开状态。
			var customFormState = React.useState(null);
			var customForm = customFormState[0];
			var setCustomForm = customFormState[1];
			var confirmDeleteSlugState = React.useState(null);
			var confirmDeleteSlug = confirmDeleteSlugState[0];
			var setConfirmDeleteSlug = confirmDeleteSlugState[1];
			// T2 行级 disclosure：来源行展开状态（Set 多开，同一时刻可多行展开，非手风琴；
			// ux-spec §3.3）。v2.11.0 重构时状态声明丢失致渲染崩溃，v2.11.1 补回。
			var expandedSourcesState = React.useState(new Set());
			var expandedSources = expandedSourcesState[0];
			var setExpandedSources = expandedSourcesState[1];
			var toggleExpandedSource = React.useCallback(function (sourceId) {
				setExpandedSources(function (prev) {
					var next = new Set(prev);
					if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId);
					return next;
				});
			}, []);
			var copyPickState = React.useState(null);
			var copyPick = copyPickState[0];
			var setCopyPick = copyPickState[1];
			// T2 document.hidden 暂停脉冲（data-eso-set-hidden，visual-spec §9）。
			var hiddenState = React.useState(false);
			var hidden = hiddenState[0];
			var setHidden = hiddenState[1];
			// T2 统一弹窗焦点管理：trap 容器 ref + 打开时记录触发元素、关闭时还原焦点（ux-spec §5）。
			var dialogRef = React.useRef(null);
			var savedFocusRef = React.useRef(null);
			var dialogOpen = ackPending !== null || scanPending !== null || recPending !== null;

			var accept = React.useCallback(function (next) {
				setSnapshot(next);
				if (mirrorText === null) setMirrorText(next.mirrorPrefixes.join("\n"));
			}, [mirrorText]);

			React.useEffect(function () {
				var alive = true;
				void remote.getSources().then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
					if (alive) setError(messageOf(cause));
				});
				return function () { alive = false; };
			}, [remote]);

			React.useEffect(function () {
				if (typeof document === "undefined" || document.addEventListener == null) return undefined;
				var sync = function () { setHidden(document.hidden === true); };
				document.addEventListener("visibilitychange", sync);
				return function () { document.removeEventListener("visibilitychange", sync); };
			}, []);

			// alertdialog 焦点还原：打开时记录触发元素（取消侧 autoFocus 先落焦点），关闭时还原。
			React.useEffect(function () {
				if (!dialogOpen) return undefined;
				savedFocusRef.current = typeof document !== "undefined" ? document.activeElement : null;
				return function () {
					var previous = savedFocusRef.current;
					savedFocusRef.current = null;
					if (previous != null && typeof previous.focus === "function") previous.focus();
				};
			}, [dialogOpen]);

			/** 全局错误文案：乐观锁冲突走通用词条 settings.conflictGeneric（custom 区保留 custom.err.conflict）。 */
			var globalErrorText = function (cause) {
				return errorKeyOf(cause) === "conflict" ? t("settings.conflictGeneric") : messageOf(cause);
			};

			/** 所有写操作的统一通道：Typert Remote → host（settings.mutate 乐观锁在 host 侧）。 */
			var mutate = React.useCallback(function (invoke, okMessage) {
				if (busy) return;
				setBusy(true);
				setError(null);
				setNotice("");
				void Promise.resolve().then(invoke).then(function (result) {
					accept(unwrap(result));
					setNotice(okMessage);
				}).catch(function (cause) {
					setError(globalErrorText(cause));
					// 失败的变更不返回快照，但 host 已把失败状态记到来源行
					// （verifyFailed/scanRejected/error + statusDetail）——拉一次快照
					// 让行状态与详情刷新，否则行内状态停留为旧值。
					void remote.getSources().then(function (result) {
						accept(unwrap(result));
					}).catch(function () { /* 快照刷新失败时保留原错误提示 */ });
				}).finally(function () {
					setBusy(false);
				});
			}, [busy, accept]);

			if (snapshot === null) {
				return React.createElement("div", { className: "eso-set-root" },
					React.createElement("p", { className: "eso-set-hint" }, t("settings.loading")),
					error === null ? null : React.createElement("div", { className: "eso-set-alert", role: "alert" },
						React.createElement("span", { className: "eso-set-dot", "data-tone": "danger", "aria-hidden": "true" }),
						format(t("status.error"), {}) + "：" + error));
			}

			var sources = snapshot.sources;
			var statusLabel = function (source) {
				var key = "status." + source.status;
				return t(key);
			};
			// T2 状态色由模块级纯函数 statusToneOf/statusTextToneOf 提供（SET-PURE 区，可测）。

			var openRecommendedPreview = function () {
				if (busy) return;
				// computeRecommendedPlan 已上移为模块级纯函数（SET-PURE 区）。
				setRecPending(computeRecommendedPlan(snapshot));
			};

			/** 去重组 rule 透出：已知规则映射双语词条，未知规则原样透出（不猜测）。 */
			var DEDUP_RULE_KEYS = {
				"agency-path-pair": "dedup.rule.agency-path-pair",
				"name-match": "dedup.rule.name-match",
				"mixed": "dedup.rule.mixed",
			};
			var dedupRuleLabel = function (rule) {
				return DEDUP_RULE_KEYS[rule] != null ? t(DEDUP_RULE_KEYS[rule]) : rule;
			};
			/** 来源 id → 展示名（快照行缺失时回退 id，不崩溃）。 */
			var sourceNameOf = function (sourceId) {
				var entry = sources.find(function (item) { return item.id === sourceId; });
				return entry != null ? entry.name : sourceId;
			};

			/** setSourceEnabled 统一执行通道：ackRisks=false 首发探测确认门，确认后 true 重发。 */
			var runSetEnabled = function (source, enabling, ackRisks, doneMessage) {
				if (busy) return;
				setBusy(true);
				setError(null);
				setNotice("");
				void Promise.resolve().then(function () {
					return remote.setSourceEnabled(source.id, enabling, snapshot.revision, ackRisks);
				}).then(function (result) {
					var ackNeeded = enabling && ackRisks !== true && (
						(result != null && result.ok !== true && isAckRequiredError(result.error)) ||
						(result != null && result.ok === true && hasAckMarker(result.value)));
					if (ackNeeded) {
						// 需确认标记：不采纳快照（不生效），弹确认对话框等待用户裁决。
						setAckPending(source);
						return;
					}
					accept(unwrap(result));
					setNotice(doneMessage);
				}).catch(function (cause) {
					setError(globalErrorText(cause));
					void remote.getSources().then(function (result) {
						accept(unwrap(result));
					}).catch(function () { /* 快照刷新失败时保留原错误提示 */ });
				}).finally(function () {
					setBusy(false);
				});
			};

			/** 下载/更新统一执行通道：ackScan=false 首发探测扫描确认门，确认后 true 重发。 */
			var runFetch = function (source, channel, kind, ackScan) {
				if (busy) return;
				setBusy(true);
				setError(null);
				setNotice("");
				void Promise.resolve().then(function () {
					return kind === "update"
						? remote.updateSource(source.id, channel, snapshot.revision, ackScan)
						: remote.downloadSource(source.id, channel, snapshot.revision, ackScan);
				}).then(function (result) {
					var scanNeeded = ackScan !== true && (
						(result != null && result.ok !== true && isScanConfirmError(result.error)) ||
						(result != null && result.ok === true && hasScanConfirmMarker(result.value)));
					if (scanNeeded) {
						var value = result != null && result.ok === true ? result.value : null;
						if (value != null) {
							// 快照携带 skippedSymlinks/行内扫描摘要，随确认流刷新（revision 未变）。
							accept(value);
						} else {
							void remote.getSources().then(function (fresh) {
								accept(unwrap(fresh));
							}).catch(function () { /* 快照刷新失败时保留原错误提示 */ });
						}
						setScanPending({
							source: source, channel: channel, kind: kind,
							findings: value != null ? getScanFindings(value) : null,
						});
						return;
					}
					accept(unwrap(result));
					setNotice(kind === "update" ? t("sources.updateStarted") : t("sources.downloadStarted"));
				}).catch(function (cause) {
					setError(globalErrorText(cause));
					void remote.getSources().then(function (result) {
						accept(unwrap(result));
					}).catch(function () { /* 快照刷新失败时保留原错误提示 */ });
				}).finally(function () {
					setBusy(false);
				});
			};

			/** 启用/停用开关入口：启用走 M3 确认门；拒绝路径=不发送请求、保持停用。 */
			var toggleSource = function (source) {
				if (busy) return;
				if (source.enabled !== true) {
					runSetEnabled(source, true, false, t("sources.enabledDone"));
				} else {
					runSetEnabled(source, false, false, t("sources.disabledDone"));
				}
			};

			/**
			 * T2 统一确认弹窗（visual-spec 弹窗规格 + ux-spec §4/§5）：
			 * alertdialog 语义、max-width 440、取消侧 autoFocus、Esc=取消、
			 * overlay Tab 由 esoSetTrapDialogTab 圈闭、overlay 点击不关。
			 * riskDot=true 时标题前置 6px error 圆点（风险弹窗）。
			 */
			var renderConfirmModal = function (spec) {
				return React.createElement("div", {
					className: "eso-set-modal-overlay",
					ref: dialogRef,
					onKeyDown: function (event) {
						if (event.key === "Escape") {
							spec.onCancel();
							return;
						}
						if (event.key === "Tab") esoSetTrapDialogTab(event, dialogRef.current);
					},
				}, React.createElement("div", {
					className: "eso-set-modal", role: "alertdialog", "aria-modal": "true",
					"aria-labelledby": spec.titleId, "aria-describedby": spec.bodyId,
				},
					React.createElement("h4", { className: "eso-set-modal-title", id: spec.titleId },
						spec.riskDot === true ? React.createElement("span", { className: "eso-set-dot", "data-tone": "danger", "aria-hidden": "true" }) : null,
						spec.title),
					React.createElement("p", { className: "eso-set-modal-body", id: spec.bodyId }, spec.body),
					spec.children === undefined ? null : spec.children,
					React.createElement("div", { className: "eso-set-modal-actions" },
						React.createElement("button", {
							type: "button", className: "eso-set-btn", autoFocus: true, disabled: busy,
							onClick: spec.onCancel,
						}, spec.cancelLabel),
						React.createElement("button", {
							type: "button", className: "eso-set-btn", "data-danger": "",
							disabled: busy || spec.confirmDisabled === true,
							onClick: spec.onConfirm,
						}, spec.confirmLabel))));
			};

			/** M3 确认对话框（双语，alertdialog 语义）：确认=带 ackRisks:true 重发；取消=保持停用。 */
			var ackDialog = ackPending === null ? null : renderConfirmModal({
				titleId: "eso-ack-title",
				bodyId: "eso-ack-body",
				riskDot: true,
				title: format(t("sources.ackTitle"), { name: ackPending.name }),
				body: t("sources.ackBody"),
				cancelLabel: t("sources.ackCancel"),
				confirmLabel: t("sources.ackConfirm"),
				onCancel: function () {
					setAckPending(null);
					setNotice(t("sources.ackCancelled"));
				},
				onConfirm: function () {
					var pending = ackPending;
					setAckPending(null);
					runSetEnabled(pending, true, true, t("sources.enabledDone"));
				},
			});

			/**
			 * 下载扫描确认对话框（双语，alertdialog 语义）：
			 * 列命中明细（data-warn 4px warn 方点），明示「已过 sha256 验签；内容为第三方 persona，自动扫描非安全审查」；
			 * 确认=带 ackScan:true 重发；取消=中止本次安装。
			 */
			var scanDialog = scanPending === null ? null : (function () {
				var findings = Array.isArray(scanPending.findings) ? scanPending.findings : [];
				var shown = findings.slice(0, 10);
				return renderConfirmModal({
					titleId: "eso-scan-title",
					bodyId: "eso-scan-body",
					riskDot: true,
					title: format(t("sources.scanTitle"), { name: scanPending.source.name }),
					body: t("sources.scanBody"),
					cancelLabel: t("sources.scanCancel"),
					confirmLabel: t("sources.scanConfirm"),
					onCancel: function () {
						setScanPending(null);
						setNotice(t("sources.scanCancelled"));
					},
					onConfirm: function () {
						var pending = scanPending;
						setScanPending(null);
						runFetch(pending.source, pending.channel, pending.kind, true);
					},
					children: findings.length === 0 ? null : React.createElement("div", null,
						React.createElement("p", { className: "eso-set-hint" }, t("sources.scanFindingsTitle")),
						React.createElement("ul", { className: "eso-set-modal-list", "data-warn": "" },
							shown.map(function (finding, index) {
								return React.createElement("li", { key: index }, findingText(finding));
							}),
							findings.length > shown.length ? React.createElement("li", null,
								format(t("sources.scanMore"), { count: findings.length - shown.length })) : null)),
				});
			})();

			/**
			 * T4 推荐配置预览对话框（双语，alertdialog 语义）：
			 * 按快照 recommended/recommendedNote 列出将下载启用/将停用的来源，
			 * 双语说明透出；确认后循环既有方法执行（download→enable→setSourceEnabled
			 * 停用非推荐），bundled-core 不动。下载扫描确认门按预览确认自动带
			 * ackScan:true 重发，命中明细保留在来源行。
			 */
			var recListBlock = function (title, list) {
				if (list.length === 0) return null;
				return React.createElement("div", null,
					React.createElement("p", { className: "eso-set-modal-grouptitle" }, title),
					React.createElement("ul", { className: "eso-set-modal-list" },
						list.map(function (source) {
							return React.createElement("li", { key: source.id }, source.name);
						})));
			};
			var recDialog = recPending === null ? null : (function () {
				var plan = recPending;
				var empty = plan.download.length === 0 && plan.enableOnly.length === 0 && plan.disable.length === 0;
				return renderConfirmModal({
					titleId: "eso-rec-title",
					bodyId: "eso-rec-body",
					title: t("rec.previewTitle"),
					body: t("rec.scanHint"),
					cancelLabel: t("rec.cancel"),
					confirmLabel: t("rec.confirm"),
					confirmDisabled: empty,
					onCancel: function () { setRecPending(null); },
					onConfirm: function () { setRecPending(null); runApplyRecommended(plan); },
					children: React.createElement(React.Fragment, null,
						empty ? React.createElement("p", { className: "eso-set-modal-body" }, t("rec.noChanges")) : React.createElement("div", null,
							recListBlock(t("rec.willDownload"), plan.download),
							recListBlock(t("rec.willEnableOnly"), plan.enableOnly),
							recListBlock(t("rec.willDisable"), plan.disable)),
						plan.note === null ? null : React.createElement("p", { className: "eso-set-hint" }, t("rec.noteLabel") + " " + plan.note)),
				});
			})();

			/**
			 * T4 推荐配置批量执行：以最新快照 revision 起链，逐推荐来源
			 * download（扫描确认门命中→ackScan:true 重发并计数）→ enable（已启用跳过），
			 * 再逐非推荐来源 setSourceEnabled(false)（builtin/bundled-core 恒跳过）。
			 * 任一步失败即中断并刷新快照（host 乐观锁保证无半写 revision）。
			 */
			var runApplyRecommended = function (plan) {
				if (busy || plan == null) return;
				setBusy(true);
				setError(null);
				setNotice(t("rec.applying"));
				var scanHits = 0;
				void remote.getSources().then(function (first) {
					var chain = Promise.resolve(unwrap(first));
					var chainStep = function (step) {
						chain = chain.then(step);
					};
					var downloadStep = function (source) {
						chainStep(function (snap) {
							return Promise.resolve(remote.downloadSource(source.id, "github", snap.revision, false))
								.then(function (result) {
									var scanNeeded = (result != null && result.ok !== true && isScanConfirmError(result.error)) ||
										(result != null && result.ok === true && hasScanConfirmMarker(result.value));
									if (!scanNeeded) return unwrap(result);
									var value = result != null && result.ok === true ? result.value : null;
									var findings = value != null ? getScanFindings(value) : null;
									scanHits += Array.isArray(findings) ? findings.length : 0;
									return Promise.resolve(remote.downloadSource(source.id, "github", snap.revision, true)).then(unwrap);
								});
						});
					};
					var enableStep = function (source) {
						chainStep(function (snap) {
							var fresh = snap.sources.find(function (entry) { return entry.id === source.id; });
							if (fresh == null || fresh.enabled === true || fresh.builtin === true) return snap;
							return Promise.resolve(remote.setSourceEnabled(source.id, true, snap.revision, true)).then(unwrap);
						});
					};
					var disableStep = function (source) {
						chainStep(function (snap) {
							var fresh = snap.sources.find(function (entry) { return entry.id === source.id; });
							if (fresh == null || fresh.enabled !== true || fresh.builtin === true || fresh.custom === true) return snap;
							return Promise.resolve(remote.setSourceEnabled(source.id, false, snap.revision, true)).then(unwrap);
						});
					};
					for (var source of plan.download) { downloadStep(source); enableStep(source); }
					for (var source of plan.enableOnly) { enableStep(source); }
					for (var source of plan.disable) { disableStep(source); }
					return chain;
				}).then(function (snap) {
					accept(snap);
					setNotice(scanHits > 0 ? format(t("rec.doneScan"), { count: scanHits }) : t("rec.done"));
				}).catch(function (cause) {
					setError(globalErrorText(cause));
					void remote.getSources().then(function (result) {
						accept(unwrap(result));
					}).catch(function () { /* 快照刷新失败时保留原错误提示 */ });
				}).finally(function () {
					setBusy(false);
				});
			};

			/**
			 * v2.2 自定义专家（用户反馈：自定义专家管理 UI + per-expert 启停）。
			 * 写路径单一：custom 启停走 saveCustom 的 enabled 参数；setExpertEnabled
			 * 对 custom 伪来源只读（host 拒绝）。错误按 host Error.key 双语分支渲染。
			 */
			var customList = Array.isArray(snapshot.customExperts) ? snapshot.customExperts : [];
			var customDegraded = snapshot.customExpertsError != null ? String(snapshot.customExpertsError) : null;
			var CUSTOM_QUOTA_MAX = 200;
			var customQuota = customList.length;
			var customErrorText = function (cause) {
				var key = errorKeyOf(cause);
				return key != null ? t("custom.err." + key) : messageOf(cause);
			};
			var refreshAfterError = function () {
				void remote.getSources().then(function (result) { accept(unwrap(result)); }).catch(function () { /* 保留原错误提示 */ });
			};
			var runSaveCustom = function (input, enabled, okMessage) {
				if (busy) return;
				setBusy(true); setError(null); setNotice("");
				void Promise.resolve().then(function () {
					return remote.saveCustom(input, enabled, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setCustomForm(null);
					setNotice(okMessage);
				}).catch(function (cause) {
					setError(customErrorText(cause));
					refreshAfterError();
				}).finally(function () { setBusy(false); });
			};
			/** 行内启停：custom 记录无 prompt 下发——先 getCustom 取详情再 saveCustom 翻转。 */
			var runToggleCustom = function (record) {
				if (busy) return;
				setBusy(true); setError(null); setNotice("");
				void Promise.resolve().then(function () {
					return remote.getCustom(record.slug);
				}).then(function (result) { return unwrap(result); }).then(function (detail) {
					return remote.saveCustom({
						slug: detail.slug,
						name: detail.name,
						description: detail.description,
						prompt: detail.prompt,
						division: detail.division == null ? undefined : detail.division,
						emoji: detail.emoji == null ? undefined : detail.emoji,
					}, !(detail.enabled === true), snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("custom.toggled"));
				}).catch(function (cause) {
					setError(customErrorText(cause));
					refreshAfterError();
				}).finally(function () { setBusy(false); });
			};
			var runEditCustom = function (record) {
				if (busy) return;
				setBusy(true); setError(null);
				void Promise.resolve().then(function () {
					return remote.getCustom(record.slug);
				}).then(function (result) {
					var detail = unwrap(result);
					setCustomForm({
						slug: detail.slug,
						name: detail.name,
						description: detail.description,
						prompt: detail.prompt,
						division: detail.division == null ? "" : detail.division,
						emoji: detail.emoji == null ? "" : detail.emoji,
						enabled: detail.enabled === true,
						copyFrom: null,
					});
				}).catch(function (cause) { setError(customErrorText(cause)); })
				.finally(function () { setBusy(false); });
			};
			var runDeleteCustom = function (record) {
				if (busy) return;
				setBusy(true); setError(null); setNotice("");
				void Promise.resolve().then(function () {
					return remote.deleteCustom(record.slug, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("custom.deleted"));
				}).catch(function (cause) {
					setError(customErrorText(cause));
					refreshAfterError();
				}).finally(function () {
					setConfirmDeleteSlug(null);
					setBusy(false);
				});
			};
			/** 从来源专家复制：元数据预填 + getExpertContent 读取正文预填 prompt
			 *  （读取失败按 Error.key 双语提示，表单保留可手填）。 */
			var openCopyForm = function (source, fileEntry) {
				var baseName = fileEntry.file.split("/").pop().replace(/\.md$/, "");
				var ref = { sourceId: source.id, file: fileEntry.file };
				setCustomForm({
					slug: null,
					name: fileEntry.name != null && fileEntry.name !== "" ? fileEntry.name : baseName,
					description: "",
					prompt: "",
					division: "", emoji: "",
					enabled: true,
					copyFrom: source.id + "/" + fileEntry.file,
					loadingContent: true,
				});
				void Promise.resolve().then(function () {
					return remote.getExpertContent(ref);
				}).then(function (result) {
					var detail = unwrap(result);
					setCustomForm(function (form) {
						return form == null ? form : Object.assign({}, form, { prompt: detail.content, loadingContent: false });
					});
				}).catch(function (cause) {
					var key = errorKeyOf(cause);
					setError(key != null ? t("custom.err." + key) : t("custom.err.invalid"));
					setCustomForm(function (form) {
						return form == null ? form : Object.assign({}, form, { loadingContent: false, contentFailed: true });
					});
				});
			};
			/** 表单提交：本地只做非空短路（精确校验由 host 产出 Error.key 双语提示）。 */
			var runSubmitCustom = function () {
				if (busy || customForm == null) return;
				var input = {
					slug: customForm.slug == null || customForm.slug === "" ? undefined : customForm.slug,
					name: customForm.name,
					description: customForm.description,
					prompt: customForm.prompt,
					division: customForm.division === "" ? undefined : customForm.division,
					emoji: customForm.emoji === "" ? undefined : customForm.emoji,
				};
				if (typeof input.name !== "string" || input.name.trim() === "" ||
					typeof input.description !== "string" || input.description.trim() === "" ||
					typeof input.prompt !== "string" || input.prompt === "") {
					setError(t("custom.err.invalid"));
					return;
				}
				runSaveCustom(input, customForm.enabled === true, t("custom.saved"));
			};
			/** per-expert 启停（CatalogSnapshot 粒度）：custom 伪来源 readonly 由 host 拒绝，
			 *  client 侧对 custom 行直接置灰不发起请求。 */
			var runSetExpertEnabled = function (source, fileEntry, enabling) {
				if (busy) return;
				setBusy(true); setError(null); setNotice("");
				void Promise.resolve().then(function () {
					return remote.setExpertEnabled({ sourceId: source.id, file: fileEntry.file }, enabling, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("custom.done"));
				}).catch(function (cause) {
					setError(customErrorText(cause));
					refreshAfterError();
				}).finally(function () { setBusy(false); });
			};

			// T2 来源行（visual-spec §R2 + ux-spec §3.3）：徽标 data-kind、状态点 data-tone、
			// switch 28×16、行级 disclosure（aria-expanded/aria-controls，region Esc 收起）、
			// 两步删除 data-confirm filled 态。
			var rows = sources.map(function (source) {
				var locked = source.builtin === true;
				// v2.2 custom 伪来源：仅作管理入口展示（启停/下载/删除均走自定义专家区）。
				var isCustomPseudo = source.custom === true;
				// legacy-adapted 以 builtin:false 上报（可停用），但 host 拒删（随包迁移冻结数据）：
				// 客户端按 id 冻结删除入口，与 host remoteRemoveSource 的拒绝逻辑保持一致。
				var frozen = source.id === LEGACY_SOURCE_ID;
				var removable = !locked && !frozen && !isCustomPseudo;
				var downloading = source.status === "downloading" || busy;
				var confirmingRemove = confirmId === source.id;
				// v2.2 行级专家清单（host 未投递时缺省空数组）与展开状态（Set 多开）。
				var fileList = Array.isArray(source.files) ? source.files : [];
				var expanded = expandedSources.has(source.id);
				var filesBtnId = "eso-set-filesbtn-" + source.id;
				var filesRegionId = "eso-set-files-" + source.id;
				// 行内扫描命中/跳过符号链接摘要：行级字段优先，快照顶层兜底（host 投递形态兼容）。
				var rowScanFindings = Array.isArray(source.scanFindings) && source.scanFindings.length > 0
					? source.scanFindings
					: (Array.isArray(snapshot.scanFindings) && snapshot.scanFindings.length > 0 ? snapshot.scanFindings : []);
				var rowSkippedSymlinks = Array.isArray(source.skippedSymlinks) && source.skippedSymlinks.length > 0
					? source.skippedSymlinks
					: (Array.isArray(snapshot.skippedSymlinks) && snapshot.skippedSymlinks.length > 0 ? snapshot.skippedSymlinks : []);
				return React.createElement("li", {
					key: source.id, className: "eso-set-row",
					"data-expanded": expanded && fileList.length > 0 ? "" : undefined,
					"data-greyed": isCustomPseudo ? "" : undefined,
				},
					React.createElement("div", { className: "eso-set-row-main" },
						React.createElement("span", { className: "eso-set-name" }, source.name),
						locked ? React.createElement("span", { className: "eso-set-badge", "data-kind": "builtin", title: t("sources.builtinHint") }, t("sources.builtin")) : null,
						source.recommended === true ? React.createElement("span", { className: "eso-set-badge", "data-kind": "recommended" }, t("rec.recommended")) : null,
						frozen ? React.createElement("span", { className: "eso-set-meta", title: t("sources.legacyHint") }, t("sources.legacyHint")) : null,
						isCustomPseudo ? React.createElement("span", { className: "eso-set-badge", "data-kind": "custom" }, t("custom.badge")) : null,
						source.upstream === "" ? null : React.createElement("a", {
							className: "eso-set-link", href: source.upstream, target: "_blank", rel: "noreferrer",
						}, source.upstream),
						React.createElement("span", { className: "eso-set-meta" }, t("sources.license") + "：" + (source.license === "" ? "—" : source.license)),
						React.createElement("span", { className: "eso-set-meta" }, t("sources.version") + "：" + (source.installedVersion === null ? t("sources.notInstalled") : source.installedVersion))),
					React.createElement("div", {
						className: "eso-set-status", role: "status",
						"data-tone": statusTextToneOf(source) === null ? undefined : statusTextToneOf(source),
					},
						React.createElement("span", { className: "eso-set-dot", "data-tone": statusToneOf(source), "aria-hidden": "true" }),
						statusLabel(source),
						source.statusDetail === null ? null : React.createElement("span", { className: "eso-set-status-detail" }, source.statusDetail),
						rowScanFindings.length === 0 ? null : React.createElement("span", {
							className: "eso-set-warnbadge", title: rowScanFindings.slice(0, 10).map(findingText).join("\n"),
						}, format(t("sources.scanHits"), { count: rowScanFindings.length })),
						rowSkippedSymlinks.length === 0 ? null : React.createElement("span", {
							className: "eso-set-badge", title: rowSkippedSymlinks.slice(0, 10).join("\n"),
						}, format(t("sources.skippedSymlinks"), { count: rowSkippedSymlinks.length }))),
					React.createElement("div", { className: "eso-set-actions" },
						// T2 反馈④：启用控制只标『启用』（选中=启用），去掉『停用』歧义措辞。
						// v2.2 custom 伪来源行置灰并在自定义专家区管理（host 对 custom readonly）。
						React.createElement("label", { className: "eso-set-toggle", title: isCustomPseudo ? t("custom.manageHint") : undefined },
							React.createElement("input", {
								type: "checkbox", className: "eso-set-switch", checked: source.enabled,
								disabled: locked || downloading || isCustomPseudo,
								"aria-label": format(t("sources.toggle"), { name: source.name }),
								onChange: function () { toggleSource(source); },
							}),
							React.createElement("span", { className: "eso-set-meta" }, t("sources.enable"))),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: downloading,
							onClick: function () { runFetch(source, "github", "download", false); },
						}, t("sources.downloadGithub")),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: downloading,
							onClick: function () { runFetch(source, "cdn", "download", false); },
						}, t("sources.downloadCdn")),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: downloading,
							onClick: function () { runFetch(source, "cdn", "update", false); },
						}, t("sources.update")),
						// 行级 disclosure 按钮：aria-expanded/aria-controls 指向下方 region（非手风琴，多行可同开）。
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: downloading,
							id: filesBtnId, "aria-expanded": expanded, "aria-controls": filesRegionId,
							"aria-label": format(t("sources.expandHint"), { name: source.name }),
							onClick: function () { toggleExpandedSource(source.id); },
						}, (expanded ? "▾ " : "▸ ") + t("files.toggle") + "（" + fileList.length + "）"),
						removable ? React.createElement("button", {
							type: "button", className: "eso-set-btn", "data-danger": "",
							"data-confirm": confirmingRemove ? "" : undefined,
							disabled: downloading,
							"aria-label": format(t("sources.removeToggle"), { name: source.name }),
							onClick: function () {
								if (!confirmingRemove) {
									setConfirmId(source.id);
									return;
								}
								setConfirmId(null);
								mutate(function () {
									return remote.removeSource(source.id, snapshot.revision);
								}, t("sources.removed"));
							},
							onBlur: function () {
								if (confirmId === source.id) setConfirmId(null);
							},
						}, confirmingRemove ? t("sources.removeConfirm") : t("sources.remove")) : null),
					// detailwrap 恒渲染（fileList>0）：grid 0fr→1fr 过渡需要持久节点；
					// 折叠态 files 由 visibility:hidden 隐藏并移出 Tab 序。
					fileList.length === 0 ? null : React.createElement("div", { className: "eso-set-detailwrap" },
						React.createElement("ul", {
							className: "eso-set-files", id: filesRegionId, role: "region", "aria-labelledby": filesBtnId,
							onKeyDown: function (event) {
								if (event.key !== "Escape") return;
								toggleExpandedSource(source.id);
								var button = typeof document !== "undefined" ? document.getElementById(filesBtnId) : null;
								if (button != null) button.focus();
							},
						},
							fileList.map(function (entry) {
								var effectiveEnabled = entry.enabled !== false && entry.disabled !== true;
								var greyed = isCustomPseudo;
								var badges = [];
								if (entry.disabled === true) badges.push(React.createElement("span", { key: "dis", className: "eso-set-dangertext" }, t("custom.disabledBadge")));
								if (entry.shadowed === true) badges.push(React.createElement("span", { key: "sha", className: "eso-set-badge", "data-kind": "shadowed" }, t("dedup.shadowed")));
								if (entry.custom === true) badges.push(React.createElement("span", { key: "cus", className: "eso-set-badge", "data-kind": "custom" }, t("custom.badge")));
								return React.createElement("li", {
									key: entry.file, className: "eso-set-file-row",
									"data-disabled": effectiveEnabled ? undefined : "",
								},
									React.createElement("span", { className: "eso-set-path" }, entry.file),
									entry.name == null || entry.name === "" ? null : React.createElement("span", { className: "eso-set-file-name" }, entry.name),
									entry.title == null || entry.title === "" || entry.title === entry.name ? null : React.createElement("span", { className: "eso-set-meta" }, entry.title),
									badges,
									React.createElement("label", { className: "eso-set-toggle" },
										React.createElement("input", {
											type: "checkbox", className: "eso-set-switch", checked: effectiveEnabled,
											disabled: greyed || downloading,
											title: greyed ? t("custom.manageHint") : undefined,
											"aria-label": entry.file,
											onChange: function () { runSetExpertEnabled(source, entry, !effectiveEnabled); },
										}),
										React.createElement("span", { className: "eso-set-meta" }, t("sources.enable"))),
									greyed ? React.createElement("span", { className: "eso-set-meta" }, t("custom.manageHint")) : null);
							}))));
			});

			var conflicts = snapshot.conflicts.map(function (conflict, index) {
				return React.createElement("li", { key: conflict.expert + ":" + index },
					format(t("conflicts.item"), { expert: conflict.expert, sources: conflict.sources.join(" / ") }));
			});

			// T2 锚点分区条（ux-spec §1）：单列滚动 + 顶部锚点导航；空区整区隐藏（dedup 无组无冲突不渲染）。
			var dedupGroups = Array.isArray(snapshot.dedupGroups) ? snapshot.dedupGroups : [];
			var hasDedup = dedupGroups.length > 0 || conflicts.length > 0;
			var scrollToSection = function (event) {
				var target = event.currentTarget.getAttribute("data-target");
				var node = target === null ? null : document.getElementById(target);
				if (node == null) return;
				var reduced = typeof window !== "undefined" && window.matchMedia != null
					&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
			};
			var navItems = [
				{ id: "eso-set-sec-rec", label: t("nav.recommended") },
				{ id: "eso-set-sec-sources", label: t("nav.sources") },
				hasDedup ? { id: "eso-set-sec-dedup", label: t("nav.dedup") } : null,
				{ id: "eso-set-sec-custom", label: t("nav.custom") },
				{ id: "eso-set-sec-mirrors", label: t("nav.mirrors") },
				{ id: "eso-set-sec-add", label: t("nav.add") },
			].filter(function (item) { return item !== null; });
			// T2 镜像脏态：文本偏离快照即强调保存按钮并提示未保存（ux-spec §3.6）。
			var mirrorDirty = mirrorText !== snapshot.mirrorPrefixes.join("\n");

			return React.createElement("div", {
				className: "eso-set-root",
				"data-eso-set-hidden": hidden ? "" : undefined,
			},
				// 页头：插件名 14px/600 + 副标 + 右侧重新加载（visual-spec 页头规格）。
				React.createElement("div", { className: "eso-set-header" },
					// T2 反馈①：section 主标题直接用插件名，保留一行小字副标『专家来源管理』。
					React.createElement("h3", { className: "eso-set-title" }, t("settings.title")),
					React.createElement("span", { className: "eso-set-subtitle" }, t("settings.subtitle")),
					React.createElement("span", { className: "eso-set-spacer" }),
					React.createElement("button", {
						type: "button", className: "eso-set-btn", disabled: busy,
						onClick: function () {
							mutate(function () { return remote.getSources(); }, "");
						},
					}, t("settings.reload"))),
				React.createElement("p", { className: "eso-set-desc" }, t("settings.desc")),
				React.createElement("nav", { className: "eso-set-nav", "aria-label": t("nav.label") },
					navItems.map(function (item) {
						return React.createElement("button", {
							key: item.id, type: "button", className: "eso-set-navbtn",
							"data-target": item.id,
							onClick: scrollToSection,
						}, item.label);
					})),
				// 全局反馈带：错误 alert（dot danger）+ aria-live notice（ux-spec §2）。
				error === null ? null : React.createElement("div", { className: "eso-set-alert", role: "alert" },
					React.createElement("span", { className: "eso-set-dot", "data-tone": "danger", "aria-hidden": "true" }),
					format(t("status.error"), {}) + "：" + error),
				React.createElement("p", { className: "eso-set-notice", "aria-live": "polite" }, notice),
				// 推荐配置区（首个分区，无 border-top）。
				React.createElement("section", { className: "eso-set-section", id: "eso-set-sec-rec", "data-first": "", "aria-label": t("rec.title") },
					React.createElement("h4", { className: "eso-set-section-title" }, t("rec.title")),
					React.createElement("p", { className: "eso-set-hint" }, t("rec.desc")),
					React.createElement("div", null,
						React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: busy,
							onClick: function () { openRecommendedPreview(); },
						}, t("rec.apply")))),
				// 来源区：空态=一句空文案 + linkbtn 滚到添加区（ux-spec §6 空态三件套）。
				React.createElement("section", { className: "eso-set-section", id: "eso-set-sec-sources", "aria-label": t("settings.subtitle") },
					React.createElement("ul", { className: "eso-set-list" },
						rows.length === 0 ? React.createElement("li", { className: "eso-set-hint" }, t("sources.empty"), " ",
							React.createElement("button", {
								type: "button", className: "eso-set-linkbtn",
								onClick: function (event) {
									var node = document.getElementById("eso-set-sec-add");
									if (node == null) return;
									var reduced = typeof window !== "undefined" && window.matchMedia != null
										&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
									node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
								},
							}, t("nav.add"))) : rows)),
				/**
				 * v2.2 自定义专家管理区（用户反馈：自定义专家管理 UI + 限额 + 复制预填）。
				 * 列表=快照 customExperts 摘要；表单编辑走 getCustom 取详情回填；
				 * 新建 slug 由 host 生成；quota n/200 满员禁用新建；customExpertsError 降级展示。
				 */
				React.createElement("section", { className: "eso-set-section", id: "eso-set-sec-custom", "aria-label": t("custom.title") },
					React.createElement("h4", { className: "eso-set-section-title" },
						t("custom.title"),
						React.createElement("span", {
							className: "eso-set-quota",
							"data-full": customQuota >= CUSTOM_QUOTA_MAX ? "" : undefined,
						}, format(t("custom.quota"), { count: customQuota, max: CUSTOM_QUOTA_MAX }))),
					React.createElement("p", { className: "eso-set-hint" }, t("custom.desc")),
					customDegraded === null ? null : React.createElement("p", { className: "eso-set-dangertext", role: "alert" },
						format(t("status.error"), {}) + "：" + customDegraded),
					customForm === null ? React.createElement("div", { className: "eso-set-form-row" },
						React.createElement("button", {
							type: "button", className: "eso-set-btn",
							disabled: busy || customQuota >= CUSTOM_QUOTA_MAX,
							title: customQuota >= CUSTOM_QUOTA_MAX ? format(t("custom.limitReached"), { max: CUSTOM_QUOTA_MAX }) : undefined,
							onClick: function () {
								setCustomForm({ slug: null, name: "", description: "", prompt: "", division: "", emoji: "", enabled: true, copyFrom: null });
							},
						}, t("custom.new")),
						React.createElement("span", { className: "eso-set-form-label" }, t("custom.copyPick")),
						React.createElement("select", {
							className: "eso-set-select", style: { maxWidth: "320px" },
							value: copyPick == null ? "" : JSON.stringify(copyPick),
							onChange: function (event) {
								if (event.target.value === "") { setCopyPick(null); return; }
								try { setCopyPick(JSON.parse(event.target.value)); } catch (_cause) { setCopyPick(null); }
							},
						},
							React.createElement("option", { value: "" }, "—"),
							(function () {
								var options = [];
								for (var item of sources) {
									if (item.custom === true) continue;
									var list = Array.isArray(item.files) ? item.files : [];
									for (var entry of list) {
										var label = sourceNameOf(item.id) + " / " + (entry.name != null && entry.name !== "" ? entry.name : entry.file);
										options.push({ value: JSON.stringify({ sourceId: item.id, file: entry.file }), label: label });
									}
								}
								return options.map(function (opt, index) {
									return React.createElement("option", { key: index, value: opt.value }, opt.label);
								});
							})()),
						React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: busy || copyPick == null,
							onClick: function () {
								var source = sources.find(function (item) { return item.id === copyPick.sourceId; });
								var entry = source == null || Array.isArray(source.files) === false ? null
									: source.files.find(function (item) { return item.file === copyPick.file; });
								if (source == null || entry == null) { setCopyPick(null); return; }
								openCopyForm(source, entry);
							},
						}, t("custom.copy"))) : React.createElement("form", { className: "eso-set-formcard", onSubmit: function (event) { event.preventDefault(); runSubmitCustom(); } },
						customForm.slug != null && customForm.slug !== "" ? React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("span", { className: "eso-set-form-label" }, t("custom.form.slug")),
							React.createElement("span", { className: "eso-set-meta" }, customForm.slug)) : null,
						customForm.copyFrom != null ? React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("span", { className: "eso-set-meta" }, format(t("custom.copyFrom"), { origin: customForm.copyFrom })),
							customForm.loadingContent === true ? React.createElement("span", { className: "eso-set-meta" }, t("custom.copyLoading")) : null,
							customForm.contentFailed === true ? React.createElement("span", { className: "eso-set-dangertext" }, t("custom.copyFailed")) : null) : null,
						React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("label", { className: "eso-set-form-label" }, t("custom.form.name")),
							React.createElement("input", { className: "eso-set-input", type: "text", value: customForm.name, maxLength: 40, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { name: event.target.value })); } })),
						React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("label", { className: "eso-set-form-label" }, t("custom.form.description")),
							React.createElement("input", { className: "eso-set-input", type: "text", value: customForm.description, maxLength: 160, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { description: event.target.value })); } })),
						React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("label", { className: "eso-set-form-label" }, t("custom.form.prompt")),
							React.createElement("textarea", { className: "eso-set-textarea", value: customForm.prompt, maxLength: 20000, rows: 8, spellCheck: false, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { prompt: event.target.value })); } }),
							// 字数行：接近 20000 上限（≥18000）转 warn 暖色（ux-spec §3.5）。
							React.createElement("span", {
								className: "eso-set-promptcount",
								"data-warn": customForm.prompt.length >= 18000 ? "" : undefined,
							}, format(t("custom.promptLength"), { count: customForm.prompt.length }))),
						React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("label", { className: "eso-set-form-label" }, t("custom.form.division")),
							React.createElement("input", { className: "eso-set-input", type: "text", value: customForm.division, maxLength: 64, placeholder: "my-division", onChange: function (event) { setCustomForm(Object.assign({}, customForm, { division: event.target.value })); } })),
						React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("label", { className: "eso-set-form-label" }, t("custom.form.emoji")),
							React.createElement("input", { className: "eso-set-input", type: "text", value: customForm.emoji, maxLength: 16, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { emoji: event.target.value })); } })),
						React.createElement("div", { className: "eso-set-form-row" },
							React.createElement("label", { className: "eso-set-toggle" },
								React.createElement("input", {
									type: "checkbox", className: "eso-set-switch", checked: customForm.enabled === true,
									onChange: function (event) { setCustomForm(Object.assign({}, customForm, { enabled: event.target.checked })); },
								}),
								React.createElement("span", { className: "eso-set-meta" }, t("custom.form.enabled")))),
						React.createElement("div", { className: "eso-set-modal-actions" },
							React.createElement("button", {
								type: "button", className: "eso-set-btn", disabled: busy,
								onClick: function () { setCustomForm(null); },
							}, t("custom.form.cancel")),
							React.createElement("button", { type: "submit", className: "eso-set-btn", disabled: busy }, t("custom.form.submit")))),
					customQuota >= CUSTOM_QUOTA_MAX && customForm === null ? React.createElement("p", { className: "eso-set-hint" }, format(t("custom.limitReached"), { max: CUSTOM_QUOTA_MAX })) : null,
					React.createElement("ul", { className: "eso-set-list" },
						customList.length === 0 ? React.createElement("li", { className: "eso-set-hint" }, t("custom.empty")) : customList.map(function (record) {
							var confirmingDelete = confirmDeleteSlug === record.slug;
							return React.createElement("li", { key: record.slug, className: "eso-set-row" },
								React.createElement("div", { className: "eso-set-row-main" },
									(record.emoji == null ? null : React.createElement("span", null, record.emoji)),
									React.createElement("span", { className: "eso-set-name" }, record.name),
									React.createElement("span", { className: "eso-set-badge", "data-kind": "custom" }, t("custom.badge")),
									record.division == null ? null : React.createElement("span", { className: "eso-set-badge" }, record.division),
									React.createElement("span", { className: "eso-set-meta" }, format(t("custom.promptLength"), { count: record.promptLength })),
									React.createElement("span", { className: "eso-set-path" }, record.slug)),
								React.createElement("div", { className: "eso-set-actions" },
									React.createElement("label", { className: "eso-set-toggle" },
										React.createElement("input", {
											type: "checkbox", className: "eso-set-switch", checked: record.enabled === true, disabled: busy,
											"aria-label": format(t("sources.toggle"), { name: record.name }),
											onChange: function () { runToggleCustom(record); },
										}),
										React.createElement("span", { className: "eso-set-meta" }, t("sources.enable"))),
									React.createElement("button", {
										type: "button", className: "eso-set-btn", disabled: busy,
										onClick: function () { runEditCustom(record); },
									}, t("custom.edit")),
									confirmingDelete ? React.createElement("span", { className: "eso-set-meta" }, t("custom.deleteSoftHint")) : null,
									// 两步删除：filled 态 [data-confirm]（visual-spec 危险按钮规格）。
									React.createElement("button", {
										type: "button", className: "eso-set-btn", "data-danger": "",
										"data-confirm": confirmingDelete ? "" : undefined,
										disabled: busy,
										"aria-label": format(t("sources.removeToggle"), { name: record.name }),
										onClick: function () {
											if (!confirmingDelete) { setConfirmDeleteSlug(record.slug); return; }
											runDeleteCustom(record);
										},
										onBlur: function () { if (confirmDeleteSlug === record.slug) setConfirmDeleteSlug(null); },
									}, confirmingDelete ? t("custom.deleteConfirm") : t("custom.delete"))));
						}))),
				/**
				 * T4 去重组展示（反馈②智能去重的 UI 面）：仅渲染快照 dedupGroups
				 * （启用来源中 >1 成员的组）。组内成员列来源标签，代表高亮『当前代表』，
				 * 非代表 shadowed 语义灰阶（[data-shadowed]，废除 opacity 弱化）；
				 * 每组提供『设为代表』（setDedupChoice）与『恢复默认』（clearDedupChoice）；
				 * rule 透出（中英对照/同名/混合）；conflicts 子区并入本区，整区空则隐藏。
				 */
				hasDedup ? (function () {
					return React.createElement("section", { className: "eso-set-section", id: "eso-set-sec-dedup", "aria-label": t("dedup.title") },
						React.createElement("h4", { className: "eso-set-section-title" }, t("dedup.title")),
						React.createElement("p", { className: "eso-set-hint" }, t("dedup.desc")),
						conflicts.length === 0 ? null : React.createElement("div", { className: "eso-set-conflicts" },
							React.createElement("p", { className: "eso-set-conflictstitle" }, t("conflicts.title")),
							React.createElement("p", { className: "eso-set-fineprint" }, t("conflicts.desc")),
							React.createElement("ul", null, conflicts),
							React.createElement("p", { className: "eso-set-fineprint" }, t("conflicts.classes"))),
						dedupGroups.map(function (group) {
							var rep = group.representative;
							return React.createElement("div", { className: "eso-set-dedup", key: group.key },
								React.createElement("div", { className: "eso-set-dedup-head" },
									React.createElement("span", { className: "eso-set-badge" }, dedupRuleLabel(group.rule)),
									React.createElement("span", { className: "eso-set-spacer" }),
									React.createElement("button", {
										type: "button", className: "eso-set-linkbtn", disabled: busy,
										onClick: function () {
											mutate(function () {
												return remote.clearDedupChoice(group.key, snapshot.revision);
											}, t("dedup.cleared"));
										},
									}, t("dedup.clearChoice"))),
								group.members.map(function (member) {
									var isRep = rep != null && member.sourceId === rep.sourceId && member.file === rep.file;
									return React.createElement("div", {
										className: "eso-set-member", "data-shadowed": isRep ? undefined : "",
										key: member.sourceId + "\u0000" + member.file,
									},
										React.createElement("span", { className: "eso-set-member-name" }, member.name != null && member.name !== "" ? member.name : member.file),
										React.createElement("span", { className: "eso-set-badge" }, sourceNameOf(member.sourceId)),
										member.title == null || member.title === "" || member.title === member.name ? null
											: React.createElement("span", { className: "eso-set-meta" }, member.title),
										React.createElement("span", { className: "eso-set-path" }, member.file),
										isRep ? React.createElement("span", { className: "eso-set-badge", "data-kind": "representative" }, t("dedup.representative"))
											: React.createElement("span", { className: "eso-set-badge", "data-kind": "shadowed" }, t("dedup.shadowed")),
										isRep ? null : React.createElement("button", {
											type: "button", className: "eso-set-linkbtn", disabled: busy,
											"aria-label": format(t("dedup.setChoice"), { name: member.name != null && member.name !== "" ? member.name : member.file }),
											onClick: function () {
												mutate(function () {
													return remote.setDedupChoice(group.key, member.sourceId, snapshot.revision);
												}, t("dedup.done"));
											},
										}, t("dedup.setChoice")));
								}));
						}));
				})() : null,
				React.createElement("section", { className: "eso-set-section", id: "eso-set-sec-mirrors", "aria-label": t("mirrors.title") },
					React.createElement("h4", { className: "eso-set-section-title" }, t("mirrors.title")),
					React.createElement("p", { className: "eso-set-hint" }, t("mirrors.desc"), " ",
						format(t("mirrors.default"), { list: DEFAULT_MIRROR_PREFIXES.join(" → ") })),
					React.createElement("textarea", {
						className: "eso-set-textarea", value: mirrorText === null ? "" : mirrorText,
						onChange: function (event) { setMirrorText(event.target.value); },
						spellCheck: false,
					}),
					// 脏态：偏离快照即强调保存按钮 + 未保存提示（保存后自动消失）。
					mirrorDirty ? React.createElement("p", { className: "eso-set-dirty" }, t("mirrors.dirty")) : null,
					React.createElement("div", null,
						React.createElement("button", {
							type: "button", className: "eso-set-btn", "data-dirty": mirrorDirty ? "" : undefined, disabled: busy,
							onClick: function () {
								var list = parseMirrorPrefixes(mirrorText === null ? "" : mirrorText);
								if (!mirrorPrefixesValid(list)) {
									setError(t("mirrors.invalid"));
									return;
								}
								mutate(function () {
									return remote.setMirrorPrefixes(list, snapshot.revision);
								}, t("mirrors.saved"));
							},
						}, t("mirrors.save")))),
				React.createElement("section", { className: "eso-set-section", id: "eso-set-sec-add", "aria-label": t("add.title") },
					React.createElement("h4", { className: "eso-set-section-title" }, t("add.title")),
					React.createElement("div", { className: "eso-set-add" },
						React.createElement("input", {
							className: "eso-set-input", type: "text", value: addUrl, placeholder: t("add.placeholder"),
							onChange: function (event) { setAddUrl(event.target.value); },
							onKeyDown: function (event) {
								if (event.key !== "Enter") return;
								var value = addUrl.trim();
								if (!looksLikeSourceUrl(value)) { setError(t("add.invalid")); return; }
								mutate(function () {
									return remote.addSource({ url: value, name: "" }, snapshot.revision);
								}, t("add.success"));
								setAddUrl("");
							},
						}),
						React.createElement("button", {
							type: "button", className: "eso-set-btn", disabled: busy,
							onClick: function () {
								var value = addUrl.trim();
								if (!looksLikeSourceUrl(value)) { setError(t("add.invalid")); return; }
								mutate(function () {
									return remote.addSource({ url: value, name: "" }, snapshot.revision);
								}, t("add.success"));
								setAddUrl("");
							},
						}, t("add.submit")))),
				ackDialog,
				scanDialog,
				recDialog);
		}
		//#endregion

		//#region 任务板可视化（T1：右侧 Sidebar tab 看板 + 会话页头徽标）
		// 设计权威：docs/taskboard-visual-spec.md（视觉）与 docs/taskboard-sidebar-ux-spec.md（交互）。
		// 裁决记录（两文档冲突处）：窄 <720px 纵向分区、宽 ≥720px 四列 grid（泳道无底色）；刷新不做 FLIP
		//（150ms opacity）；无 toast；过滤 = 任务 ≥8 时工具条筛选按钮 + owner 单选 chips +「仅看阻塞」。
		var TB_TAB_ID = "dsh-expert-orchestrator/taskboard";
		var TB_TAB_KIND = "expert-taskboard";
		var TB_DIR = ".expert-taskboards";
		/** 看板正文挂载计数（keepMounted:false，面板打开≈挂载）——页头徽标选中态的进程内共享信号。 */
		var TB_OPEN_COUNT = 0;

		// TB-PURE-BEGIN
		// 纯函数区（零 React 依赖；test/client-taskboard.selftest.mjs 以 TB-PURE 标记从源码提取后做 node --test）

		/** status → 泳道映射；未知 status 落「需要注意」泳道并标注（宁漏勿错）。 */
		var TB_STATUS_LANES = {
			draft: "todo", pending: "todo", ready: "todo",
			running: "running",
			done: "done",
			failed: "attention", rejected: "attention", escalated: "attention"
		};
		var TB_LANE_ORDER = ["attention", "running", "todo", "done"];

		/**
		 * 板目录 listing → 三态。宁漏勿错：顶层恰一个 *.json 才 ok；0 个 = none（指引空态），
		 * 多个 = ambiguous（候选清单，不强制渲染）。
		 * @param {Array<{name:string,type?:string,mtime?:number|string,fromChat?:boolean}>|null|undefined} entries
		 * @returns {{kind:"none"}|{kind:"ambiguous",candidates:Array}|{kind:"ok",file:string}}
		 */
		function tbResolveBoard(entries) {
			if (!Array.isArray(entries)) return { kind: "none" };
			var files = entries.filter(function (entry) {
				return entry != null && typeof entry.name === "string"
					&& /\.json$/i.test(entry.name) // .json.lock / *.events.jsonl 后缀天然不匹配
					&& (entry.type == null || entry.type === "file");
			});
			if (files.length === 0) return { kind: "none" };
			if (files.length > 1) {
				return {
					kind: "ambiguous",
					candidates: files.map(function (entry) {
						return { name: entry.name, mtime: entry.mtime == null ? null : entry.mtime, fromChat: entry.fromChat === true };
					})
				};
			}
			return { kind: "ok", file: files[0].name };
		}

		/**
		 * 宽容解析任务板 JSON：结构性字段（tasks；任务 id/title/status）缺失或类型不对 → 拒绝；
		 * 可选字段（owner/dep/desc/created/updated/summary/fail/scope）缺省给安全默认。
		 * @returns {{ok:false,reason:string}|{ok:true,board:{tasks:Object,revision:number|null,seq:number|null}}}
		 */
		function tbParseBoard(text) {
			if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "empty" };
			var raw;
			try { raw = JSON.parse(text); } catch (error) { return { ok: false, reason: "json" }; }
			if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "shape" };
			if (raw.tasks == null || typeof raw.tasks !== "object" || Array.isArray(raw.tasks)) return { ok: false, reason: "tasks" };
			var tasks = {};
			var ids = Object.keys(raw.tasks);
			for (var index = 0; index < ids.length; index++) {
				var key = ids[index];
				var task = raw.tasks[key];
				if (task == null || typeof task !== "object" || Array.isArray(task)) return { ok: false, reason: "task:" + key };
				if (typeof task.id !== "string" || task.id === "" || typeof task.title !== "string" || typeof task.status !== "string") {
					return { ok: false, reason: "task:" + key };
				}
				tasks[key] = {
					id: task.id,
					title: task.title,
					status: task.status,
					statusKnown: Object.prototype.hasOwnProperty.call(TB_STATUS_LANES, task.status),
					owner: typeof task.owner === "string" && task.owner !== "" ? task.owner : null,
					dep: Array.isArray(task.dep) ? task.dep.filter(function (item) { return typeof item === "string" && item !== ""; }) : [],
					desc: typeof task.desc === "string" ? task.desc : "",
					created: typeof task.created === "string" ? task.created : null,
					updated: typeof task.updated === "string" ? task.updated : null,
					summary: typeof task.summary === "string" ? task.summary : "",
					fail: typeof task.fail === "string" ? task.fail : "",
					scope: Array.isArray(task.scope) ? task.scope.filter(function (item) { return typeof item === "string" && item !== ""; }) : []
				};
			}
			return {
				ok: true,
				board: {
					tasks: tasks,
					revision: typeof raw.revision === "number" && isFinite(raw.revision) ? raw.revision : null,
					seq: typeof raw.seq === "number" && isFinite(raw.seq) ? raw.seq : null
				}
			};
		}

		/** 四泳道分组（未知状态落 attention 且 statusKnown=false），组内 updated 降序（缺失排后，再按 id 稳定序）。 */
		function tbGroupByStatus(tasks) {
			var lanes = { attention: [], running: [], todo: [], done: [] };
			var ids = Object.keys(tasks == null ? {} : tasks);
			for (var index = 0; index < ids.length; index++) {
				var task = tasks[ids[index]];
				var lane = TB_STATUS_LANES[task.status];
				if (lane == null) {
					// 未知状态落「需要注意」泳道并标注（防御直接传入未经 parseBoard 的原始任务）。
					task = Object.assign({}, task, { statusKnown: false });
					lane = "attention";
				}
				lanes[lane].push(task);
			}
			TB_LANE_ORDER.forEach(function (name) {
				lanes[name].sort(function (a, b) {
					var au = a.updated == null ? "" : String(a.updated);
					var bu = b.updated == null ? "" : String(b.updated);
					if (au !== bu) return au < bu ? 1 : -1;
					return String(a.id).localeCompare(String(b.id));
				});
			});
			return lanes;
		}

		/**
		 * 依赖阻塞徽标：dep 指向任务 status≠done → blocked[id]；dep 指向未知 id → missing[id]；
		 * 环防御：迭代三色 DFS 检出环（结果仅记录，不参与阻塞计数，绝不递归展开）。
		 * @returns {{blocked:Object<string,string[]>,missing:Object<string,string[]>,cycles:string[]}}
		 */
		function tbComputeDepBadges(tasks) {
			var safe = tasks == null ? {} : tasks;
			var blocked = {};
			var missing = {};
			var ids = Object.keys(safe);
			var index;
			var depIndex;
			for (index = 0; index < ids.length; index++) {
				var task = safe[ids[index]];
				var deps = Array.isArray(task.dep) ? task.dep : [];
				for (depIndex = 0; depIndex < deps.length; depIndex++) {
					var depId = deps[depIndex];
					if (!Object.prototype.hasOwnProperty.call(safe, depId)) {
						if (!missing[task.id]) missing[task.id] = [];
						if (missing[task.id].indexOf(depId) < 0) missing[task.id].push(depId);
						continue;
					}
					if (safe[depId].status !== "done") {
						if (!blocked[task.id]) blocked[task.id] = [];
						if (blocked[task.id].indexOf(depId) < 0) blocked[task.id].push(depId);
					}
				}
			}
			// 环检测（迭代 DFS，三色标记；防 dep 自指/互指导致的无穷展开）
			var WHITE = 0;
			var GRAY = 1;
			var BLACK = 2;
			var color = {};
			for (index = 0; index < ids.length; index++) color[ids[index]] = WHITE;
			var cycles = [];
			for (index = 0; index < ids.length; index++) {
				if (color[ids[index]] !== WHITE) continue;
				var stack = [{ id: ids[index], depIndex: 0 }];
				color[ids[index]] = GRAY;
				while (stack.length > 0) {
					var frame = stack[stack.length - 1];
					var current = safe[frame.id];
					var currentDeps = Array.isArray(current.dep) ? current.dep : [];
					if (frame.depIndex >= currentDeps.length) {
						color[frame.id] = BLACK;
						stack.pop();
						continue;
					}
					var next = currentDeps[frame.depIndex];
					frame.depIndex += 1;
					if (!Object.prototype.hasOwnProperty.call(safe, next)) continue;
					if (color[next] === GRAY) {
						// 环 = GRAY 路径上从 next 到栈顶的整段（next..top 都在环上）。
						for (var start = stack.length - 1; start >= 0; start--) {
							if (cycles.indexOf(stack[start].id) < 0) cycles.push(stack[start].id);
							if (stack[start].id === next) break;
						}
						continue;
					}
					if (color[next] !== WHITE) continue;
					color[next] = GRAY;
					stack.push({ id: next, depIndex: 0 });
				}
			}
			return { blocked: blocked, missing: missing, cycles: cycles };
		}

		/** running 任务数（页头徽标）。 */
		function tbCountRunning(tasks) {
			var safe = tasks == null ? {} : tasks;
			var count = 0;
			var ids = Object.keys(safe);
			for (var index = 0; index < ids.length; index++) {
				if (safe[ids[index]].status === "running") count += 1;
			}
			return count;
		}

		/** keyed diff：旧板 → 新板的变化任务数（新增/移除/status/title/owner/updated 任一变化计 1）。 */
		function tbDiffCount(prevTasks, nextTasks) {
			var prev = prevTasks == null ? {} : prevTasks;
			var next = nextTasks == null ? {} : nextTasks;
			var changed = 0;
			var ids = Object.keys(next);
			var index;
			for (index = 0; index < ids.length; index++) {
				var id = ids[index];
				var old = prev[id];
				if (old == null) { changed += 1; continue; }
				var task = next[id];
				if (old.status !== task.status || old.title !== task.title || old.owner !== task.owner || old.updated !== task.updated) changed += 1;
			}
			var prevIds = Object.keys(prev);
			for (index = 0; index < prevIds.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(next, prevIds[index])) changed += 1;
			}
			return changed;
		}
		// 纯函数区收尾（提取契约见 test/client-taskboard.selftest.mjs）
		/** R1（sidebar-ux-spec-v2）：done 泳道初载折叠——done≥3 且存在非 done 任务；全板完成永不自动折叠。 */
		function tbInitialDoneFold(doneCount, totalCount) {
			return totalCount > 0 && doneCount >= 3 && doneCount < totalCount;
		}
		// TB-PURE-END

		/** 测试与调试出口：任务板纯函数集合（exports.taskboard）。 */
		var TASKBOARD_EXPORTS = {
			TB_TAB_ID: TB_TAB_ID,
			TB_TAB_KIND: TB_TAB_KIND,
			TB_DIR: TB_DIR,
			TB_STATUS_LANES: TB_STATUS_LANES,
			TB_LANE_ORDER: TB_LANE_ORDER,
			resolveBoard: tbResolveBoard,
			parseBoard: tbParseBoard,
			groupByStatus: tbGroupByStatus,
			computeDepBadges: tbComputeDepBadges,
			countRunning: tbCountRunning,
			diffCount: tbDiffCount,
			tbInitialDoneFold: tbInitialDoneFold
		};

		/** L3 会话 UI 缓存（spec v2 §8：零依赖、不写盘）——tab 关闭重开时按 sessionId 恢复
		 *  expandedId/doneFolded/ownerFilter/blockedOnly/statusFilter/scrollTop；深链 #task= 优先于缓存。 */
		var TB_UI_CACHE = Object.create(null);

		/** 任务板样式：只用产品主题 CSS 变量与 --dsw-radius-* 阶（禁自造色值/圆角）。 */
		// 任务板样式：只用产品 design token（--dsw-alias-*/--dsw-radius-*，见 docs/taskboard-visual-spec-v2.md 修正 token 表），
		// 禁自造色值/幽灵 token（label-quaternary、fill-l1、fill-l2、--dsw-shadow-*、十六进制字面量）。
		// 布局按 spec v2 方向 C「结构面板」；暗色限定规则用宿主 body[data-ds-dark-theme] 选择器。
		var TB_CSS = [
			".eso-tb-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);}",
			".eso-tb-root *,.eso-tb-root *::before,.eso-tb-root *::after{box-sizing:border-box;}",
			// —— 工具条（单行契约：恒一行，标题可截断，按钮 flex:none 不被挤压）
			".eso-tb-toolbar{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;}",
			".eso-tb-title{font-size:13px;font-weight:600;margin:0;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-title-skeleton{display:inline-block;width:72px;height:10px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);animation:eso-tb-load 1.5s ease-in-out infinite;}",
			".eso-tb-rev{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;}",
			".eso-tb-watch{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);flex:none;}",
			".eso-tb-toolbar-spacer{flex:1;}",
			".eso-tb-switch{position:relative;width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);padding:0;cursor:pointer;flex:none;transition:background 150ms ease;}",
			".eso-tb-switch[aria-checked=\"true\"]{background:var(--dsw-alias-interactive-bg-hover-accent);}",
			".eso-tb-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform 150ms ease;}",
			".eso-tb-switch[aria-checked=\"true\"]::after{transform:translateX(10px);background:var(--dsw-alias-bg-base);}",
			".eso-tb-switch:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-tb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;position:relative;transition:background 150ms ease,color 150ms ease;}",
			".eso-tb-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".eso-tb-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-tb-iconbtn[data-active]{color:var(--dsw-alias-label-primary);}",
			".eso-tb-iconbtn[data-active]::after{content:\"\";position:absolute;top:-2px;right:-2px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-business-primary);}",
			".eso-tb-iconbtn svg{width:14px;height:14px;display:block;flex:none;}",
			// —— 过滤行（任务 ≥8 时）
			".eso-tb-filters{display:flex;align-items:center;gap:6px;min-height:32px;padding:2px 12px;flex:none;flex-wrap:wrap;}",
			".eso-tb-filter-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background 150ms ease,color 150ms ease;flex:none;}",
			".eso-tb-filter-chip[data-on]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}",
			// P1-3 回炉（D2）：亮色 warn-label 基础规则已并入下方 D2 治理行（亮 label-secondary / 暗 warn-label）
			".eso-tb-filter-chip:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-tb-filter-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}",
			".eso-tb-reset{border:0;background:none;padding:0;font-size:11px;color:var(--dsw-alias-link);cursor:pointer;}",
			".eso-tb-reset:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			// —— 摘要条（窄档可折两行；更新时间右对齐）
			".eso-tb-summary{display:flex;align-items:center;gap:8px;padding:4px 12px 8px;flex:none;flex-wrap:wrap;row-gap:2px;}",
			".eso-tb-progress{width:80px;height:4px;border-radius:999px;background:var(--dsw-alias-bg-skeleton);overflow:hidden;flex:none;}",
			".eso-tb-progress > i{display:block;height:100%;background:var(--dsw-alias-state-success-primary);border-radius:999px;transition:width 200ms ease;}",
			".eso-tb-count{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}",
			".eso-tb-count-dot{width:6px;height:6px;border-radius:50%;}",
			".eso-tb-count-dot[data-st=\"done\"]{background:var(--dsw-alias-state-success-primary);}",
			".eso-tb-count-dot[data-st=\"running\"]{background:var(--dsw-alias-state-business-primary);}",
			".eso-tb-count-dot[data-st=\"escalated\"]{background:var(--dsw-alias-state-warn-primary);}",
			".eso-tb-complete-hint{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}",
			".eso-tb-stalehint{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-summary > .eso-tb-stalehint{margin-left:auto;}",
			".eso-tb-watchoff{display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-watchoff svg{width:12px;height:12px;}",
			// —— 完成横幅（spec v2 §4.2：44px、success-tertiary 底、左缘 3px success 实条、零交互、aria-live 播报一次）
			".eso-tb-complete{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;margin-bottom:8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-success-tertiary);border-left:3px solid var(--dsw-alias-state-success-primary);flex:none;}",
			".eso-tb-complete > svg{width:14px;height:14px;color:var(--dsw-alias-state-success-primary);flex:none;}",
			".eso-tb-complete-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:none;}",
			".eso-tb-complete-count{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-complete-ago{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;}",
			// —— 板区（方向 C「结构面板」：泳道为 bg-module-platform 面板容器，卡片浮于其上）
			".eso-tb-board{flex:1;min-height:0;overflow-y:auto;padding:8px 12px 16px;}",
			".eso-tb-lanes{display:flex;flex-direction:column;gap:8px;max-width:1440px;margin:0 auto;}",
			".eso-tb-root[data-eso-tb-wide] .eso-tb-lanes{display:grid;grid-template-columns:repeat(4,minmax(176px,1fr));gap:8px;align-items:start;}",
			".eso-tb-lane{min-width:0;background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg);padding:8px;}",
			".eso-tb-lane-head{display:flex;align-items:center;gap:6px;height:28px;flex:none;}",
			".eso-tb-lane-dot{width:8px;height:8px;border-radius:50%;flex:none;}",
			".eso-tb-lane-dot[data-lane=\"attention\"]{background:var(--dsw-alias-state-warn-primary);}",
			".eso-tb-lane-dot[data-lane=\"running\"]{background:var(--dsw-alias-state-business-primary);}",
			".eso-tb-lane-dot[data-lane=\"todo\"]{background:var(--dsw-alias-label-tertiary);}",
			".eso-tb-lane-dot[data-lane=\"done\"]{background:var(--dsw-alias-state-success-primary);}",
			".eso-tb-lane-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}",
			".eso-tb-lane-count{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}",
			".eso-tb-lane-blocked{font-size:11px;font-variant-numeric:tabular-nums;}",
			".eso-tb-lane-fold{border:0;background:none;padding:0 2px;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;height:20px;border-radius:var(--dsw-radius-xs);}",
			".eso-tb-lane-fold:hover{color:var(--dsw-alias-label-secondary);}",
			".eso-tb-lane-fold:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-tb-lane-fold svg{width:12px;height:12px;transition:transform 180ms cubic-bezier(0.2,0,0,1);}",
			".eso-tb-lane-fold[data-collapsed] svg{transform:rotate(-90deg);}",
			".eso-tb-lane-empty{display:flex;align-items:center;justify-content:center;min-height:32px;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-lane-cards{display:flex;flex-direction:column;gap:6px;}",
			// 宽档 done 泳道两列网格（卡片不再占满整行）
			".eso-tb-root[data-eso-tb-wide] .eso-tb-lane[data-lane=\"done\"] .eso-tb-lane-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}",
			// —— 卡片（bg-layer-1 + border-l1 浮于泳道面板之上）
			".eso-tb-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);animation:eso-tb-appear 150ms ease-out;}",
			".eso-tb-card:hover{border-color:var(--dsw-alias-border-l2);}",
			".eso-tb-card[data-highlight]{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px;}",
			".eso-tb-card-head{display:flex;align-items:flex-start;gap:8px;width:100%;padding:10px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
			".eso-tb-card-head:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:-2px;border-radius:var(--dsw-radius-md);}",
			".eso-tb-statusdot,.eso-tb-filter-dot{width:8px;height:8px;border-radius:50%;flex:none;}",
			".eso-tb-card-head .eso-tb-statusdot{margin-top:5px;}",
			".eso-tb-filter-dot{width:6px;height:6px;}",
			".eso-tb-statusdot[data-st=\"draft\"],.eso-tb-filter-dot[data-st=\"draft\"]{background:transparent;border:1.5px solid var(--dsw-alias-label-tertiary);}",
			".eso-tb-statusdot[data-st=\"pending\"],.eso-tb-filter-dot[data-st=\"pending\"]{background:var(--dsw-alias-label-tertiary);}",
			".eso-tb-statusdot[data-st=\"ready\"],.eso-tb-filter-dot[data-st=\"ready\"]{background:transparent;border:2px solid var(--dsw-alias-state-business-primary);}",
			".eso-tb-statusdot[data-st=\"running\"],.eso-tb-filter-dot[data-st=\"running\"]{background:var(--dsw-alias-state-business-primary);}",
			".eso-tb-statusdot[data-st=\"done\"],.eso-tb-filter-dot[data-st=\"done\"]{background:var(--dsw-alias-state-success-primary);}",
			".eso-tb-statusdot[data-st=\"failed\"],.eso-tb-filter-dot[data-st=\"failed\"]{background:var(--dsw-alias-state-error-primary);}",
			".eso-tb-statusdot[data-st=\"rejected\"],.eso-tb-filter-dot[data-st=\"rejected\"]{background:var(--dsw-alias-state-error-secondary);}",
			".eso-tb-statusdot[data-st=\"escalated\"],.eso-tb-filter-dot[data-st=\"escalated\"]{background:var(--dsw-alias-state-warn-primary);}",
			".eso-tb-statusdot[data-st=\"unknown\"],.eso-tb-filter-dot[data-st=\"unknown\"]{background:transparent;border:2px solid var(--dsw-alias-label-tertiary);}",
			".eso-tb-card[data-status=\"running\"] .eso-tb-statusdot{position:relative;animation:eso-tb-pulse 2s ease-in-out infinite;}",
			".eso-tb-card[data-status=\"running\"] .eso-tb-statusdot::after{content:\"\";position:absolute;inset:-2px;border-radius:50%;border:2px solid var(--dsw-alias-state-business-primary);opacity:0.4;}",
			".eso-tb-card-title{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}",
			".eso-tb-card[data-status=\"done\"] .eso-tb-card-title{font-weight:500;color:var(--dsw-alias-label-secondary);}",
			".eso-tb-card[data-status=\"draft\"] .eso-tb-card-title{font-weight:500;color:var(--dsw-alias-label-secondary);}",
			".eso-tb-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary);margin-top:3px;opacity:0;transition:transform 180ms cubic-bezier(0.2,0,0,1),opacity 150ms ease;}",
			".eso-tb-chevron svg{width:12px;height:12px;display:block;}",
			".eso-tb-card-head:hover .eso-tb-chevron,.eso-tb-card[data-expanded] .eso-tb-chevron{opacity:1;}",
			".eso-tb-card[data-expanded] .eso-tb-chevron{transform:rotate(180deg);}",
			".eso-tb-card-meta{display:flex;align-items:center;gap:6px;padding:0 12px 8px 28px;}",
			".eso-tb-card-id{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;}",
			".eso-tb-card-owner{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			// 紧凑档第二行：owner + scope 计数（「{n} 个文件」）
			".eso-tb-card-meta2{display:flex;align-items:center;gap:6px;padding:0 12px 8px 28px;min-width:0;}",
			".eso-tb-card-meta2 .eso-tb-card-owner{flex:none;max-width:120px;}",
			".eso-tb-card-scopecount{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-card-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:0 12px 10px 28px;}",
			".eso-tb-badge-blocked{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-warn-tertiary);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);flex:none;}",
			".eso-tb-badge-blocked svg{width:12px;height:12px;color:var(--dsw-alias-state-warn-primary);}",
			// 阻塞徽标文字亮色降对比问题（spec P1-4/D2：语义由 warn 图标+底色承载，暗色保留 warn-label）
			".eso-tb-lane-blocked,.eso-tb-detail-fail .eso-tb-detail-tag,.eso-tb-dep-blocked,.eso-tb-filter-chip[data-kind=\"blocked\"][data-on]{color:var(--dsw-alias-label-secondary);}",
			"body[data-ds-dark-theme] .eso-tb-lane-blocked,body[data-ds-dark-theme] .eso-tb-detail-fail .eso-tb-detail-tag,body[data-ds-dark-theme] .eso-tb-dep-blocked,body[data-ds-dark-theme] .eso-tb-filter-chip[data-kind=\"blocked\"][data-on],body[data-ds-dark-theme] .eso-tb-badge-blocked{color:var(--dsw-alias-state-warn-label);}",
			".eso-tb-chip{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:120px;flex:none;}",
			".eso-tb-chip svg{width:12px;height:12px;flex:none;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-chip > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-chip-more{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none;}",
			// —— 展开区（高度 200ms 动画：grid-template-rows 0fr→1fr）
			".eso-tb-detail-wrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows 200ms cubic-bezier(0.2,0,0,1);}",
			".eso-tb-card[data-expanded] .eso-tb-detail-wrap{grid-template-rows:1fr;}",
			".eso-tb-detail-inner{overflow:hidden;min-height:0;}",
			".eso-tb-card:not([data-expanded]) .eso-tb-detail-inner{visibility:hidden;}",
			".eso-tb-card-detail{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px;}",
			".eso-tb-detail-desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}",
			".eso-tb-detail-tag{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-detail-text{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word;}",
			".eso-tb-detail-fail{display:flex;gap:6px;align-items:baseline;}",
			".eso-tb-detail-summary{display:flex;gap:6px;align-items:baseline;}",
			".eso-tb-detail-deps{display:flex;flex-direction:column;gap:4px;}",
			".eso-tb-dep-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-dep-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none;}",
			".eso-tb-dep-dot[data-ok]{background:var(--dsw-alias-state-success-primary);}",
			// P1-3 回炉（D2）：原独立基础规则 .eso-tb-dep-blocked{color:warn-label} 位于 D2 覆盖行之后、
			// 同特异性后者胜导致亮色覆盖失效（对比度 2.79 不达 AA）——已删除，亮色走 D2 行 label-secondary、暗色走暗色 override 行 warn-label
			".eso-tb-copy{align-self:flex-start;border:0;background:none;padding:0;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer;}",
			".eso-tb-copy:hover{color:var(--dsw-alias-link);}",
			".eso-tb-copy:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			// —— 骨架 / 空态 / 错误
			".eso-tb-skeleton{height:64px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;animation:eso-tb-load 1.5s ease-in-out infinite;}",
			".eso-tb-skeleton i{display:block;height:8px;width:70%;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);}",
			".eso-tb-skeleton i:last-child{height:6px;width:45%;}",
			".eso-tb-empty{min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;padding:24px 12px;}",
			".eso-tb-empty > svg{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);}",
			".eso-tb-empty-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);}",
			".eso-tb-empty-body{font-size:12px;color:var(--dsw-alias-label-tertiary);max-width:400px;}",
			".eso-tb-linklike{border:0;background:none;padding:0;font-size:12px;color:var(--dsw-alias-link);cursor:pointer;}",
			".eso-tb-linklike:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-tb-error-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);}",
			".eso-tb-truncate{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-errorstrip{display:flex;align-items:center;gap:6px;height:28px;padding:0 12px;margin:0 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);flex:none;}",
			".eso-tb-errorstrip i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none;}",
			".eso-tb-errorstrip > span{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-errorstrip > time{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;}",
			".eso-tb-candidates{display:flex;flex-direction:column;gap:4px;max-width:420px;width:100%;margin-top:8px;}",
			".eso-tb-candidate{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);}",
			".eso-tb-candidate > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".eso-tb-candidate > time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;}",
			".eso-tb-candidate [data-chat]{flex:none;font-size:11px;color:var(--dsw-alias-state-business-primary);}",
			".eso-tb-help{max-width:400px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);}",
			// —— 屏幕阅读器 live 区
			".eso-tb-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}",
			// —— 页头徽标入口
			".eso-tb-hbtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;transition:background 150ms ease,color 150ms ease;}",
			".eso-tb-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".eso-tb-hbtn[data-open]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}",
			".eso-tb-hbtn:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px;}",
			".eso-tb-hbtn svg{width:16px;height:16px;display:block;}",
			".eso-tb-hbadge{position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);font-size:10px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums;text-align:center;}",
			// —— 密度阶梯（spec v2 §5：<360 裁 r{n}/watch 点；<300 兜底单行；300-479 紧凑两行卡）
			".eso-tb-root[data-eso-tb-w360] .eso-tb-rev,.eso-tb-root[data-eso-tb-w360] .eso-tb-watch{display:none;}",
			".eso-tb-root[data-eso-tb-compact] .eso-tb-card-title,.eso-tb-root[data-eso-tb-xnarrow] .eso-tb-card-title{-webkit-line-clamp:1;}",
			// P1-1 回炉（UX spec §3-1）：xnarrow 仅隐藏 scope chips（chip/chip-more 各自隐藏即可），
		// 不得隐藏 .eso-tb-card-badges 容器——阻塞徽章任何密度档都不得裁剪
		".eso-tb-root[data-eso-tb-xnarrow] .eso-tb-chip,.eso-tb-root[data-eso-tb-xnarrow] .eso-tb-chip-more{display:none;}",
			".eso-tb-root[data-eso-tb-compact] .eso-tb-card-head{padding-bottom:2px;}",
			".eso-tb-root[data-eso-tb-compact] .eso-tb-badge-blocked{margin-left:auto;}",
			// —— 动效（仅 4 个；reduced-motion 全归零；页面隐藏暂停脉冲）
			"@keyframes eso-tb-appear{from{opacity:0;}to{opacity:1;}}",
			"@keyframes eso-tb-pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}",
			"@keyframes eso-tb-load{0%,100%{opacity:1;}50%{opacity:0.55;}}",
			".eso-tb-root[data-eso-tb-hidden] .eso-tb-statusdot,.eso-tb-root[data-eso-tb-hidden] .eso-tb-skeleton,.eso-tb-root[data-eso-tb-hidden] .eso-tb-title-skeleton{animation:none;}",
			"@media (prefers-reduced-motion: reduce){.eso-tb-root *,.eso-tb-root *::before,.eso-tb-root *::after{animation:none !important;transition:none !important;}}"
		].join("\n");

		function tbSvg(paths, size) {
			return React.createElement("svg", { viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": "true", focusable: "false" },
				paths.map(function (d) { return React.createElement("path", { key: d, d: d, fill: "currentColor" }); }));
		}
		var TB_ICONS = {
			board: function (size) { return tbSvg(["M2 2h3.2v12H2zM6.4 2h3.2v8.4H6.4zM10.8 2H14v5.6h-3.2z"], size); },
			chevron: function (size) { return tbSvg(["M8 10.9 3.4 6.3l1.06-1.06L8 8.78l3.54-3.54L12.6 6.3z"], size); },
			warn: function (size) { return tbSvg(["M8 2.2c.4 0 .77.21.97.56l5.1 8.9c.4.7-.1 1.57-.9 1.57H2.83c-.8 0-1.3-.87-.9-1.57l5.1-8.9c.2-.35.57-.56.97-.56zM8.85 6.2H7.15l.13 3.3h1.44zM8 12.3a.95.95 0 1 0 0-1.9.95.95 0 0 0 0 1.9z"], size); },
			error: function (size) { return tbSvg(["M8 1.6a6.4 6.4 0 1 1 0 12.8A6.4 6.4 0 0 1 8 1.6zm0 1.3a5.1 5.1 0 1 0 0 10.2A5.1 5.1 0 0 0 8 2.9zM6.2 5.6 8 7.4l1.8-1.8.9.9L8.9 8.3l1.8 1.8-.9.9L8 9.2l-1.8 1.8-.9-.9 1.8-1.8-1.8-1.8z"], size); },
			refresh: function (size) { return tbSvg(["M13.4 8A5.4 5.4 0 1 1 8 2.6v1.3A4.1 4.1 0 1 0 12.1 8zM8 2.6 4.4 5.2 8 7.8z"], size); },
			filter: function (size) { return tbSvg(["M2.2 3h11.6L9.6 8.5v3.9l-3.2 1.8V8.5z"], size); },
			box: function (size) { return tbSvg(["M3 3h10v10H3V3zm1.2 1.2v7.6h7.6V4.2H4.2z"], size); },
			file: function (size) { return tbSvg(["M4 2h5l3 3v9H4V2zm1.2 1.2v9.6h5.6V6h-2.4V3.2H5.2z"], size); },
			check: function (size) { return tbSvg(["M6.5 11.9 3.2 8.6l1.06-1.06L6.5 9.78l5.24-5.24L12.8 5.6z"], size); }
		};
		var TB_LANE_META = {
			attention: { label: "tb.lane.attention" },
			running: { label: "tb.lane.running" },
			todo: { label: "tb.lane.todo" },
			done: { label: "tb.lane.done" }
		};

		/** cordis ctx 能力探测：ctx.get 优先（服务未提供返回 undefined），异常按缺失处理（fail-open）。 */
		function tbService(ctx, name) {
			try { return ctx.get(name) || null; } catch (error) { return null; }
		}

		/**
		 * 任务板看板正文（slot 'sidebar.right.pane.tab'，key = TB_TAB_ID）。
		 * props：sessionId（session scope）、t（NS 词条）、tbIo（workspaceFiles IO 面）、useTabInfo（宿主 hook）。
		 */
		function TaskBoardBody(props) {
			var sessionId = props.sessionId;
			var t = props.t;
			var io = props.tbIo;
			var tabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
			var tab = tabInfo ? tabInfo.tab : null;
			var visible = tab ? tab.visible !== false : true;

			var state0 = React.useState({ phase: "loading" });
			var state = state0[0];
			var setState = state0[1];
			var stateRef = React.useRef(state);
			stateRef.current = state;
			var auto0 = React.useState(true);
			var autoRefresh = auto0[0];
			var setAutoRefresh = auto0[1];
			var watch0 = React.useState(false);
			var watchOn = watch0[0];
			var setWatchOn = watch0[1];
			// L3 会话 UI 缓存（spec v2 §8）：tab 关闭重开按 sessionId 恢复；深链 #task= 在初始加载时覆盖 expandedId
			var cachedUi = TB_UI_CACHE[sessionId] || null;
			var exp0 = React.useState(cachedUi && cachedUi.expandedId != null ? cachedUi.expandedId : null);
			var expandedId = exp0[0];
			var setExpandedId = exp0[1];
			var own0 = React.useState(cachedUi && cachedUi.ownerFilter != null ? cachedUi.ownerFilter : null);
			var ownerFilter = own0[0];
			var setOwnerFilter = own0[1];
			var blk0 = React.useState(cachedUi ? cachedUi.blockedOnly === true : false);
			var blockedOnly = blk0[0];
			var setBlockedOnly = blk0[1];
			var stf0 = React.useState(cachedUi && Array.isArray(cachedUi.statusFilter) ? cachedUi.statusFilter.slice() : []);
			var statusFilter = stf0[0];
			var setStatusFilter = stf0[1];
			var fo0 = React.useState(false);
			var filtersOpen = fo0[0];
			var setFiltersOpen = fo0[1];
			var note0 = React.useState(null);
			var note = note0[0];
			var setNote = note0[1];
			var hi0 = React.useState(null);
			var highlightId = hi0[0];
			var setHighlightId = hi0[1];
			var live0 = React.useState("");
			var live = live0[0];
			var setLive = live0[1];
			var wide0 = React.useState(false);
			var isWide = wide0[0];
			var setWide = wide0[1];
			var den0 = React.useState("standard");
			var density = den0[0];
			var setDensity = den0[1];
			var fold0 = React.useState(cachedUi && cachedUi.doneFolded != null ? cachedUi.doneFolded : null);
			var doneFolded = fold0[0];
			var setDoneFolded = fold0[1];
			var copy0 = React.useState(null);
			var copiedId = copy0[0];
			var setCopiedId = copy0[1];
			var help0 = React.useState(false);
			var helpOpen = help0[0];
			var setHelpOpen = help0[1];
			var tick0 = React.useState(0);
			var setTick = tick0[1];

			var rootRef = React.useRef(null);
			var scrollRef = React.useRef(null);
			var apiRef = React.useRef({});
			var compareRef = React.useRef(null);
			var scheduleCompareRef = React.useRef(function () {});
			var versionRef = React.useRef(null);
			var pendingRef = React.useRef(false);
			var anchorRef = React.useRef(null);
			var debounceRef = React.useRef(null);
			var seqRef = React.useRef(0);
			var deepLinkRef = React.useRef(undefined);
			var deepAppliedRef = React.useRef(false);
			var foldInitRef = React.useRef(false);
			var expandedRef = React.useRef(null);
			expandedRef.current = expandedId;
			var doneFoldedRef = React.useRef(doneFolded);
			doneFoldedRef.current = doneFolded;
			var uiSnapRef = React.useRef(null);
			uiSnapRef.current = {
				expandedId: expandedId,
				doneFolded: doneFolded,
				ownerFilter: ownerFilter,
				blockedOnly: blockedOnly,
				statusFilter: statusFilter
			};
			var uiScrollRef = React.useRef(cachedUi && cachedUi.scrollTop != null ? cachedUi.scrollTop : 0);
			var restoreScrollRef = React.useRef(cachedUi && cachedUi.scrollTop != null ? cachedUi.scrollTop : null);
			var focusRepairRef = React.useRef(false);
			var allDoneRef = React.useRef(false);
			var filteredCountRef = React.useRef(null);
			var visibleRef = React.useRef(visible);
			visibleRef.current = visible;
			if (deepLinkRef.current === undefined) {
				var navParams = tab && tab.navigation ? tab.navigation.params : null;
				deepLinkRef.current = navParams && typeof navParams.task === "string" ? navParams.task : null;
			}

			// 面板打开信号（页头徽标选中态用，keepMounted:false 下挂载≈打开）
			React.useEffect(function () {
				TB_OPEN_COUNT += 1;
				return function () { TB_OPEN_COUNT -= 1; };
			}, []);

			// 容器宽度断点：ResizeObserver 切 data-eso-tb-*（不用媒体查询，规格裁决）。
			// 密度阶梯（spec v2 §5）：≥720 宽档 / 480-719 标准 / 300-479 紧凑 / <300 兜底；<360 附加裁剪档。
			React.useEffect(function () {
				var el = rootRef.current;
				if (!el || typeof ResizeObserver === "undefined") return undefined;
				var observer = new ResizeObserver(function (entries) {
					var width = entries[0].contentRect.width;
					var wide = width >= 720;
					if (wide) el.setAttribute("data-eso-tb-wide", "");
					else el.removeAttribute("data-eso-tb-wide");
					if (width < 360) el.setAttribute("data-eso-tb-w360", "");
					else el.removeAttribute("data-eso-tb-w360");
					if (width >= 300 && width < 480) el.setAttribute("data-eso-tb-compact", "");
					else el.removeAttribute("data-eso-tb-compact");
					if (width < 300) el.setAttribute("data-eso-tb-xnarrow", "");
					else el.removeAttribute("data-eso-tb-xnarrow");
					setWide(wide);
					setDensity(width >= 720 ? "wide" : width >= 480 ? "standard" : width >= 300 ? "compact" : "xnarrow");
				});
				observer.observe(el);
				return function () { observer.disconnect(); };
			}, []);

			// document.hidden 暂停脉冲（data-eso-tb-hidden）
			React.useEffect(function () {
				var el = rootRef.current;
				if (!el || typeof document === "undefined") return undefined;
				var onVisibility = function () {
					if (document.hidden) el.setAttribute("data-eso-tb-hidden", "");
					else el.removeAttribute("data-eso-tb-hidden");
				};
				document.addEventListener("visibilitychange", onVisibility);
				return function () { document.removeEventListener("visibilitychange", onVisibility); };
			}, []);

			// 相对时间刷新（{n} 分钟前更新）
			React.useEffect(function () {
				var timer = setInterval(function () { setTick(function (value) { return value + 1; }); }, 60000);
				return function () { clearInterval(timer); };
			}, []);

			// —— 加载编排：list → resolve → stat/read → 渲染；tab.signal abort 全释放
			React.useEffect(function () {
				if (!io || !sessionId) {
					setState({ phase: "error", message: null });
					return undefined;
				}
				var disposed = false;
				var ac = new AbortController();
				var hostSignal = tab ? tab.signal : null;
				if (hostSignal && typeof hostSignal.addEventListener === "function") {
					if (hostSignal.aborted) ac.abort();
					else hostSignal.addEventListener("abort", function () { ac.abort(); }, { once: true });
				}

				function readBoard(name) {
					var path = TB_DIR + "/" + name;
					return io.stat(sessionId, path, ac.signal).then(function (statResult) {
						var stat = unwrap(statResult);
						versionRef.current = stat && stat.version != null ? stat.version : null;
						return io.read(sessionId, path, ac.signal).then(function (readResult) {
							var file = unwrap(readResult);
							var parsed = tbParseBoard(file && file.text);
							if (!parsed.ok) return { kind: "broken" };
							return { kind: "ok", board: parsed.board, fileName: name };
						});
					});
				}

				function resolveListing() {
					return io.list(sessionId, TB_DIR, ac.signal).then(function (listResult) {
						var listing = unwrap(listResult);
						return tbResolveBoard(listing ? listing.entries : null);
					});
				}

				function applyBoardResult(result, opts) {
					if (disposed) return;
					opts = opts || {};
					if (result.kind !== "ok") {
						setState({ phase: "ready", boardKind: result.kind, candidates: result.candidates });
						return;
					}
					var board = result.board;
					var prev = stateRef.current;
					if (expandedRef.current && !board.tasks[expandedRef.current]) setExpandedId(null);
					if (!foldInitRef.current) {
						foldInitRef.current = true;
						if (doneFoldedRef.current == null) { // L3 缓存命中的折叠态让位于初值恢复
							var doneCount = 0;
							var ids = Object.keys(board.tasks);
							for (var index = 0; index < ids.length; index++) {
								if (board.tasks[ids[index]].status === "done") doneCount += 1;
							}
							// R1（sidebar-ux-spec-v2）：done≥3 且存在非 done 任务才自动折叠；全板完成永不自动折叠
							setDoneFolded(tbInitialDoneFold(doneCount, ids.length));
						}
					}
					var changed = 0;
					var prevBoard = prev && prev.boardKind === "ok" ? prev.board : null;
					if (prevBoard && !opts.initial) changed = tbDiffCount(prevBoard.tasks, board.tasks);
					if (opts.initial && !deepAppliedRef.current) {
						deepAppliedRef.current = true;
						var linkId = deepLinkRef.current;
						if (linkId && board.tasks[linkId]) {
							setExpandedId(linkId);
							setHighlightId(linkId);
						}
					}
					setState({ phase: "ready", boardKind: "ok", board: board, fileName: result.fileName, loadedAt: Date.now() });
					if (changed > 0) setLive(format(t("tb.updatedCount"), { n: changed }));
				}

				function initialLoad() {
					return resolveListing().then(function (resolved) {
						if (resolved.kind !== "ok") { applyBoardResult(resolved); return undefined; }
						return readBoard(resolved.file).then(function (result) { applyBoardResult(result, { initial: true }); });
					}).catch(function (error) {
						if (disposed || ac.signal.aborted) return;
						setState({ phase: "error", message: messageOf(error) });
					});
				}

				// 滚动锚点：视口顶部第一个可见卡回滚（刷新不动焦点，UX 规格裁决）
				function saveAnchor() {
					var scroller = scrollRef.current;
					if (!scroller) return;
					var first = scroller.querySelector(".eso-tb-card-head");
					if (!first) { anchorRef.current = null; return; }
					anchorRef.current = { id: first.getAttribute("data-card-id"), top: first.getBoundingClientRect().top };
				}

				function refresh() {
					var seq = ++seqRef.current;
					return resolveListing().then(function (resolved) {
						if (disposed || ac.signal.aborted) return undefined;
						if (resolved.kind !== "ok") { applyBoardResult(resolved); setNote(null); return undefined; }
						saveAnchor();
						return readBoard(resolved.file).then(function (result) {
							if (disposed || ac.signal.aborted || seq !== seqRef.current) return undefined;
							applyBoardResult(result);
							setNote(null);
							return undefined;
						});
					}).catch(function (error) {
						if (disposed || ac.signal.aborted) return;
						// 有旧数据：内联条提示，不推翻现渲染（规格：刷新失败有旧数据）+ aria 播报
						setNote({ kind: "error", message: messageOf(error), at: Date.now() });
						setLive(t("tb.error.stale"));
					});
				}

				function compareRefresh() {
					if (!visibleRef.current) { pendingRef.current = true; return; }
					resolveListing().then(function (resolved) {
						if (disposed || ac.signal.aborted) return undefined;
						if (resolved.kind !== "ok") { void refresh(); return undefined; }
						var path = TB_DIR + "/" + resolved.file;
						return io.stat(sessionId, path, ac.signal).then(function (statResult) {
							var stat = unwrap(statResult);
							var version = stat && stat.version != null ? stat.version : null;
							if (versionRef.current != null && version === versionRef.current) return undefined; // stat 版本未变
							saveAnchor();
							return readBoard(resolved.file).then(function (result) {
								if (!disposed && !ac.signal.aborted) applyBoardResult(result);
								return undefined;
							});
						});
					}).catch(function (error) {
						if (disposed || ac.signal.aborted) return;
						setNote({ kind: "error", message: messageOf(error), at: Date.now() });
						setLive(t("tb.error.stale"));
					});
				}

				function scheduleCompareRefresh() {
					if (debounceRef.current) clearTimeout(debounceRef.current);
					debounceRef.current = setTimeout(function () {
						debounceRef.current = null;
						if (!disposed) compareRefresh();
					}, 500);
				}

				apiRef.current = { refresh: refresh, redetect: initialLoad };
				compareRef.current = compareRefresh;
				scheduleCompareRef.current = scheduleCompareRefresh;

				void initialLoad();
				return function () {
					disposed = true;
					ac.abort();
					if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
				};
			}, [sessionId, io]);

			// L3 会话 UI 缓存卸载落位（spec v2 §8）：以 render 期快照写入模块级缓存（零依赖、不写盘）
			React.useEffect(function () {
				return function () {
					var snap = uiSnapRef.current;
					if (!snap) return;
					TB_UI_CACHE[sessionId] = {
						expandedId: snap.expandedId,
						doneFolded: snap.doneFolded,
						ownerFilter: snap.ownerFilter,
						blockedOnly: snap.blockedOnly,
						statusFilter: snap.statusFilter,
						scrollTop: uiScrollRef.current
					};
				};
			}, [sessionId]);

			// —— watch：SupervisedStream 包 changes；frame ready=连接 / change=防抖 500ms + stat 版本比对
			React.useEffect(function () {
				if (!io || !sessionId || !autoRefresh) { setWatchOn(false); return undefined; }
				if (typeof io.$stream !== "function" || typeof io.changes !== "function") return undefined;
				var disposed = false;
				var stream = io.$stream({
					name: "dsh-expert-orchestrator/taskboard-watch",
					open: function (signal) { return io.changes(sessionId, TB_DIR, signal); },
					ended: function () { return new Error("taskboard watch generation ended"); }
				});
				var iterator = typeof stream[Symbol.asyncIterator] === "function" ? stream[Symbol.asyncIterator]() : stream;
				function pump() {
					iterator.next().then(function (step) {
						if (disposed) return;
						if (!step || step.done) { setWatchOn(false); return; }
						var item = step.value;
						try { item.accept(); } catch (acceptError) { /* accept 竞态可忽略 */ }
						var frame = item ? item.value : null;
						if (frame && frame.kind === "ready") setWatchOn(true);
						else if (frame && frame.kind === "change") scheduleCompareRef.current();
						pump();
					}).catch(function () {
						if (!disposed) setWatchOn(false);
					});
				}
				pump();
				return function () {
					disposed = true;
					void stream.dispose();
				};
			}, [sessionId, io, autoRefresh]);

			// tab.visible 暂停/恢复：不可见期间的 change 记 pending，恢复可见立即比对刷新
			React.useEffect(function () {
				if (!visible || !pendingRef.current) return undefined;
				pendingRef.current = false;
				if (compareRef.current) compareRef.current();
				return undefined;
			}, [visible]);

			// 深链高亮：滚动到卡 + 2s 高亮后清除
			React.useLayoutEffect(function () {
				if (!highlightId) return undefined;
				var el = scrollRef.current ? scrollRef.current.querySelector(".eso-tb-card[data-task-id=\"" + highlightId + "\"]") : null;
				if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
				var timer = setTimeout(function () { setHighlightId(null); }, 2000);
				return function () { clearTimeout(timer); };
			}, [highlightId]);

			// 刷新后滚动锚点回滚
			React.useLayoutEffect(function () {
				var anchor = anchorRef.current;
				anchorRef.current = null;
				if (!anchor || !scrollRef.current) return;
				var el = scrollRef.current.querySelector(".eso-tb-card-head[data-card-id=\"" + anchor.id + "\"]");
				if (!el) return;
				var delta = el.getBoundingClientRect().top - anchor.top;
				if (delta) scrollRef.current.scrollTop += delta;
			});

			// L3 恢复滚动位置：board 首次就绪后一次（深链高亮的 scrollIntoView 在其 layout effect 中先行）
			React.useLayoutEffect(function () {
				if (restoreScrollRef.current == null) return;
				if (state.phase !== "ready" || !state.board || !scrollRef.current) return;
				scrollRef.current.scrollTop = restoreScrollRef.current;
				restoreScrollRef.current = null;
			});

			// —— aria 播报（spec v2 §7）：全板完成一次；筛选生效/结果变化播报 {n}
			React.useEffect(function () {
				var isAll = boardData != null && taskCount > 0 && lanes != null && lanes.done.length === taskCount;
				if (isAll && !allDoneRef.current) setLive(t("tb.aria.allDone"));
				allDoneRef.current = isAll;
			});
			React.useEffect(function () {
				if (!filtersActive || !lanes) { filteredCountRef.current = null; return undefined; }
				var visibleCount = 0;
				TB_LANE_ORDER.forEach(function (name) { visibleCount += filteredLanes[name].length; });
				if (filteredCountRef.current !== visibleCount) {
					filteredCountRef.current = visibleCount;
					setLive(format(t("tb.aria.filtered"), { n: visibleCount }));
				}
				return undefined;
			});

			// F1 焦点防护：过滤变更使焦点卡隐藏 → 焦点移到过滤行「重置」或筛选按钮
			React.useLayoutEffect(function () {
				if (!focusRepairRef.current) return;
				focusRepairRef.current = false;
				var root = rootRef.current;
				if (!root) return;
				var target = root.querySelector(".eso-tb-filters .eso-tb-reset");
				if (!target) target = root.querySelector("[data-eso-tb-filter]");
				if (target && typeof target.focus === "function") target.focus();
			});

			// —— 交互
			function toggleExpand(id) {
				setExpandedId(function (prev) { return prev === id ? null : id; });
			}
			function focusHead(id) {
				var el = scrollRef.current ? scrollRef.current.querySelector(".eso-tb-card-head[data-card-id=\"" + id + "\"]") : null;
				if (el) el.focus();
			}
			function onCardKeyDown(event, id) {
				if (event.key === "Escape" && expandedId === id) {
					setExpandedId(null); // 焦点已在卡头
					return;
				}
				var container = scrollRef.current;
				if (!container) return;
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
				var heads = Array.prototype.slice.call(container.querySelectorAll(".eso-tb-card-head"));
				var index = heads.indexOf(event.currentTarget);
				if (index < 0) return;
				event.preventDefault();
				var next;
				if (event.key === "ArrowDown") next = (index + 1) % heads.length;
				else if (event.key === "ArrowUp") next = (index - 1 + heads.length) % heads.length;
				else if (event.key === "Home") next = 0;
				else next = heads.length - 1;
				heads[next].focus();
			}
			function copyTaskId(id) {
				var done = function () {
					setCopiedId(id);
					setLive(t("tb.copied"));
					setTimeout(function () { setCopiedId(function (prev) { return prev === id ? null : prev; }); }, 2000);
				};
				if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(id).then(done, function () { setLive(id); });
				} else {
					setLive(id);
				}
			}
			// F1 焦点防护辅助：若当前焦点是任务卡头且变更后将不可见，标记下一帧把焦点移出板区
			function repairFocusOnFilterChange(nextBlockedOnly, nextStatusFilter, nextOwnerFilter) {
				if (typeof document === "undefined") return;
				var active = document.activeElement;
				if (!active || typeof active.closest !== "function" || !active.classList.contains("eso-tb-card-head")) return;
				var id = active.getAttribute("data-card-id");
				var task = boardTasks[id];
				if (!task) return;
				var visible = true;
				if (nextBlockedOnly && (boardBadges.blocked[task.id] || []).length === 0) visible = false;
				if (visible && nextStatusFilter.length > 0 && nextStatusFilter.indexOf(task.status) < 0) visible = false;
				if (visible && nextOwnerFilter != null && task.owner !== nextOwnerFilter) visible = false;
				if (!visible) focusRepairRef.current = true;
			}
			function toggleStatusFilter(status) {
				var on = statusFilter.indexOf(status) >= 0;
				var next = on
					? statusFilter.filter(function (item) { return item !== status; })
					: statusFilter.concat([status]);
				repairFocusOnFilterChange(blockedOnly, next, ownerFilter);
				setStatusFilter(next);
			}
			function toggleBlockedOnly() {
				repairFocusOnFilterChange(!blockedOnly, statusFilter, ownerFilter);
				setBlockedOnly(!blockedOnly);
			}
			function toggleOwnerFilter(owner) {
				repairFocusOnFilterChange(blockedOnly, statusFilter, ownerFilter === owner ? null : owner);
				setOwnerFilter(ownerFilter === owner ? null : owner);
			}
			function resetFilters() {
				setBlockedOnly(false);
				setStatusFilter([]);
				setOwnerFilter(null);
			}
			// F2 焦点防护 + laneFolded/laneExpanded 播报：折叠 done 若焦点卡在其中，焦点移到折叠按钮
			function toggleDoneFold(event) {
				var collapsing = !doneFolded;
				if (collapsing) {
					if (typeof document !== "undefined") {
						var active = document.activeElement;
						if (active && typeof active.closest === "function" && active.classList.contains("eso-tb-card-head")
							&& active.closest(".eso-tb-lane[data-lane=\"done\"]")) {
							event.currentTarget.focus();
						}
					}
					setLive(format(t("tb.aria.laneFolded"), { n: lanes.done.length }));
				} else {
					setLive(t("tb.aria.laneExpanded"));
				}
				setDoneFolded(!doneFolded);
			}
			function redetect() {
				setState({ phase: "loading" });
				if (apiRef.current.redetect) apiRef.current.redetect();
			}
			function manualRefresh() {
				if (apiRef.current.refresh) apiRef.current.refresh();
			}

			// —— 渲染派生量
			var boardData = state.boardKind === "ok" ? state.board : null;
			var boardTasks = boardData ? boardData.tasks : {};
			var boardBadges = boardData ? tbComputeDepBadges(boardTasks) : { blocked: {}, missing: {}, cycles: [] };
			var taskCount = Object.keys(boardTasks).length;
			var lanes = boardData ? tbGroupByStatus(boardTasks) : null;
			var ownerNames = boardData ? Object.keys(boardTasks)
				.map(function (id) { return boardTasks[id].owner; })
				.filter(function (owner, index, all) { return owner != null && all.indexOf(owner) === index; })
				.sort(function (a, b) { return a.localeCompare(b); }) : [];
			var statusCounts = {};
			if (boardData) {
				Object.keys(boardTasks).forEach(function (id) {
					var status = boardTasks[id].status;
					statusCounts[status] = (statusCounts[status] || 0) + 1;
				});
			}
			var filtersActive = blockedOnly || statusFilter.length > 0 || ownerFilter != null;
			var showFilterButton = taskCount >= 8;
			function taskVisible(task) {
				if (blockedOnly && (boardBadges.blocked[task.id] || []).length === 0) return false;
				if (statusFilter.length > 0 && statusFilter.indexOf(task.status) < 0) return false;
				if (ownerFilter != null && task.owner !== ownerFilter) return false;
				return true;
			}
			var filteredLanes = null;
			var anyVisible = false;
			if (lanes) {
				filteredLanes = {};
				TB_LANE_ORDER.forEach(function (name) {
					filteredLanes[name] = lanes[name].filter(taskVisible);
					if (filteredLanes[name].length > 0) anyVisible = true;
				});
			}

			function statusName(status) {
				return TB_STATUS_LANES[status] ? t("tb.status." + status) : t("tb.status.unknown");
			}
			function statusDot(status) {
				return React.createElement("span", { className: "eso-tb-statusdot", "data-st": status });
			}
			function cardAria(task, blockedCount) {
				var label = task.id + " · " + task.title;
				if (task.owner) label += " · " + format(t("tb.aria.owner"), { owner: task.owner });
				label += " · " + statusName(task.status);
				if (blockedCount > 0) label += format(t("tb.aria.blocked"), { n: blockedCount });
				return label;
			}
			function formatClock(ms) {
				var date = new Date(ms);
				var pad = function (value) { return String(value).padStart(2, "0"); };
				return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
			}

			function renderCard(task) {
				var blockedDeps = boardBadges.blocked[task.id] || [];
				var blockedCount = blockedDeps.length;
				var expanded = expandedId === task.id;
				var headId = "eso-tb-head-" + task.id;
				var detailId = "eso-tb-detail-" + task.id;
				var compact = density === "compact";
				var blockedBadge = null;
				if (blockedCount > 0) {
					var firstDep = boardTasks[blockedDeps[0]];
					blockedBadge = React.createElement("span", {
						key: "blocked",
						className: "eso-tb-badge-blocked",
						title: firstDep ? format(t("tb.waiting"), { taskId: firstDep.id, owner: firstDep.owner || "-", status: statusName(firstDep.status) }) : t("tb.blocked")
					}, TB_ICONS.warn(12), format(t("tb.blocked.n"), { n: blockedCount }));
				}
				var headButton = React.createElement("button", {
					key: "head",
					type: "button",
					className: "eso-tb-card-head",
					id: headId,
					"data-card-id": task.id,
					"aria-expanded": expanded ? "true" : "false",
					"aria-controls": detailId,
					"aria-label": cardAria(task, blockedCount),
					onClick: function () { toggleExpand(task.id); },
					onKeyDown: function (event) { onCardKeyDown(event, task.id); }
				},
					statusDot(task.status),
					compact ? React.createElement("span", { className: "eso-tb-card-id" }, task.id) : null,
					React.createElement("span", { className: "eso-tb-card-title" }, task.title),
					compact && blockedCount > 0 ? blockedBadge : null,
					React.createElement("span", { className: "eso-tb-chevron" }, TB_ICONS.chevron(12))
				);
				var children;
				if (compact) {
					// 紧凑档（300-479px，spec v2 §5）：两行卡——行1 点+ID+标题+阻塞徽章；行2 owner + scope 计数
					children = [
						headButton,
						React.createElement("div", { key: "meta", className: "eso-tb-card-meta2" },
							task.owner ? React.createElement("span", { className: "eso-tb-card-owner" }, task.owner) : null,
							task.scope.length > 0 ? React.createElement("span", { className: "eso-tb-card-scopecount" }, format(t("tb.scope.count"), { n: task.scope.length })) : null)
					];
				} else {
					children = [
						headButton,
						React.createElement("div", { key: "meta", className: "eso-tb-card-meta" },
							React.createElement("span", { className: "eso-tb-card-id" }, task.id),
							task.owner ? React.createElement("span", { className: "eso-tb-card-owner" }, task.owner) : null)
					];
					var badges = [];
					if (blockedCount > 0) badges.push(blockedBadge);
					task.scope.slice(0, 2).forEach(function (item, index) {
						badges.push(React.createElement("span", { key: "scope" + index, className: "eso-tb-chip", title: item },
							TB_ICONS.file(12), React.createElement("span", null, item)));
					});
					if (task.scope.length > 2) {
						badges.push(React.createElement("span", { key: "more", className: "eso-tb-chip-more" }, "+" + (task.scope.length - 2)));
					}
					if (badges.length > 0) {
						children.push(React.createElement("div", { key: "badges", className: "eso-tb-card-badges" }, badges));
					}
				}
				var detailParts = [];
				if (task.fail) {
					detailParts.push(React.createElement("div", { key: "fail", className: "eso-tb-detail-fail" },
						React.createElement("span", { className: "eso-tb-detail-tag" }, t("tb.failed")),
						React.createElement("span", { className: "eso-tb-detail-text" }, task.fail)));
				}
				if (task.desc) {
					detailParts.push(React.createElement("div", { key: "desc", className: "eso-tb-detail-desc" }, task.desc));
				}
				if (task.dep.length > 0) {
					detailParts.push(React.createElement("div", { key: "dep", className: "eso-tb-detail-deps" },
						task.dep.map(function (depId) {
							var depTask = boardTasks[depId];
							var depBlocked = depTask != null && depTask.status !== "done";
							var text;
							if (depTask == null) text = depId + " · " + t("tb.status.unknown");
							else if (depBlocked) text = format(t("tb.waiting"), { taskId: depTask.id, owner: depTask.owner || "-", status: statusName(depTask.status) });
							else text = depId + " · " + statusName(depTask.status);
							return React.createElement("div", { key: depId, className: "eso-tb-dep-row" },
								React.createElement("span", { className: "eso-tb-dep-dot", "data-ok": depTask != null && !depBlocked ? "" : undefined }),
								React.createElement("span", null, text),
								depBlocked ? React.createElement("span", { className: "eso-tb-dep-blocked" }, t("tb.blocked")) : null);
						})));
				}
				detailParts.push(React.createElement("button", {
					key: "copy", type: "button", className: "eso-tb-copy",
					onClick: function () { copyTaskId(task.id); }
				}, copiedId === task.id ? t("tb.copied") : t("tb.copyId")));
				if (task.summary) {
					detailParts.push(React.createElement("div", { key: "summary", className: "eso-tb-detail-summary" },
						React.createElement("span", { className: "eso-tb-detail-tag" }, t("tb.detail.summary")),
						React.createElement("span", { className: "eso-tb-detail-text" }, task.summary)));
				}
				children.push(React.createElement("div", { key: "detailwrap", className: "eso-tb-detail-wrap" },
					React.createElement("div", { className: "eso-tb-detail-inner" },
						React.createElement("div", {
							className: "eso-tb-card-detail",
							role: "region",
							id: detailId,
							"aria-labelledby": headId,
							"aria-hidden": expanded ? undefined : "true",
							onKeyDown: function (event) { if (event.key === "Escape") { setExpandedId(null); focusHead(task.id); } }
						}, detailParts))));
				return React.createElement("div", {
					key: task.id + "@" + task.status,
					className: "eso-tb-card",
					"data-task-id": task.id,
					"data-status": task.status,
					"data-expanded": expanded ? "" : undefined,
					"data-highlight": highlightId === task.id ? "" : undefined
				}, children);
			}

			function renderLane(name) {
				var tasks = filteredLanes[name];
				var count = tasks.length;
				var laneTotal = lanes[name].length;
				if (!isWide && name === "attention" && count === 0) return null; // 窄模式空「需要注意」隐藏
				var blockedInLane = 0;
				if (name === "todo") {
					tasks.forEach(function (task) { if ((boardBadges.blocked[task.id] || []).length > 0) blockedInLane += 1; });
				}
				var head = React.createElement("div", { className: "eso-tb-lane-head", key: "head" },
					React.createElement("span", { className: "eso-tb-lane-dot", "data-lane": name }),
					React.createElement("span", { className: "eso-tb-lane-name" }, t(TB_LANE_META[name].label)),
					// 过滤生效时泳道头计数 n/m（spec v2 §6）
					React.createElement("span", { className: "eso-tb-lane-count" }, filtersActive ? count + "/" + laneTotal : String(count)),
					blockedInLane > 0 ? React.createElement("span", { className: "eso-tb-lane-blocked" }, "· " + format(t("tb.blocked.n"), { n: blockedInLane })) : null,
					name === "done" && laneTotal >= 3 ? React.createElement("button", {
						type: "button",
						className: "eso-tb-lane-fold",
						"data-collapsed": doneFolded ? "" : undefined,
						"aria-expanded": doneFolded ? "false" : "true",
						"aria-label": t("tb.lane.fold"),
						title: t("tb.lane.fold"),
						onClick: toggleDoneFold
					}, TB_ICONS.chevron(12)) : null
				);
				var folded = name === "done" && doneFolded;
				var shownTasks = folded ? [] : tasks;
				// P1-2 回炉（R2/E6）：空态占位仅在真实 0 任务时出现——done 泳道按未过滤计数判定，
				// 折叠态（shownTasks 置空）一律不渲染占位，避免「无任务」与泳道头计数（如 9）自相矛盾
				var laneTrulyEmpty = name === "done" ? lanes[name].length === 0 : tasks.length === 0;
				var body;
				if (shownTasks.length > 0) {
					body = React.createElement("div", { className: "eso-tb-lane-cards", key: "cards" }, shownTasks.map(renderCard));
				} else if (folded) {
					// 折叠态：泳道头常显（计数 + 折叠按钮），折叠区不渲染卡片也不渲染占位
					body = null;
				} else if (isWide && laneTrulyEmpty) {
					// R2（方向 C）：宽档真实空泳道渲染泳道头 + 居中弱文字占位；窄档只留泳道头
					body = React.createElement("div", { className: "eso-tb-lane-empty", key: "empty" }, t("tb.lane.empty"));
				} else {
					body = null;
				}
				return React.createElement("section", { className: "eso-tb-lane", "data-lane": name, key: name }, [head, body]);
			}

			function renderCandidates(candidates) {
				return React.createElement("div", { className: "eso-tb-candidates" },
					(candidates || []).map(function (candidate) {
						return React.createElement("div", { key: candidate.name, className: "eso-tb-candidate" },
							TB_ICONS.file(12),
							React.createElement("span", null, candidate.name),
							candidate.fromChat ? React.createElement("span", { "data-chat": "" }, t("tb.empty.ambiguous.chat")) : null,
							candidate.mtime != null ? React.createElement("time", null, String(candidate.mtime)) : null);
					}));
			}

			function renderStructuralEmpty(kind, candidates) {
				var children;
				if (kind === "ambiguous") {
					children = [
						TB_ICONS.box(16),
						React.createElement("span", { key: "title", className: "eso-tb-empty-title" }, t("tb.empty.ambiguous.title")),
						React.createElement("span", { key: "body", className: "eso-tb-empty-body" }, t("tb.empty.ambiguous.body")),
						React.createElement("div", { key: "list" }, renderCandidates(candidates)),
						React.createElement("button", { key: "retry", type: "button", className: "eso-tb-linklike", onClick: redetect }, t("tb.redetect"))
					];
				} else if (kind === "broken") {
					children = [
						TB_ICONS.warn(16),
						React.createElement("span", { key: "title", className: "eso-tb-empty-title" }, t("tb.empty.broken.title")),
						React.createElement("span", { key: "body", className: "eso-tb-empty-body" }, t("tb.empty.broken.body")),
						React.createElement("button", { key: "retry", type: "button", className: "eso-tb-linklike", onClick: redetect }, t("tb.redetect"))
					];
				} else { // none：无板指引空态（空态三件套之一）
					children = [
						TB_ICONS.box(16),
						React.createElement("span", { key: "title", className: "eso-tb-empty-title" }, t("tb.empty.noBoard.title")),
						React.createElement("span", { key: "body", className: "eso-tb-empty-body" }, t("tb.empty.noBoard.body")),
						React.createElement("button", {
							key: "guide", type: "button", className: "eso-tb-linklike",
							"aria-expanded": helpOpen ? "true" : "false",
							onClick: function () { setHelpOpen(!helpOpen); }
						}, t("tb.empty.noBoard.guide")),
						helpOpen ? React.createElement("span", { key: "help", className: "eso-tb-help" }, t("tb.help.body")) : null,
						React.createElement("button", { key: "retry", type: "button", className: "eso-tb-linklike", onClick: redetect }, t("tb.redetect"))
					];
				}
				return React.createElement("div", { className: "eso-tb-board" },
					React.createElement("div", { className: "eso-tb-empty" }, children));
			}

			// —— 工具条
			var toolbarChildren = [
				state.phase === "loading"
					? React.createElement("span", { key: "titleskel", className: "eso-tb-title-skeleton" })
					: React.createElement("span", { key: "title", className: "eso-tb-title" }, t("tb.title"))
			];
			if (boardData && boardData.revision != null) {
				toolbarChildren.push(React.createElement("span", { key: "rev", className: "eso-tb-rev" }, "r" + boardData.revision));
			}
			if (watchOn && autoRefresh) {
				toolbarChildren.push(React.createElement("span", { key: "watch", className: "eso-tb-watch" }));
			}
			toolbarChildren.push(React.createElement("span", { key: "spacer", className: "eso-tb-toolbar-spacer" }));
			toolbarChildren.push(React.createElement("button", {
				key: "autoswitch", type: "button", className: "eso-tb-switch", role: "switch",
				"aria-checked": autoRefresh ? "true" : "false",
				"aria-label": t("tb.autorefresh"),
				title: t("tb.autorefresh"),
				onClick: function () { setAutoRefresh(!autoRefresh); }
			}));
			toolbarChildren.push(React.createElement("button", {
				key: "refresh", type: "button", className: "eso-tb-iconbtn",
				"aria-label": t("tb.refresh"),
				title: state.loadedAt ? format(t("tb.refresh.at"), { time: formatClock(state.loadedAt) }) : t("tb.refresh"),
				onClick: manualRefresh
			}, TB_ICONS.refresh(14)));
			if (showFilterButton) {
				toolbarChildren.push(React.createElement("button", {
					key: "filter", type: "button", className: "eso-tb-iconbtn",
					"data-eso-tb-filter": "",
					"data-active": filtersOpen || filtersActive ? "" : undefined,
					"aria-label": t("tb.filter"),
					"aria-expanded": filtersOpen ? "true" : "false",
					title: t("tb.filter"),
					onClick: function () { setFiltersOpen(!filtersOpen); }
				}, TB_ICONS.filter(14)));
			}
			var toolbar = React.createElement("div", { className: "eso-tb-toolbar" }, toolbarChildren);

			// —— 摘要条
			var summaryBar = null;
			if (boardData && taskCount > 0) {
				var doneCount = lanes.done.length;
				var attentionCount = lanes.attention.length;
				var runningCount = lanes.running.length;
				var summaryChildren = [
					React.createElement("span", { key: "progress", className: "eso-tb-progress" },
						React.createElement("i", { style: { width: Math.round(doneCount / taskCount * 100) + "%" } })),
					doneCount > 0 ? React.createElement("span", { key: "cdone", className: "eso-tb-count" },
						React.createElement("span", { className: "eso-tb-count-dot", "data-st": "done" }), String(doneCount)) : null,
					runningCount > 0 ? React.createElement("span", { key: "crun", className: "eso-tb-count" },
						React.createElement("span", { className: "eso-tb-count-dot", "data-st": "running" }), String(runningCount)) : null,
					attentionCount > 0 ? React.createElement("span", { key: "catt", className: "eso-tb-count" },
						React.createElement("span", { className: "eso-tb-count-dot", "data-st": "escalated" }), String(attentionCount)) : null,
					// 全板完成尾巴（spec v2 §4.2：摘要条补全完成语）
					doneCount === taskCount ? React.createElement("span", { key: "hint", className: "eso-tb-complete-hint" }, t("tb.complete.title")) : null
				];
				var minutes = state.loadedAt ? Math.max(0, Math.round((Date.now() - state.loadedAt) / 60000)) : null;
				var agoText = minutes == null ? "" : (minutes < 1 ? t("tb.updatedJust") : format(t("tb.updatedAgo"), { n: minutes }));
				if (agoText) summaryChildren.push(React.createElement("span", { key: "ago", className: "eso-tb-stalehint" }, agoText));
				if (!autoRefresh) {
					summaryChildren.push(React.createElement("span", { key: "watchoff", className: "eso-tb-watchoff", title: t("tb.autorefresh.off") }, TB_ICONS.refresh(12)));
				}
				summaryBar = React.createElement("div", { className: "eso-tb-summary" }, summaryChildren);
			}

			// —— 刷新失败内联条（有旧数据时）
			var noteStrip = null;
			if (note && note.kind === "error" && boardData) {
				noteStrip = React.createElement("div", { className: "eso-tb-errorstrip", title: note.message || "" },
					React.createElement("i", null),
					React.createElement("span", null, t("tb.error.stale")),
					React.createElement("time", null, formatClock(note.at)),
					React.createElement("button", { type: "button", className: "eso-tb-reset", onClick: manualRefresh }, t("tb.error.retry")));
			}

			// —— 过滤行（任务 ≥8 且展开筛选时）
			var filterRow = null;
			if (filtersOpen && boardData) {
				var chips = [];
				Object.keys(TB_STATUS_LANES).forEach(function (status) {
					var count = statusCounts[status];
					if (!count) return;
					var on = statusFilter.indexOf(status) >= 0;
					chips.push(React.createElement("button", {
						key: status, type: "button", className: "eso-tb-filter-chip", "data-kind": "status",
						"data-on": on ? "" : undefined,
						onClick: function () { toggleStatusFilter(status); }
					},
						React.createElement("span", { className: "eso-tb-filter-dot", "data-st": status }),
						React.createElement("span", null, statusName(status)),
						React.createElement("span", { className: "eso-tb-filter-count" }, String(count))));
				});
				chips.push(React.createElement("button", {
					key: "blocked", type: "button", className: "eso-tb-filter-chip", "data-kind": "blocked",
					"data-on": blockedOnly ? "" : undefined,
					onClick: toggleBlockedOnly
				}, TB_ICONS.warn(12), React.createElement("span", null, t("tb.filter.blockedOnly"))));
				if (ownerNames.length >= 3) {
					ownerNames.forEach(function (owner) {
						chips.push(React.createElement("button", {
							key: "owner:" + owner, type: "button", className: "eso-tb-filter-chip", "data-kind": "owner",
							"data-on": ownerFilter === owner ? "" : undefined,
							onClick: function () { toggleOwnerFilter(owner); }
						}, React.createElement("span", null, owner)));
					});
				}
				if (filtersActive) {
					chips.push(React.createElement("button", { key: "reset", type: "button", className: "eso-tb-reset", onClick: resetFilters }, t("tb.filter.reset")));
				}
				filterRow = React.createElement("div", { className: "eso-tb-filters" }, chips);
			}

			// —— 板区（三态都在板区内部，工具条永不消失）
			var boardArea;
			if (state.phase === "loading") {
				boardArea = React.createElement("div", { className: "eso-tb-board" },
					[0, 1, 2].map(function (index) {
						return React.createElement("div", { key: index, className: "eso-tb-skeleton" }, React.createElement("i", null), React.createElement("i", null));
					}));
			} else if (state.phase === "error") {
				boardArea = React.createElement("div", { className: "eso-tb-board" },
					React.createElement("div", { className: "eso-tb-empty" },
						React.createElement("span", { className: "eso-tb-error-dot" }),
						React.createElement("span", { className: "eso-tb-empty-title" }, t("tb.error.title")),
						state.message ? React.createElement("span", { className: "eso-tb-empty-body eso-tb-truncate", title: state.message }, state.message) : null,
						React.createElement("button", { type: "button", className: "eso-tb-linklike", onClick: redetect }, t("tb.error.retry"))));
			} else if (state.boardKind !== "ok") {
				boardArea = renderStructuralEmpty(state.boardKind, state.candidates);
			} else if (taskCount === 0) {
				boardArea = React.createElement("div", { className: "eso-tb-board" },
					React.createElement("div", { className: "eso-tb-empty" },
						TB_ICONS.box(16),
						React.createElement("span", { className: "eso-tb-empty-title" }, t("tb.empty.board.title")),
						React.createElement("span", { className: "eso-tb-empty-body" }, t("tb.empty.board.body")),
						React.createElement("button", { type: "button", className: "eso-tb-linklike", onClick: redetect }, t("tb.redetect"))));
			} else if (!anyVisible && filtersActive && !isWide) {
				// 过滤空态仅窄模式（宽模式泳道保留计数 0，不出空态）
				boardArea = React.createElement("div", { className: "eso-tb-board" },
					React.createElement("div", { className: "eso-tb-empty" },
						React.createElement("span", { className: "eso-tb-empty-title" }, t("tb.filter.empty.title")),
						React.createElement("button", { type: "button", className: "eso-tb-linklike", onClick: resetFilters }, t("tb.filter.clear"))));
			} else {
				var allDone = lanes.done.length === taskCount;
				boardArea = React.createElement("div", {
					className: "eso-tb-board", ref: scrollRef,
					onScroll: function (event) { uiScrollRef.current = event.currentTarget.scrollTop; }
				},
					// 完成横幅（spec v2 §4.2）：零交互、aria-live 由 live 区播报一次、重复刷新不重复播报
					allDone ? React.createElement("div", { key: "complete", className: "eso-tb-complete" },
						TB_ICONS.check(14),
						React.createElement("span", { className: "eso-tb-complete-title" }, t("tb.complete.title")),
						React.createElement("span", { className: "eso-tb-complete-count" }, format(t("tb.complete.count"), { done: lanes.done.length, total: taskCount })),
						agoText ? React.createElement("time", { className: "eso-tb-complete-ago" }, agoText) : null) : null,
					React.createElement("div", { className: "eso-tb-lanes" }, TB_LANE_ORDER.map(renderLane)));
			}

			return React.createElement("div", { className: "eso-tb-root", ref: rootRef },
				React.createElement("div", { className: "eso-tb-live", role: "status", "aria-live": "polite" }, live),
				toolbar,
				summaryBar,
				noteStrip,
				filterRow,
				boardArea);
		}

		/**
		 * 会话页头徽标（slot 'conversation.session.header.actions'）：
		 * 挂载读一次 + 30s 轮询 running 数（stat 版本比对省读），running=0 不渲染；
		 * 卸载即停。
		 */
		function TaskBoardBadge(props) {
			var sessionId = props.sessionId;
			var t = props.t;
			var io = props.tbIo;
			var openBoard = props.tbOpen;
			var badge0 = React.useState({ running: 0, open: false });
			var badge = badge0[0];
			var setBadge = badge0[1];
			React.useEffect(function () {
				if (!io || !sessionId) return undefined;
				var disposed = false;
				var timer = null;
				var lastVersion = null;
				function schedule() {
					if (!disposed) timer = setTimeout(sample, 30000);
				}
				function sample() {
					var ac = new AbortController();
					io.list(sessionId, TB_DIR, ac.signal).then(function (listResult) {
						var resolved = tbResolveBoard((unwrap(listResult) || {}).entries);
						if (resolved.kind !== "ok") {
							if (!disposed) setBadge({ running: 0, open: TB_OPEN_COUNT > 0 });
							return undefined;
						}
						var path = TB_DIR + "/" + resolved.file;
						return io.stat(sessionId, path, ac.signal).then(function (statResult) {
							var version = (unwrap(statResult) || {}).version;
							if (lastVersion != null && version === lastVersion) return undefined; // 版本未变
							lastVersion = version;
							return io.read(sessionId, path, ac.signal).then(function (readResult) {
								var parsed = tbParseBoard((unwrap(readResult) || {}).text);
								var running = parsed.ok ? tbCountRunning(parsed.board.tasks) : 0;
								if (!disposed) setBadge({ running: running, open: TB_OPEN_COUNT > 0 });
								return undefined;
							});
						});
					}).catch(function () { /* 静默：下一轮重试 */ }).then(schedule);
				}
				sample();
				return function () {
					disposed = true;
					if (timer) clearTimeout(timer);
				};
			}, [sessionId, io]);
			if (!(badge.running > 0)) return null; // running=0 不显示
			return React.createElement("button", {
				type: "button",
				className: "eso-tb-hbtn",
				"data-open": badge.open ? "" : undefined,
				title: t("tb.title"),
				"aria-label": format(t("tb.badge.aria"), { n: badge.running }),
				onClick: function () { if (typeof openBoard === "function") openBoard(); }
			}, TB_ICONS.board(16), React.createElement("span", { className: "eso-tb-hbadge" }, badge.running > 99 ? "99+" : String(badge.running)));
		}
		//#endregion

		//#region 入口
		/** 宿主客户端服务依赖：slots（面板注册）、locale（双语词条）、remote（Typert 通道）。 */
		var inject = ["slots", "locale", "remote"];

		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（对照先例：只回收 Remote 挂载；
		 *          样式/词条/slot 注册由宿主 ctx.effect 与 slot 生命周期回收）。
		 */
		async function apply(ctx) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.textContent = CSS + "\n" + TB_CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "expert-sources: style");

			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "expert-sources: dictionaries");
			var t = ctx.locale.bind(NS);

			// namespace 是独立 Cordis 服务：必须挂载后 ctx.get() 获取，
			// 直接读 ctx.remote.expertSources 会要求预先注入并死锁（先例同款注释）。
			var disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			var remote = ctx.get("remote." + REMOTE_NS);
			if (remote === undefined) throw new Error("expert-sources Remote 挂载后不可用");

			ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register(
				{ name: "plugins.bundle.config", key: "dsh-expert-orchestrator", locale: NS },
				function (props) { if (props && props.view === "summary") return t("settings.desc"); return React.createElement(ExpertSourcesSettings, Object.assign({}, props, { remote: remote })); },
			); });

			// —— 任务板可视化（T1）：能力探测，服务缺失 console.info 跳过（fail-open，不影响既有面板）。
			// sidebarRightTabs / sidebarRight / workspaceFiles 刻意不进顶层 inject：
			// cordis inject 是硬依赖（缺 impl 服务永不激活），无 sidebar-right 能力的宿主上会让插件整体拒载。
			// 根因（rc.3 只读核实，2.11.2/c48db73 无效的原因）：扁平服务键 "remote.workspaceFiles" 由
			// dsh-api-gateway createNamespace 注册（super(ctx, "remote."+namespace)），ctx.remote.workspaceFiles
			// 属性访问经 cordis traceable proxy 借 reflect.props["remote.<ns>"] 解析到同一服务——两条路都只在
			// dsh-api-remotes 逐个 await $mount 完成后才存在；而本插件顶层 inject 只含 "remote"（gateway
			// 构造即就绪），apply 同步读取时挂载未完成，读哪条路都是 undefined。修复：整块移入
			// ctx.inject 内层插件（声明的服务就绪才激活，永不就绪恒 pending=fail-open 保持），与宿主
			// 规范时序对齐（先例 dsh-client-ui-sidebar-files）。sidebarRight 不进依赖：仅点击时经 ctx.get 探测。
			var tbOpenTaskboard = function () {
				var sidebarRight = tbService(ctx, "sidebarRight");
				if (!sidebarRight || typeof sidebarRight.openTab !== "function") {
					console.info("[dsh-expert-orchestrator] sidebarRight 能力不可用，无法打开任务板 tab（fail-open）");
					return;
				}
				try { sidebarRight.openTab(TB_TAB_KIND); } catch (error) {
					console.info("[dsh-expert-orchestrator] 打开任务板 tab 失败:", messageOf(error));
				}
			};
			ctx.inject(["remote.workspaceFiles", "sidebarRightTabs"], function taskboardServices(tbCtx) {
				var workspaceFiles = tbCtx.remote.workspaceFiles;
				var tbIo = null;
				if (workspaceFiles && typeof workspaceFiles.list === "function" && typeof workspaceFiles.read === "function"
					&& typeof workspaceFiles.stat === "function" && typeof workspaceFiles.changes === "function") {
					tbIo = {
						list: function (sid, path, signal) { return workspaceFiles.list(sid, path, signal); },
						read: function (sid, path, signal) { return workspaceFiles.read(sid, path, {}, signal); },
						stat: function (sid, path, signal) { return workspaceFiles.stat(sid, path, signal); },
						changes: function (sid, path, signal) { return workspaceFiles.changes(sid, path, signal); },
						$stream: tbCtx.remote && typeof tbCtx.remote.$stream === "function" ? tbCtx.remote.$stream.bind(tbCtx.remote) : null
					};
				} else {
					console.info("[dsh-expert-orchestrator] workspaceFiles Remote 不可用，任务板可视化未启用（fail-open）");
				}
				if (tbIo) {
					tbCtx.effect(function () {
						// M1 阶段一：注册 tab 类型（patterns 指向板目录资源；guide 入口条目）。
						var sidebarRightTabs = tbService(tbCtx, "sidebarRightTabs");
						if (!sidebarRightTabs || typeof sidebarRightTabs.register !== "function") {
							console.info("[dsh-expert-orchestrator] sidebarRightTabs 能力不可用，任务板 tab 未注册（fail-open）");
							return undefined;
						}
						var disposeTabs = sidebarRightTabs.register({
							id: TB_TAB_ID,
							kind: TB_TAB_KIND,
							patterns: ["dsh-resource://file/**.expert-taskboards/**"],
							priority: "extension",
							title: function () { return t("tb.title"); },
							guide: [{
								id: "taskboard",
								order: 10,
								title: function () { return t("tb.title"); },
								description: function () { return t("tb.guide.desc"); }
							}]
						});
						// M1 阶段二：看板正文进 keyed slot（defer 注册，sidebar-right 自身同款两阶段范式）。
						var disposeBody = tbCtx.slots.inject("sidebar.right.pane.tab", function () {
							return tbCtx.slots.register(
								{ name: "sidebar.right.pane.tab", key: TB_TAB_ID, locale: NS, inject: function () { return { tbIo: tbIo }; } },
								TaskBoardBody);
						});
						return function () { disposeBody(); disposeTabs(); };
					}, "taskboard: sidebar-right tab");

					// M3 页头徽标：slot 'conversation.session.header.actions'（先例 dsh-client-ui-jobs）。
					tbCtx.slots.inject("conversation.session.header.actions", function () {
						return tbCtx.slots.register(
							{
								name: "conversation.session.header.actions",
								id: "taskboard-badge",
								order: 30,
								locale: NS,
								inject: function () { return { tbIo: tbIo, tbOpen: tbOpenTaskboard }; }
							},
							TaskBoardBadge);
					});
				}
			});

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.TYPERT_REMOTE = TYPERT_REMOTE;
		exports.EXPERT_SOURCES_DESCRIPTORS = EXPERT_SOURCES_DESCRIPTORS;
		exports.taskboard = TASKBOARD_EXPORTS;

		return module.exports;
	}
});
