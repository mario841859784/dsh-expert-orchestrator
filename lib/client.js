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
 * Remote 契约（与 docs/source-management-design.md 8 条最小接口清单第 5 条对应）：
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
		var sourcesSnapshotSchema = vObject({
			revision: vInt(0),
			sources: vArray(sourceEntrySchema),
			mirrorPrefixes: vArray(vString(0, 256)),
			conflicts: vArray(conflictEntrySchema),
			confirmRequired: vOptional(ackMarkerSchema),
			// 下载扫描确认门：最近一次下载/更新的命中明细与跳过符号链接（顶层兜底，行级优先）。
			scanFindings: vOptional(vArray(scanFindingSchema)),
			skippedSymlinks: vOptional(vArray(vString(0, 512))),
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
		function sourceMethod(method, parameters) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec("ExpertSourcesState", sourcesSnapshotSchema),
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
		];
		var TYPERT_REMOTE = { package: PLUGIN_ID, descriptors: EXPERT_SOURCES_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式）
		var zh = {
			"settings.nav": "专家来源",
			"settings.title": "专家来源",
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
			"sources.disable": "停用",
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
		};
		var en = {
			"settings.nav": "Expert Sources",
			"settings.title": "Expert Sources",
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
			"sources.disable": "Disable",
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
			var mirrorState = React.useState(null);
			var mirrorText = mirrorState[0];
			var setMirrorText = mirrorState[1];
			var addState = React.useState("");
			var addUrl = addState[0];
			var setAddUrl = addState[1];

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

			var rows = sources.map(function (source) {
				var locked = source.builtin === true;
				// legacy-adapted 以 builtin:false 上报（可停用），但 host 拒删（随包迁移冻结数据）：
				// 客户端按 id 冻结删除入口，与 host remoteRemoveSource 的拒绝逻辑保持一致。
				var frozen = source.id === LEGACY_SOURCE_ID;
				var removable = !locked && !frozen;
				var downloading = source.status === "downloading" || busy;
				var confirmingRemove = confirmId === source.id;
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
						frozen ? React.createElement("span", { className: "eso-meta", title: t("sources.legacyHint") }, t("sources.legacyHint")) : null,
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
						React.createElement("label", { className: "eso-toggle" },
							React.createElement("input", {
								type: "checkbox", checked: source.enabled, disabled: locked || downloading,
								"aria-label": format(t("sources.toggle"), { name: source.name }),
								onChange: function () { toggleSource(source); },
							}),
							React.createElement("span", null, source.enabled ? t("sources.disable") : t("sources.enable"))),
						React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							onClick: function () { runFetch(source, "github", "download", false); },
						}, t("sources.downloadGithub")),
						React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							onClick: function () { runFetch(source, "cdn", "download", false); },
						}, t("sources.downloadCdn")),
						React.createElement("button", {
							type: "button", className: "eso-btn", disabled: downloading,
							onClick: function () { runFetch(source, "cdn", "update", false); },
						}, t("sources.update")),
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
						}, confirmingRemove ? t("sources.removeConfirm") : t("sources.remove")) : null));
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
					React.createElement("h3", { className: "eso-title" }, t("settings.title")),
					React.createElement("span", { className: "eso-spacer" }),
					React.createElement("button", {
						type: "button", className: "eso-btn", disabled: busy,
						onClick: function () {
							mutate(function () { return remote.getSources(); }, "");
						},
					}, t("settings.reload"))),
				React.createElement("p", { className: "eso-desc" }, t("settings.desc")),
				error === null ? null : React.createElement("div", { className: "eso-error", role: "alert" }, format(t("status.error"), {}) + "：" + error),
				conflicts.length === 0 ? null : React.createElement("section", { className: "eso-conflicts", "aria-label": t("conflicts.title") },
					React.createElement("p", { className: "eso-conflicts-title" }, t("conflicts.title")),
					React.createElement("p", null, t("conflicts.desc")),
					React.createElement("ul", null, conflicts)),
				React.createElement("ul", { className: "eso-list", "aria-label": t("settings.title") },
					rows.length === 0 ? React.createElement("li", { className: "eso-hint" }, t("sources.empty")) : rows),
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
				React.createElement("p", { className: "eso-notice", "aria-live": "polite" }, notice));
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
