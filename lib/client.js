/**
 * dsh-expert-orchestrator — client bundle（专家来源设置面板）
 *
 * 宿主装载契约（对照 dsh-client-modules 校验与 MichengAI/dsh-agency-agents 先例）：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 限平台冻结模块表（此处仅 require react）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({name,id,order,label,locale,icon}, render))`。
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
		var SLOT_ID = "expert-sources";
		var REMOTE_NS = "expertSources";
		/** 宿主内置来源 id：不可停用、不可删除。 */
		var BUILTIN_SOURCE_ID = "bundled-core";
		/** legacy 迁移冻结来源：host 侧拒删（随包迁移数据），UI 隐藏删除按钮。 */
		var LEGACY_SOURCE_ID = "legacy-adapted";
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
			"settings.nav": "dsh-expert-orchestrator",
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
		};
		var en = {
			"settings.nav": "dsh-expert-orchestrator",
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

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 eso-）
		var CSS = [
			".eso-panel{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:1.5}",
			".eso-title{font-size:16px;font-weight:600;margin:0}",
			".eso-desc{opacity:.72;margin:4px 0 0}",
			".eso-toolbar{display:flex;align-items:center;gap:8px}",
			".eso-spacer{flex:1}",
			".eso-error{border:1px solid #e5484d;background:rgba(229,72,77,.08);color:#e5484d;border-radius:8px;padding:8px 12px}",
			".eso-alert[role=alert]{white-space:pre-wrap}",
			".eso-notice{opacity:.85;min-height:1em}",
			".eso-conflicts{border:1px solid rgba(229,72,77,.45);border-radius:8px;padding:8px 12px}",
			".eso-conflicts-title{font-weight:600;color:#e5484d;margin:0 0 4px}",
			".eso-conflicts ul{margin:4px 0 0;padding-left:18px}",
			".eso-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
			".eso-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:10px 12px}",
			".eso-row-main{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;min-width:260px;flex:2}",
			".eso-name{font-weight:600}",
			".eso-badge{font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:999px;padding:0 8px;opacity:.8}",
			".eso-link{color:inherit;text-decoration:underline;text-underline-offset:2px;opacity:.85}",
			".eso-meta{opacity:.72;font-size:12px}",
			".eso-status{font-size:12px;min-width:140px;flex:1}",
			".eso-status.red{color:#e5484d;font-weight:600}",
			".eso-status-detail{display:block;opacity:.8}",
			".eso-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
			".eso-btn{cursor:pointer;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;padding:4px 10px}",
			".eso-btn:hover:not(:disabled){border-color:currentColor}",
			".eso-btn:disabled{opacity:.45;cursor:not-allowed}",
			".eso-btn.danger{border-color:#e5484d;color:#e5484d}",
			".eso-toggle{display:inline-flex;align-items:center;gap:4px}",
			".eso-section{display:flex;flex-direction:column;gap:6px;border-top:1px solid rgba(128,128,128,.2);padding-top:12px}",
			".eso-section-title{font-weight:600;margin:0}",
			".eso-subtitle{opacity:.72;font-size:12px;font-weight:400;margin-left:8px}",
			".eso-badge.rec,.eso-badge.rep{border-color:currentColor;opacity:1;font-weight:600}",
			".eso-dedup{border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:6px}",
			".eso-dedup-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".eso-dedup-member{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".eso-dedup-member.shadowed{opacity:.55}",
			".eso-dedup-file{opacity:.72;font-size:12px;word-break:break-all}",
			".eso-hint{opacity:.72;font-size:12px;margin:0}",
			".eso-textarea,.eso-input{width:100%;box-sizing:border-box;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;padding:6px 8px;font:inherit}",
			".eso-textarea{min-height:72px;resize:vertical}",
			".eso-add{display:flex;gap:8px}",
			".eso-modal-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:16px}",
			".eso-modal{max-width:440px;width:100%;border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.35);background:#fff;color:#1f2328;background:Canvas;color:CanvasText}",
			".eso-modal-title{font-size:15px;font-weight:600;margin:0 0 8px}",
			".eso-modal-body{margin:0 0 14px}",
			".eso-modal-actions{display:flex;justify-content:flex-end;gap:8px}",
			".eso-modal-list{max-height:180px;overflow:auto;margin:0 0 14px;padding-left:18px;font-size:12px;word-break:break-all}",
			".eso-form{display:flex;flex-direction:column;gap:8px}",
			".eso-form-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".eso-form-label{font-size:12px;opacity:.8;min-width:140px}",
			".eso-files{list-style:none;margin:4px 0 0;padding:0 0 0 14px;display:flex;flex-direction:column;gap:4px;border-left:2px solid rgba(128,128,128,.2)}",
			".eso-file-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px dashed rgba(128,128,128,.2);padding:4px 0}",
			".eso-file-row.disabled{opacity:.5}",
		].join("\n");
		//#endregion

		//#region 工具
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
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
		//#endregion

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
			var expandedSourceState = React.useState(null);
			var expandedSourceId = expandedSourceState[0];
			var setExpandedSourceId = expandedSourceState[1];
			var copyPickState = React.useState(null);
			var copyPick = copyPickState[0];
			var setCopyPick = copyPickState[1];

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
					setError(messageOf(cause));
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
				return React.createElement("div", { className: "eso-panel" },
					React.createElement("p", { className: "eso-hint" }, t("settings.loading")),
					error === null ? null : React.createElement("div", { className: "eso-error", role: "alert" }, format(t("status.error"), {}) + "：" + error));
			}

			var sources = snapshot.sources;
			var statusLabel = function (source) {
				var key = "status." + source.status;
				return t(key);
			};
			var statusClass = function (source) {
				return source.status === "verifyFailed" || source.status === "scanRejected" || source.status === "error"
					? "eso-status red"
					: "eso-status";
			};

			/**
			 * T4 推荐计划（按快照 recommended/recommendedNote 渲染，bundled-core 不动）：
			 * download=推荐来源未下载；enableOnly=已下载未启用；disable=非内置、非推荐且启用中。
			 */
			var computeRecommendedPlan = function (snap) {
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
			};
			var openRecommendedPreview = function () {
				if (busy) return;
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
					setError(messageOf(cause));
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
					setError(messageOf(cause));
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

			/** M3 确认对话框（双语，alertdialog 语义）：确认=带 ackRisks:true 重发；取消=保持停用。 */
			var ackDialog = ackPending === null ? null : React.createElement("div", {
				className: "eso-modal-overlay",
				onKeyDown: function (event) {
					if (event.key !== "Escape") return;
					setAckPending(null);
					setNotice(t("sources.ackCancelled"));
				},
			}, React.createElement("div", {
				className: "eso-modal", role: "alertdialog", "aria-modal": "true",
				"aria-labelledby": "eso-ack-title", "aria-describedby": "eso-ack-body",
			},
				React.createElement("h4", { className: "eso-modal-title", id: "eso-ack-title" },
					format(t("sources.ackTitle"), { name: ackPending.name })),
				React.createElement("p", { className: "eso-modal-body", id: "eso-ack-body" }, t("sources.ackBody")),
				React.createElement("div", { className: "eso-modal-actions" },
					React.createElement("button", {
						type: "button", className: "eso-btn", autoFocus: true, disabled: busy,
						onClick: function () {
							setAckPending(null);
							setNotice(t("sources.ackCancelled"));
						},
					}, t("sources.ackCancel")),
					React.createElement("button", {
						type: "button", className: "eso-btn danger", disabled: busy,
						onClick: function () {
							var pending = ackPending;
							setAckPending(null);
							runSetEnabled(pending, true, true, t("sources.enabledDone"));
						},
					}, t("sources.ackConfirm")))));

			/**
			 * 下载扫描确认对话框（双语，alertdialog 语义）：
			 * 列命中明细，明示「已过 sha256 验签；内容为第三方 persona，自动扫描非安全审查」；
			 * 确认=带 ackScan:true 重发；取消=中止本次安装。
			 */
			var scanDialog = scanPending === null ? null : (function () {
				var findings = Array.isArray(scanPending.findings) ? scanPending.findings : [];
				var shown = findings.slice(0, 10);
				return React.createElement("div", {
					className: "eso-modal-overlay",
					onKeyDown: function (event) {
						if (event.key !== "Escape") return;
						setScanPending(null);
						setNotice(t("sources.scanCancelled"));
					},
				}, React.createElement("div", {
					className: "eso-modal", role: "alertdialog", "aria-modal": "true",
					"aria-labelledby": "eso-scan-title", "aria-describedby": "eso-scan-body",
				},
					React.createElement("h4", { className: "eso-modal-title", id: "eso-scan-title" },
						format(t("sources.scanTitle"), { name: scanPending.source.name })),
					React.createElement("p", { className: "eso-modal-body", id: "eso-scan-body" }, t("sources.scanBody")),
					findings.length === 0 ? null : React.createElement("div", null,
						React.createElement("p", { className: "eso-hint" }, t("sources.scanFindingsTitle")),
						React.createElement("ul", { className: "eso-modal-list" },
							shown.map(function (finding, index) {
								return React.createElement("li", { key: index }, findingText(finding));
							}),
							findings.length > shown.length ? React.createElement("li", null,
								format(t("sources.scanMore"), { count: findings.length - shown.length })) : null)),
					React.createElement("div", { className: "eso-modal-actions" },
						React.createElement("button", {
							type: "button", className: "eso-btn", autoFocus: true, disabled: busy,
							onClick: function () {
								setScanPending(null);
								setNotice(t("sources.scanCancelled"));
							},
						}, t("sources.scanCancel")),
						React.createElement("button", {
							type: "button", className: "eso-btn danger", disabled: busy,
							onClick: function () {
								var pending = scanPending;
								setScanPending(null);
								runFetch(pending.source, pending.channel, pending.kind, true);
							},
						}, t("sources.scanConfirm")))));
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
					React.createElement("p", { className: "eso-hint" }, title),
					React.createElement("ul", { className: "eso-modal-list" },
						list.map(function (source) {
							return React.createElement("li", { key: source.id }, source.name);
						})));
			};
			var recDialog = recPending === null ? null : (function () {
				var plan = recPending;
				var empty = plan.download.length === 0 && plan.enableOnly.length === 0 && plan.disable.length === 0;
				return React.createElement("div", {
					className: "eso-modal-overlay",
					onKeyDown: function (event) {
						if (event.key !== "Escape") return;
						setRecPending(null);
					},
				}, React.createElement("div", {
					className: "eso-modal", role: "alertdialog", "aria-modal": "true",
					"aria-labelledby": "eso-rec-title", "aria-describedby": "eso-rec-body",
				},
					React.createElement("h4", { className: "eso-modal-title", id: "eso-rec-title" }, t("rec.previewTitle")),
					React.createElement("p", { className: "eso-modal-body", id: "eso-rec-body" }, t("rec.scanHint")),
					empty ? React.createElement("p", { className: "eso-modal-body" }, t("rec.noChanges")) : React.createElement("div", null,
						recListBlock(t("rec.willDownload"), plan.download),
						recListBlock(t("rec.willEnableOnly"), plan.enableOnly),
						recListBlock(t("rec.willDisable"), plan.disable)),
					plan.note === null ? null : React.createElement("p", { className: "eso-hint" }, t("rec.noteLabel") + " " + plan.note),
					React.createElement("div", { className: "eso-modal-actions" },
						React.createElement("button", {
							type: "button", className: "eso-btn", autoFocus: true, disabled: busy,
							onClick: function () { setRecPending(null); },
						}, t("rec.cancel")),
						React.createElement("button", {
							type: "button", className: "eso-btn danger", disabled: busy || empty,
							onClick: function () { setRecPending(null); runApplyRecommended(plan); },
						}, t("rec.confirm")))));
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
					setError(messageOf(cause));
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
				// v2.2 行级专家清单（host 未投递时缺省空数组）与展开状态。
				var fileList = Array.isArray(source.files) ? source.files : [];
				var expanded = expandedSourceId === source.id;
				// 行内扫描命中/跳过符号链接摘要：行级字段优先，快照顶层兜底（host 投递形态兼容）。
				var rowScanFindings = Array.isArray(source.scanFindings) && source.scanFindings.length > 0
					? source.scanFindings
					: (Array.isArray(snapshot.scanFindings) && snapshot.scanFindings.length > 0 ? snapshot.scanFindings : []);
				var rowSkippedSymlinks = Array.isArray(source.skippedSymlinks) && source.skippedSymlinks.length > 0
					? source.skippedSymlinks
					: (Array.isArray(snapshot.skippedSymlinks) && snapshot.skippedSymlinks.length > 0 ? snapshot.skippedSymlinks : []);
				return React.createElement("li", { key: source.id, className: "eso-row" },
					React.createElement("div", { className: "eso-row-main" },
						React.createElement("span", { className: "eso-name" }, source.name),
						locked ? React.createElement("span", { className: "eso-badge", title: t("sources.builtinHint") }, t("sources.builtin")) : null,
						source.recommended === true ? React.createElement("span", { className: "eso-badge rec" }, t("rec.recommended")) : null,
						frozen ? React.createElement("span", { className: "eso-meta", title: t("sources.legacyHint") }, t("sources.legacyHint")) : null,
						isCustomPseudo ? React.createElement("span", { className: "eso-badge rec" }, t("custom.badge")) : null,
						source.upstream === "" ? null : React.createElement("a", {
							className: "eso-link", href: source.upstream, target: "_blank", rel: "noreferrer",
						}, source.upstream),
						React.createElement("span", { className: "eso-meta" }, t("sources.license") + "：" + (source.license === "" ? "—" : source.license)),
						React.createElement("span", { className: "eso-meta" }, t("sources.version") + "：" + (source.installedVersion === null ? t("sources.notInstalled") : source.installedVersion))),
					React.createElement("div", { className: statusClass(source), role: "status" },
						statusLabel(source),
						source.statusDetail === null ? null : React.createElement("span", { className: "eso-status-detail" }, source.statusDetail),
						rowScanFindings.length === 0 ? null : React.createElement("span", {
							className: "eso-status-detail",
							title: rowScanFindings.slice(0, 10).map(findingText).join("\n"),
						}, format(t("sources.scanHits"), { count: rowScanFindings.length })),
						rowSkippedSymlinks.length === 0 ? null : React.createElement("span", {
							className: "eso-status-detail",
							title: rowSkippedSymlinks.slice(0, 10).join("\n"),
						}, format(t("sources.skippedSymlinks"), { count: rowSkippedSymlinks.length }))),
					React.createElement("div", { className: "eso-actions" },
						// T2 反馈④：启用控制只标『启用』（选中=启用），去掉『停用』歧义措辞。
						// v2.2 custom 伪来源行置灰并在自定义专家区管理（host 对 custom readonly）。
						React.createElement("label", { className: "eso-toggle", title: isCustomPseudo ? t("custom.manageHint") : undefined },
							React.createElement("input", {
								type: "checkbox", checked: source.enabled, disabled: locked || downloading || isCustomPseudo,
								"aria-label": format(t("sources.toggle"), { name: source.name }),
								onChange: function () { toggleSource(source); },
							}),
							React.createElement("span", null, t("sources.enable"))),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							onClick: function () { runFetch(source, "github", "download", false); },
						}, t("sources.downloadGithub")),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							onClick: function () { runFetch(source, "cdn", "download", false); },
						}, t("sources.downloadCdn")),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							onClick: function () { runFetch(source, "cdn", "update", false); },
						}, t("sources.update")),
						isCustomPseudo ? null : React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							"aria-expanded": expanded,
							onClick: function () { setExpandedSourceId(expanded ? null : source.id); },
						}, (expanded ? "▾ " : "▸ ") + t("files.toggle") + "（" + fileList.length + "）"),
						removable ? React.createElement("button", {
							type: "button", className: "eso-btn danger", disabled: downloading,
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
					expanded && fileList.length > 0 ? React.createElement("ul", { className: "eso-files" },
						fileList.map(function (entry) {
							var effectiveEnabled = entry.enabled !== false && entry.disabled !== true;
							var greyed = isCustomPseudo;
							var badges = [];
							if (entry.disabled === true) badges.push(React.createElement("span", { key: "dis", className: "eso-status red" }, t("custom.disabledBadge")));
							if (entry.shadowed === true) badges.push(React.createElement("span", { key: "sha", className: "eso-badge" }, t("dedup.shadowed")));
							if (entry.custom === true) badges.push(React.createElement("span", { key: "cus", className: "eso-badge" }, t("custom.badge")));
							return React.createElement("li", { key: entry.file, className: "eso-file-row" + (effectiveEnabled ? "" : " disabled") },
								React.createElement("span", { className: "eso-dedup-file" }, entry.file),
								entry.name == null || entry.name === "" ? null : React.createElement("span", { className: "eso-name" }, entry.name),
								entry.title == null || entry.title === "" || entry.title === entry.name ? null : React.createElement("span", { className: "eso-meta" }, entry.title),
								badges,
								React.createElement("label", { className: "eso-toggle" },
									React.createElement("input", {
										type: "checkbox", checked: effectiveEnabled,
										disabled: greyed || downloading,
										title: greyed ? t("custom.manageHint") : undefined,
										"aria-label": entry.file,
										onChange: function () { runSetExpertEnabled(source, entry, !effectiveEnabled); },
									}),
									React.createElement("span", null, t("sources.enable"))),
								greyed ? React.createElement("span", { className: "eso-meta" }, t("custom.manageHint")) : null);
						})) : null);
			});

			var conflicts = snapshot.conflicts.map(function (conflict, index) {
				return React.createElement("li", { key: conflict.expert + ":" + index },
					format(t("conflicts.item"), { expert: conflict.expert, sources: conflict.sources.join(" / ") }));
			});

			var mirrorValid = function (list) {
				return list.every(function (prefix) { return /^https?:\/\//.test(prefix); });
			};

			return React.createElement("div", { className: "eso-panel" },
				React.createElement("div", { className: "eso-toolbar" },
					// T2 反馈①：section 主标题直接用插件名，保留一行小字副标『专家来源管理』。
					React.createElement("h3", { className: "eso-title" }, t("settings.title")),
					React.createElement("span", { className: "eso-subtitle" }, t("settings.subtitle")),
					React.createElement("span", { className: "eso-spacer" }),
					React.createElement("button", {
						type: "button", className: "eso-btn", disabled: busy,
						onClick: function () {
							mutate(function () { return remote.getSources(); }, "");
						},
					}, t("settings.reload"))),
				React.createElement("p", { className: "eso-desc" }, t("settings.desc")),
				React.createElement("section", { className: "eso-section", "aria-label": t("rec.title") },
					React.createElement("h4", { className: "eso-section-title" }, t("rec.title")),
					React.createElement("p", { className: "eso-hint" }, t("rec.desc")),
					React.createElement("div", null,
						React.createElement("button", {
							type: "button", className: "eso-btn", disabled: busy,
							onClick: function () { openRecommendedPreview(); },
						}, t("rec.apply")))),
				error === null ? null : React.createElement("div", { className: "eso-error", role: "alert" }, format(t("status.error"), {}) + "：" + error),
				conflicts.length === 0 ? null : React.createElement("section", { className: "eso-conflicts", "aria-label": t("conflicts.title") },
					React.createElement("p", { className: "eso-conflicts-title" }, t("conflicts.title")),
					React.createElement("p", null, t("conflicts.desc")),
					React.createElement("p", { className: "eso-hint" }, t("conflicts.classes")),
					React.createElement("ul", null, conflicts)),
				React.createElement("ul", { className: "eso-list", "aria-label": t("settings.subtitle") },
					rows.length === 0 ? React.createElement("li", { className: "eso-hint" }, t("sources.empty")) : rows),
				/**
				 * v2.2 自定义专家管理区（用户反馈：自定义专家管理 UI + 限额 + 复制预填）。
				 * 列表=快照 customExperts 摘要；表单编辑走 getCustom 取详情回填；
				 * 新建 slug 由 host 生成；quota n/200 满员禁用新建；customExpertsError 降级展示。
				 */
				React.createElement("section", { className: "eso-section", "aria-label": t("custom.title") },
					React.createElement("h4", { className: "eso-section-title" },
						t("custom.title"),
						React.createElement("span", { className: "eso-subtitle" },
							format(t("custom.quota"), { count: customQuota, max: CUSTOM_QUOTA_MAX }))),
					React.createElement("p", { className: "eso-hint" }, t("custom.desc")),
					customDegraded === null ? null : React.createElement("p", { className: "eso-status red", role: "alert" },
						format(t("status.error"), {}) + "：" + customDegraded),
					customForm === null ? React.createElement("div", { className: "eso-form-row" },
						React.createElement("button", {
							type: "button", className: "eso-btn",
							disabled: busy || customQuota >= CUSTOM_QUOTA_MAX,
							title: customQuota >= CUSTOM_QUOTA_MAX ? format(t("custom.limitReached"), { max: CUSTOM_QUOTA_MAX }) : undefined,
							onClick: function () {
								setCustomForm({ slug: null, name: "", description: "", prompt: "", division: "", emoji: "", enabled: true, copyFrom: null });
							},
						}, t("custom.new")),
						React.createElement("span", { className: "eso-form-label" }, t("custom.copyPick")),
						React.createElement("select", {
							className: "eso-input", style: { maxWidth: "320px" },
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
							type: "button", className: "eso-btn", disabled: busy || copyPick == null,
							onClick: function () {
								var source = sources.find(function (item) { return item.id === copyPick.sourceId; });
								var entry = source == null || Array.isArray(source.files) === false ? null
									: source.files.find(function (item) { return item.file === copyPick.file; });
								if (source == null || entry == null) { setCopyPick(null); return; }
								openCopyForm(source, entry);
							},
						}, t("custom.copy"))) : React.createElement("form", { className: "eso-form", onSubmit: function (event) { event.preventDefault(); runSubmitCustom(); } },
						customForm.slug != null && customForm.slug !== "" ? React.createElement("div", { className: "eso-form-row" },
							React.createElement("span", { className: "eso-form-label" }, t("custom.form.slug")),
							React.createElement("span", { className: "eso-meta" }, customForm.slug)) : null,
						customForm.copyFrom != null ? React.createElement("div", { className: "eso-form-row" },
							React.createElement("span", { className: "eso-meta" }, format(t("custom.copyFrom"), { origin: customForm.copyFrom })),
							customForm.loadingContent === true ? React.createElement("span", { className: "eso-meta" }, t("custom.copyLoading")) : null,
							customForm.contentFailed === true ? React.createElement("span", { className: "eso-status red" }, t("custom.copyFailed")) : null) : null,
						React.createElement("div", { className: "eso-form-row" },
							React.createElement("label", { className: "eso-form-label" }, t("custom.form.name")),
							React.createElement("input", { className: "eso-input", type: "text", value: customForm.name, maxLength: 40, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { name: event.target.value })); } })),
						React.createElement("div", { className: "eso-form-row" },
							React.createElement("label", { className: "eso-form-label" }, t("custom.form.description")),
							React.createElement("input", { className: "eso-input", type: "text", value: customForm.description, maxLength: 160, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { description: event.target.value })); } })),
						React.createElement("div", { className: "eso-form" },
							React.createElement("label", { className: "eso-form-label" }, t("custom.form.prompt")),
							React.createElement("textarea", { className: "eso-textarea", value: customForm.prompt, maxLength: 20000, rows: 8, spellCheck: false, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { prompt: event.target.value })); } })),
						React.createElement("div", { className: "eso-form-row" },
							React.createElement("label", { className: "eso-form-label" }, t("custom.form.division")),
							React.createElement("input", { className: "eso-input", type: "text", value: customForm.division, maxLength: 64, placeholder: "my-division", onChange: function (event) { setCustomForm(Object.assign({}, customForm, { division: event.target.value })); } })),
						React.createElement("div", { className: "eso-form-row" },
							React.createElement("label", { className: "eso-form-label" }, t("custom.form.emoji")),
							React.createElement("input", { className: "eso-input", type: "text", value: customForm.emoji, maxLength: 16, onChange: function (event) { setCustomForm(Object.assign({}, customForm, { emoji: event.target.value })); } })),
						React.createElement("div", { className: "eso-form-row" },
							React.createElement("label", { className: "eso-toggle" },
								React.createElement("input", {
									type: "checkbox", checked: customForm.enabled === true,
									onChange: function (event) { setCustomForm(Object.assign({}, customForm, { enabled: event.target.checked })); },
								}),
								React.createElement("span", null, t("custom.form.enabled")))),
						React.createElement("div", { className: "eso-modal-actions" },
							React.createElement("button", {
								type: "button", className: "eso-btn", disabled: busy,
								onClick: function () { setCustomForm(null); },
							}, t("custom.form.cancel")),
							React.createElement("button", { type: "submit", className: "eso-btn danger", disabled: busy }, t("custom.form.submit")))),
					customQuota >= CUSTOM_QUOTA_MAX && customForm === null ? React.createElement("p", { className: "eso-hint" }, format(t("custom.limitReached"), { max: CUSTOM_QUOTA_MAX })) : null,
					React.createElement("ul", { className: "eso-list" },
						customList.length === 0 ? React.createElement("li", { className: "eso-hint" }, t("custom.empty")) : customList.map(function (record) {
							var confirmingDelete = confirmDeleteSlug === record.slug;
							return React.createElement("li", { key: record.slug, className: "eso-row" },
								React.createElement("div", { className: "eso-row-main" },
									(record.emoji == null ? null : React.createElement("span", null, record.emoji)),
									React.createElement("span", { className: "eso-name" }, record.name),
									React.createElement("span", { className: "eso-badge" }, t("custom.badge")),
									record.division == null ? null : React.createElement("span", { className: "eso-badge" }, record.division),
									React.createElement("span", { className: "eso-meta" }, format(t("custom.promptLength"), { count: record.promptLength })),
									React.createElement("span", { className: "eso-dedup-file" }, record.slug)),
								React.createElement("div", { className: "eso-actions" },
									React.createElement("label", { className: "eso-toggle" },
										React.createElement("input", {
											type: "checkbox", checked: record.enabled === true, disabled: busy,
											"aria-label": format(t("sources.toggle"), { name: record.name }),
											onChange: function () { runToggleCustom(record); },
										}),
										React.createElement("span", null, t("sources.enable"))),
									React.createElement("button", {
										type: "button", className: "eso-btn", disabled: busy,
										onClick: function () { runEditCustom(record); },
									}, t("custom.edit")),
									confirmingDelete ? React.createElement("span", { className: "eso-meta" }, t("custom.deleteSoftHint")) : null,
									React.createElement("button", {
										type: "button", className: "eso-btn danger", disabled: busy,
										"aria-label": format(t("sources.removeToggle"), { name: record.name }),
										onClick: function () {
											if (!confirmingDelete) { setConfirmDeleteSlug(record.slug); return; }
											runDeleteCustom(record);
										},
										onBlur: function () { if (confirmDeleteSlug === record.slug) setConfirmDeleteSlug(null); },
									}, confirmingDelete ? t("custom.deleteConfirm") : t("custom.delete"))));
						})),
				/**
				 * T4 去重组展示（反馈②智能去重的 UI 面）：仅渲染快照 dedupGroups
				 * （启用来源中 >1 成员的组）。组内成员列来源标签，代表高亮『当前代表』，
				 * 非代表 shadowed 灰显；每组提供『设为代表』（setDedupChoice）与
				 * 『恢复默认』（clearDedupChoice）；rule 透出（中英对照/同名/混合）。
				 */
				(function () {
					var groups = Array.isArray(snapshot.dedupGroups) ? snapshot.dedupGroups : [];
					if (groups.length === 0) return null;
					return React.createElement("section", { className: "eso-section", "aria-label": t("dedup.title") },
						React.createElement("h4", { className: "eso-section-title" }, t("dedup.title")),
						React.createElement("p", { className: "eso-hint" }, t("dedup.desc")),
						groups.map(function (group) {
							var rep = group.representative;
							return React.createElement("div", { className: "eso-dedup", key: group.key },
								React.createElement("div", { className: "eso-dedup-head" },
									React.createElement("span", { className: "eso-badge" }, dedupRuleLabel(group.rule)),
									React.createElement("span", { className: "eso-spacer" }),
									React.createElement("button", {
										type: "button", className: "eso-btn", disabled: busy,
										onClick: function () {
											mutate(function () {
												return remote.clearDedupChoice(group.key, snapshot.revision);
											}, t("dedup.cleared"));
										},
									}, t("dedup.clearChoice"))),
								group.members.map(function (member) {
									var isRep = rep != null && member.sourceId === rep.sourceId && member.file === rep.file;
									return React.createElement("div", {
										className: "eso-dedup-member" + (isRep ? "" : " shadowed"),
										key: member.sourceId + "\u0000" + member.file,
									},
										React.createElement("span", { className: "eso-name" }, member.name != null && member.name !== "" ? member.name : member.file),
										React.createElement("span", { className: "eso-badge" }, sourceNameOf(member.sourceId)),
										member.title == null || member.title === "" || member.title === member.name ? null
											: React.createElement("span", { className: "eso-meta" }, member.title),
										React.createElement("span", { className: "eso-dedup-file" }, member.file),
										isRep ? React.createElement("span", { className: "eso-badge rep" }, t("dedup.representative"))
											: React.createElement("span", { className: "eso-badge" }, t("dedup.shadowed")),
										isRep ? null : React.createElement("button", {
											type: "button", className: "eso-btn", disabled: busy,
											"aria-label": format(t("dedup.setChoice"), { name: member.name != null && member.name !== "" ? member.name : member.file }),
											onClick: function () {
												mutate(function () {
													return remote.setDedupChoice(group.key, member.sourceId, snapshot.revision);
												}, t("dedup.done"));
											},
										}, t("dedup.setChoice")));
								}));
						}));
				})(),
				React.createElement("section", { className: "eso-section", "aria-label": t("mirrors.title") },
					React.createElement("h4", { className: "eso-section-title" }, t("mirrors.title")),
					React.createElement("p", { className: "eso-hint" }, t("mirrors.desc"), " ",
						format(t("mirrors.default"), { list: DEFAULT_MIRROR_PREFIXES.join(" → ") })),
					React.createElement("textarea", {
						className: "eso-textarea", value: mirrorText === null ? "" : mirrorText,
						onChange: function (event) { setMirrorText(event.target.value); },
						spellCheck: false,
					}),
					React.createElement("div", null,
						React.createElement("button", {
							type: "button", className: "eso-btn", disabled: busy,
							onClick: function () {
								var list = parseMirrorPrefixes(mirrorText === null ? "" : mirrorText);
								if (!mirrorValid(list)) {
									setError(t("mirrors.invalid"));
									return;
								}
								mutate(function () {
									return remote.setMirrorPrefixes(list, snapshot.revision);
								}, t("mirrors.saved"));
							},
						}, t("mirrors.save")))),
				React.createElement("section", { className: "eso-section", "aria-label": t("add.title") },
					React.createElement("h4", { className: "eso-section-title" }, t("add.title")),
					React.createElement("div", { className: "eso-add" },
						React.createElement("input", {
							className: "eso-input", type: "text", value: addUrl, placeholder: t("add.placeholder"),
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
							type: "button", className: "eso-btn", disabled: busy,
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
				recDialog,
				React.createElement("p", { className: "eso-notice", "aria-live": "polite" }, notice)));
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
				tag.textContent = CSS;
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

			ctx.slots.inject("settings.section", function () { return ctx.slots.register(
				// label 是 thunk：nav 行每次渲染读取，locale 切换后自动跟随。
				{ name: "settings.section", id: SLOT_ID, order: 17, label: function () { return t("settings.nav"); }, locale: NS, icon: "package" },
				function (props) { return React.createElement(ExpertSourcesSettings, Object.assign({}, props, { remote: remote })); },
			); });

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.TYPERT_REMOTE = TYPERT_REMOTE;
		exports.EXPERT_SOURCES_DESCRIPTORS = EXPERT_SOURCES_DESCRIPTORS;

		return module.exports;
	}
});
