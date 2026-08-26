/**
 * WebFont SDK — 按需增量加载字体片段，无闪烁（本文件由 packages/webfont-sdk 构建，勿手改）
 *
 * 架构：核心增量引擎 + 两种注册模式
 *   - 核心：IncrementalEngine 按 fontKey 管理字符集，只请求增量；失败字符自动记忆不重试
 *   - CSS 模式（WebFont）：loadFont（轮询）/ observeFont（DOM 事件）/ loadText（手动传文本）
 *   - FontFace 模式（WebFontCanvas）：Canvas/canvas 场景，FontFace + unicodeRange 注册
 *
 * 用法：
 *   // 轮询模式
 *   WebFont.loadFont({ fontName, selector, family, interval });
 *
 *   // 事件驱动模式
 *   var obs = WebFont.observeFont({ fontName, selector, family });
 *   obs.dispose();
 *
 *   // 直接传文本模式
 *   var loader = WebFont.loadText({ fontName, text: "你好世界", family });
 *   loader.update("追加文字");
 *   loader.dispose();
 *
 *   // Canvas 模式（leafer / 原生 canvas）
 *   var face = WebFontCanvas.loadFontFace({ fontName }, function (chunk) { 在此重绘 });
 *   face.update("画布上的文字");
 *   await WebFontCanvas.ready();
 */

(function() {


//#region src/engine.ts
	function createHttpProvider(baseUrl) {
		return (fontName, text, outType) => {
			const url = `${baseUrl}/api?font=${encodeURIComponent(fontName)}&text=${encodeURIComponent(text)}&outType=${outType}`;
			return Promise.resolve({
				url,
				format: outType === "woff2" ? "woff2" : "truetype"
			});
		};
	}
	var IncrementalEngine = class {
		constructor(config = {}) {
			this.states = /* @__PURE__ */ new Map();
			this.active = 0;
			this.queue = [];
			this.flying = 0;
			this.config = {
				maxConcurrent: config.maxConcurrent ?? 4,
				provider: config.provider ?? null
			};
		}
		/** fontKey：fontName + family 唯一确定一个增量组 */
		static fontKey(fontName, family) {
			return fontName + "|" + family;
		}
		setProvider(provider) {
			this.config.provider = provider;
		}
		getState(key) {
			return this.states.get(key);
		}
		/** 获取或创建字体状态；已存在时按传入项更新 baseUrl / outType / 回调 */
		ensureState(key, fontName, options) {
			let state = this.states.get(key);
			if (!state) {
				state = {
					fontName,
					baseUrl: options.baseUrl,
					outType: options.outType,
					loadedChars: /* @__PURE__ */ new Set(),
					failedChars: /* @__PURE__ */ new Set(),
					pendingChars: /* @__PURE__ */ new Set(),
					onLoadChunk: options.onLoadChunk ?? null,
					provider: options.provider ?? null
				};
				this.states.set(key, state);
				return state;
			}
			state.baseUrl = options.baseUrl;
			state.outType = options.outType;
			if (options.onLoadChunk) state.onLoadChunk = options.onLoadChunk;
			if (options.provider !== void 0) state.provider = options.provider;
			return state;
		}
		/** 删除状态（销毁时） */
		removeState(key) {
			this.states.delete(key);
		}
		/** 是否还有在途任务（请求中或注册中，ready() 轮询用） */
		hasPending() {
			if (this.flying > 0) return true;
			for (const s of this.states.values()) if (s.pendingChars.size > 0) return true;
			return false;
		}
		/** 清除失败记录（下次遇到这些字符会重新请求） */
		retryFailed(key) {
			this.states.get(key)?.failedChars.clear();
		}
		/**
		* 提交一批文本：过滤出新字符并异步请求子集。
		* 乐观标记 pending，成功移入 loaded、失败移入 failed。
		* 超过 maxCharsPerChunk 时自动分批（uni 小程序 loadFontFace 无 unicode-range，
		* 单次需携带全量累积文本，长文本按批切分避免 URL 超限）。
		*/
		submitText(key, text, maxCharsPerChunk = Infinity) {
			const state = this.states.get(key);
			if (!state) return;
			const newChars = [];
			for (const ch of text) {
				if (state.loadedChars.has(ch) || state.pendingChars.has(ch) || state.failedChars.has(ch)) continue;
				/** 跳过控制字符 */
				if (ch.charCodeAt(0) < 32) continue;
				newChars.push(ch);
				state.pendingChars.add(ch);
			}
			if (newChars.length === 0) return;
			for (let i = 0; i < newChars.length; i += maxCharsPerChunk) {
				const batch = newChars.slice(i, i + maxCharsPerChunk);
				this.enqueue(() => this.loadChunk(state, batch));
			}
		}
		/** 执行一次子集请求 + 注册（在并发槽内完成） */
		async loadChunk(state, chars) {
			this.flying++;
			try {
				const text = chars.join("");
				const result = await (state.provider ?? this.config.provider ?? createHttpProvider(state.baseUrl))(state.fontName, text, state.outType);
				/** 注册完成后才把字符记为已加载：注册失败可走 failedChars 重试路径 */
				await state.onLoadChunk?.({
					fontName: state.fontName,
					chars,
					url: result.url,
					format: result.format
				});
				for (const ch of chars) {
					state.loadedChars.add(ch);
					state.pendingChars.delete(ch);
				}
			} catch {
				for (const ch of chars) {
					state.pendingChars.delete(ch);
					state.failedChars.add(ch);
				}
			} finally {
				this.flying--;
			}
		}
		/** 并发池：超出 maxConcurrent 的任务排队等待 */
		enqueue(fn) {
			if (this.active < this.config.maxConcurrent) this.execute(fn);
			else this.queue.push(fn);
		}
		/**
		* 执行一个任务，完成后从队列取下一个。
		* 注意：这里必须直接调用 next（fn），不能递归调用外层 run 闭包——
		* 那样会把下一个任务替换成本次任务重跑（闭包捕获），队列真身丢失
		*/
		execute(fn) {
			this.active++;
			fn().finally(() => {
				this.active--;
				const next = this.queue.shift();
				if (next) this.execute(next);
			});
		}
		setMaxConcurrent(n) {
			this.config.maxConcurrent = Math.max(1, n | 0);
		}
	};

//#endregion
//#region src/css-mode.ts
/**
	* CSS 模式 —— 注入 @font-face + unicode-range 样式（DOM 场景）
	*
	* 与原 public/webfont-sdk.js 行为一致：
	* - 片段就绪时注入 <style>，按 unicode-range 精确生效
	* - 用 document.fonts.load 追踪完成以释放并发槽
	* - loadFont（轮询）/ observeFont（MutationObserver）/ loadText（手动）三种触发器
	*/
	/** 跨域 baseUrl 注入 preconnect，首个片段延迟从 ~90ms 降到 ~30ms */
	const preconnectedOrigins = /* @__PURE__ */ new Set();
	function ensurePreconnect(baseUrl) {
		let origin;
		try {
			origin = new URL(baseUrl, location.href).origin;
		} catch {
			return;
		}
		if (origin === location.origin) return;
		if (preconnectedOrigins.has(origin)) return;
		preconnectedOrigins.add(origin);
		const link = document.createElement("link");
		link.rel = "preconnect";
		link.crossOrigin = "anonymous";
		link.href = origin;
		document.head.appendChild(link);
	}
	var WebFontCSSMode = class {
		constructor(config = {}) {
			this.injectedStyles = /* @__PURE__ */ new Map();
			this.pollTasks = /* @__PURE__ */ new Map();
			this.observeTasks = /* @__PURE__ */ new Map();
			this.engine = new IncrementalEngine({
				maxConcurrent: config.maxConcurrent ?? 4,
				provider: config.provider ?? null
			});
		}
		/** 底层引擎（FontFace 模式共用场景） */
		getEngine() {
			return this.engine;
		}
		/** 注入自定义子集提供者（离线裁剪等），null 恢复 HTTP */
		setSubsetProvider(provider) {
			this.engine.setProvider(provider);
		}
		setMaxConcurrent(n) {
			this.engine.setMaxConcurrent(n);
		}
		makeOnLoadChunk(key, family) {
			return (chunk) => {
				const unicodeRanges = chunk.chars.map((c) => "U+" + c.codePointAt(0).toString(16).padStart(4, "0")).join(", ");
				const style = document.createElement("style");
				style.textContent = `@font-face {
  font-family: "${family}";\n  src: url("${chunk.url}") format("${chunk.format}");\n  unicode-range: ` + unicodeRanges + ";\n}\n";
				document.head.appendChild(style);
				const list = this.injectedStyles.get(key) ?? [];
				list.push(style);
				this.injectedStyles.set(key, list);
				/** 注入后等待字体真正可用于渲染，让 document.fonts 状态机推进（无 API 时定时器兑底） */
				this.waitFontLoaded(family);
			};
		}
		/** 用 document.fonts.load 触发加载与就绪状态推进（无 API 时定时器兑底） */
		waitFontLoaded(family) {
			if (document.fonts && document.fonts.load) document.fonts.load(`16px "${family}"`);
			else setTimeout(() => {}, 3e3);
		}
		resolveDefaults(options) {
			const baseUrl = options.baseUrl ?? location.origin;
			const family = options.family ?? options.fontName.replace(/\.[^.]+$/, "");
			return {
				baseUrl,
				family,
				key: IncrementalEngine.fontKey(options.fontName, family)
			};
		}
		loadFont(options) {
			const { baseUrl, family, key } = this.resolveDefaults(options);
			ensurePreconnect(baseUrl);
			this.engine.ensureState(key, options.fontName, {
				baseUrl,
				outType: options.outType ?? "ttf",
				onLoadChunk: this.makeOnLoadChunk(key, family)
			});
			if (this.pollTasks.has(options.selector)) clearInterval(this.pollTasks.get(options.selector).timer);
			let applied = false;
			const tick = () => {
				const charSet = collectChars(options.selector);
				const had = this.engine.getState(key);
				this.engine.submitText(key, charsToString(charSet));
				if (had && !applied) {
					applied = true;
					applyFamily(options.selector, family);
				}
			};
			tick();
			const timer = setInterval(tick, options.interval ?? 1e3);
			this.pollTasks.set(options.selector, { timer });
		}
		observeFont(options) {
			const { baseUrl, family, key } = this.resolveDefaults(options);
			ensurePreconnect(baseUrl);
			this.engine.ensureState(key, options.fontName, {
				baseUrl,
				outType: options.outType ?? "ttf",
				onLoadChunk: this.makeOnLoadChunk(key, family)
			});
			if (this.observeTasks.has(options.selector)) this.observeTasks.get(options.selector).dispose();
			let applied = false;
			let debounceTimer = null;
			const doLoad = () => {
				const had = this.engine.getState(key);
				this.engine.submitText(key, charsToString(collectChars(options.selector)));
				if (had && !applied) {
					applied = true;
					applyFamily(options.selector, family);
				}
			};
			const debouncedLoad = () => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(doLoad, options.debounceMs ?? 50);
			};
			const observer = new MutationObserver((mutations) => {
				for (const m of mutations) if (m.type === "childList" || m.type === "characterData") {
					debouncedLoad();
					return;
				}
			});
			const inputHandler = () => debouncedLoad();
			const elements = document.querySelectorAll(options.selector);
			observer.observe(document.body ?? document.documentElement, {
				childList: true,
				subtree: true,
				characterData: true
			});
			for (const el of elements) if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.addEventListener("input", inputHandler);
			doLoad();
			let disposed = false;
			const task = { dispose: () => {
				if (disposed) return;
				disposed = true;
				observer.disconnect();
				for (const el of elements) if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.removeEventListener("input", inputHandler);
				if (debounceTimer) clearTimeout(debounceTimer);
				this.observeTasks.delete(options.selector);
			} };
			this.observeTasks.set(options.selector, task);
			return task;
		}
		loadText(options) {
			const { baseUrl, family, key } = this.resolveDefaults(options);
			ensurePreconnect(baseUrl);
			this.engine.ensureState(key, options.fontName, {
				baseUrl,
				outType: options.outType ?? "ttf",
				onLoadChunk: this.makeOnLoadChunk(key, family)
			});
			this.engine.submitText(key, options.text);
			let disposed = false;
			return {
				update: (text) => {
					if (disposed) return;
					this.engine.submitText(key, text);
				},
				dispose: () => {
					if (disposed) return;
					disposed = true;
					/** 移除该 loader 注入的所有 @font-face 样式，避免同名 family 的 CSS 优先级冲突 */
					const styles = this.injectedStyles.get(key);
					if (styles) {
						for (const s of styles) s.remove();
						this.injectedStyles.delete(key);
					}
					this.engine.removeState(key);
				}
			};
		}
		/** 清理所有任务与注入样式（页面卸载时调用） */
		disposeAll() {
			for (const { timer } of this.pollTasks.values()) clearInterval(timer);
			for (const task of this.observeTasks.values()) task.dispose();
			this.pollTasks.clear();
			this.observeTasks.clear();
			for (const styles of this.injectedStyles.values()) for (const s of styles) s.remove();
			this.injectedStyles.clear();
		}
		static {
			this.createHttpProvider = createHttpProvider;
		}
	};
	/** 收集选择器匹配元素中的所有字符 */
	function collectChars(selector) {
		const charSet = /* @__PURE__ */ new Set();
		const elements = document.querySelectorAll(selector);
		for (const el of elements) {
			const text = getText(el);
			for (const ch of text) charSet.add(ch);
		}
		return charSet;
	}
	function charsToString(set) {
		let s = "";
		for (const c of set) s += c;
		return s;
	}
	function getText(el) {
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
			const input = el;
			/** 同时收集 value 和 placeholder，确保占位文本的字体也被加载 */
			return (input.value ?? "") + (input.placeholder ?? "");
		}
		return el.textContent ?? "";
	}
	/** 应用字体到元素 */
	function applyFamily(selector, family) {
		const elements = document.querySelectorAll(selector);
		for (const el of elements) el.style.fontFamily = `"${family}", sans-serif`;
	}

//#endregion
//#region src/node-registry.ts
/**
	* 动态 import 的模块 specifier（包未安装时不参与类型解析，运行时 catch 返回 null）。
	* 用变量间接引用，打包器不会尝试静态解析该路径。
	*/
	const NAPI_CANVAS_MODULE = "@napi-rs/canvas";
	/** 一个逻辑字体（用户视角的 family）的 Node 端注册表 */
	var NodeFontRegistry = class {
		constructor(base) {
			this.entries = [];
			this.familyIndex = /* @__PURE__ */ new Map();
			this.globalFonts = null;
			this.base = base;
		}
		/** 绑定 GlobalFonts（懒加载 @napi-rs/canvas 成功后调用） */
		bind(globalFonts) {
			this.globalFonts = globalFonts;
		}
		/** 是否已绑定（未绑定时 registerChunk 会抛错） */
		get bound() {
			return this.globalFonts !== null;
		}
		/**
		* 注册一个新 chunk：唯一 family 名 + 逗号链回退
		* @returns 新的 fontFamily 链（调用方把它设置到 Text 节点上）
		*/
		registerChunk(chunk, buffer) {
			if (!this.globalFonts) throw new Error("NodeFontRegistry not bound to GlobalFonts");
			const index = this.entries.length;
			const family = `${this.base}__${index}`;
			const entry = {
				index,
				family,
				fontKey: this.globalFonts.register(buffer, family),
				chars: chunk.chars
			};
			this.entries.push(entry);
			this.familyIndex.set(family, entry);
			return this.fontChain();
		}
		/**
		* 当前完整的 fontFamily 链（逗号分隔，带引号防中文名/特殊字符问题）：
		* `"base__0", "base__1", ...`
		* 最后追加原始 base 名（此时 base 未注册，仅作为语义占位/调试可读性）
		*/
		fontChain() {
			if (this.entries.length === 0) return quote(this.base);
			return this.entries.map((e) => quote(e.family)).join(", ");
		}
		/** 已注册 chunk 数（调试用） */
		get size() {
			return this.entries.length;
		}
		/**
		* 卸载全部 chunk（dispose 用）。
		* FontKey 为 null 的（woff2 首注册返回 null 的场景）跳过 remove。
		*/
		dispose() {
			if (!this.globalFonts) return;
			for (const entry of this.entries) if (entry.fontKey != null) try {
				this.globalFonts.remove(entry.fontKey);
			} catch {}
			this.entries.length = 0;
			this.familyIndex.clear();
		}
	};
	/** family 名加引号（CSS font 串规范，中文名必须带引号） */
	function quote(family) {
		return `"${family}"`;
	}
	/** 动态加载 @napi-rs/canvas 的 GlobalFonts（未安装/非 Node 环境返回 null） */
	async function loadGlobalFonts() {
		try {
			return (await import(
				/* @vite-ignore */
				/* webpackIgnore: true */
				NAPI_CANVAS_MODULE
)).GlobalFonts ?? null;
		} catch {
			return null;
		}
	}
	/** 当前是否 Node 环境（无 document 且有 node 进程标记，用于模式分支） */
	function isNodeEnvironment() {
		const g = globalThis;
		return typeof g.document === "undefined" && !!g.process?.versions?.node;
	}

//#endregion
//#region src/fontface-mode.ts
/**
	* FontFace 模式 —— Canvas 场景（leafer / fabric / konva / 原生 canvas）
	*
	* 与 CSS 模式的差异：不注入 <style>，直接 fetch 字体 buffer 用 FontFace API 注册，
	* 且带 unicodeRange（多个片段同名注册时按字符精确生效，避免覆盖）。
	* 注册完成后回调 onReady，由调用方触发画布重绘。
	*/
	var WebFontFontFaceMode = class {
		constructor(config = {}) {
			this.defaultBaseUrl = "https://webfont.shenzilong.cn";
			this.faces = /* @__PURE__ */ new Map();
			this.nodeRegistries = /* @__PURE__ */ new Map();
			this.globalFonts = null;
			this.engine = new IncrementalEngine({
				maxConcurrent: config.maxConcurrent ?? 4,
				provider: config.provider ?? null
			});
			if (config.baseUrl) this.defaultBaseUrl = config.baseUrl;
			this.nodeEnv = isNodeEnvironment();
		}
		getEngine() {
			return this.engine;
		}
		setSubsetProvider(provider) {
			this.engine.setProvider(provider);
		}
		/**
		* 创建（或复用）一个字体的 FontFace 增量加载器。
		* 自动按环境分支：浏览器走 FontFace(unicodeRange)；Node 走 @napi-rs/canvas
		* GlobalFonts（每 chunk 唯一 family，调用方需读 fontFamilyChain 写回节点）。
		*
		* @param options 字体选项
		* @param onChunk 单个片段注册完成后回调（调用方在此触发画布重绘 / 更新 fontFamily 链）
		*/
		loadFontFace(options, onChunk) {
			const fontName = options.fontName;
			const family = options.family ?? fontName.replace(/\.(ttf|otf|woff2?|ttc)$/i, "").trim();
			const key = IncrementalEngine.fontKey(fontName, family);
			const baseUrl = options.baseUrl ?? this.defaultBaseUrl;
			/** Node 模式统一用 ttf：woff2 注册返回 null 不可靠（探针实证）；浏览器默认也是 ttf（见 IFontFaceOptions.outType 注释） */
			const outType = this.nodeEnv ? "ttf" : options.outType ?? "ttf";
			/** 浏览器分支：FontFace + unicodeRange（多 chunk 同 family 按字符精确生效） */
			const handleChunkBrowser = async (chunk) => {
				const unicodeRanges = chunk.chars.map((c) => "U+" + c.codePointAt(0).toString(16).padStart(4, "0")).join(", ");
				const buffer = await (await fetch(chunk.url)).arrayBuffer();
				const face = new FontFace(family, buffer, { unicodeRange: unicodeRanges });
				await face.load();
				document.fonts.add(face);
				const list = this.faces.get(family) ?? [];
				list.push(face);
				this.faces.set(family, list);
				onChunk?.(chunk);
			};
			/**
			* Node 分支：GlobalFonts.register（每 chunk 唯一 family，逗号链回退）。
			* 首次调用时懒加载 @napi-rs/canvas；未安装则抛错（开发期 fail fast）。
			*/
			const handleChunkNode = async (chunk) => {
				if (!this.globalFonts) this.globalFonts = await loadGlobalFonts();
				if (!this.globalFonts) throw new Error("Node 环境未安装 @napi-rs/canvas，无法注册字体（pnpm add @napi-rs/canvas）");
				let registry = this.nodeRegistries.get(family);
				if (!registry || !registry.bound) {
					registry = new NodeFontRegistry(family);
					registry.bind(this.globalFonts);
					this.nodeRegistries.set(family, registry);
				}
				const res = await fetch(chunk.url);
				const buffer = new Uint8Array(await res.arrayBuffer());
				registry.registerChunk(chunk, buffer);
				onChunk?.(chunk);
			};
			this.engine.ensureState(key, fontName, {
				baseUrl,
				outType,
				onLoadChunk: (chunk) => this.nodeEnv ? handleChunkNode(chunk) : handleChunkBrowser(chunk)
			});
			let disposed = false;
			return {
				update: (text) => {
					if (disposed) return;
					this.engine.submitText(key, text);
				},
				isPending: () => {
					const s = this.engine.getState(key);
					return !!s && s.pendingChars.size > 0;
				},
				retryFailed: () => this.engine.retryFailed(key),
				dispose: () => {
					if (disposed) return;
					disposed = true;
					this.engine.removeState(key);
					/** 浏览器 FontFace 不主动删除：其他画布可能还在用同 family（保守策略）。
					*  Node 端 GlobalFonts 进程级共享，同样保留（进程退出自然释放） */
				},
				fontFamilyChain: () => {
					if (!this.nodeEnv) return null;
					return this.nodeRegistries.get(family)?.fontChain() ?? null;
				}
			};
		}
		/** 是否有片段在请求/注册中（导出图片前轮询用） */
		hasPending() {
			return this.engine.hasPending();
		}
		/** 等待所有 pending 片段就绪（导出图片前调用） */
		async ready() {
			while (this.hasPending()) await new Promise((r) => setTimeout(r, 50));
		}
	};

//#endregion
//#region src/index.ts
/**
	* webfont-sdk —— Web 字体按需加载 SDK（不限中文：任何大字体都能按字符增量加载）
	*
	* 单包两种模式，共用同一增量引擎（去重 / 并发池 / 失败记忆 / provider 抽象）：
	* - `WebFont`（CSS 模式）：DOM 场景，注入 @font-face + unicode-range，API 与
	*   原线上 webfont-sdk.js 完全兼容（loadFont / observeFont / loadText / disposeAll /
	*   setMaxConcurrent / setSubsetProvider）
	* - `WebFontCanvas`（FontFace 模式）：Canvas 场景（leafer / fabric / 原生 canvas），
	*   fetch buffer + FontFace(unicodeRange) 注册，onChunk 回调触发画布重绘
	*/
	/**
	* CSS 模式默认实例 —— 与旧 webfont-sdk.js 的全局 WebFont 对象 API 兼容
	*/
	const WebFont = new WebFontCSSMode();
	/** FontFace 模式默认实例（Canvas 场景） */
	const WebFontCanvas = new WebFontFontFaceMode();

//#endregion
//#region src/iife.ts
/**
	* IIFE 入口 —— 构建为 public/webfont-sdk.js（script 标签直接引入）
	*
	* 全局暴露 WebFont，API 与历史版本完全兼容：
	*   WebFont.loadFont / observeFont / loadText / disposeAll /
	*   setMaxConcurrent / setSubsetProvider
	* 另暴露 WebFont.canvas（FontFace 模式，高级场景可用）。
	*/
	const g = globalThis;
	g.WebFont = WebFont;
	g.WebFontCanvas = WebFontCanvas;
	WebFont.canvas = WebFontCanvas;

//#endregion
})();