/**
 * gs-webfont —— uni-app 字体按需加载（由 packages/uni-webfont 构建，勿手改）
 * 文档：https://webfont.shenzilong.cn
 */
//#region ../webfont-sdk/dist/engine.js
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
//#region src/index.ts
/**
* uni-webfont —— uni-app 字体按需加载（小程序 / H5 / App 通用）
*
* 原理：中文字体动辄 5-20MB，小程序主包限 2MB，整包加载必死。
* 本插件把「页面实际用到的字符」提交给子集化服务，服务端按字符裁出
* 几 KB 的字体片段，再通过 uni.loadFontFace 注册——文字用多少、加载多少。
*
* 与 web（@font-face unicode-range 多片段并存）的关键差异：
* 小程序 loadFontFace 不支持 unicode-range，同名 family 只有一个生效字体。
* 因此本层采用「字符累积 + 全量重载」策略：
*   - 引擎层（webfont-sdk IncrementalEngine）仍按字符去重，只有新字符触发请求
*   - 每次请求携带累积全集（新字符 + 历史已加载字符），服务端缓存按文本命中
*   - 片段就绪后 uni.loadFontFace 同 family 重载，旧字形保持渲染直到新字体
*     就绪，视觉上无闪烁
*   - maxConcurrent 固定 1：同 family 的子集请求必须串行，保证后到的
*     请求字符集是前者的超集（并发乱序会让小集合后落地、丢字符）
*
* 用法：
* ```ts
* import { UniWebFont } from 'uni-webfont'
*
* const loader = UniWebFont.loadFont({ fontName: '令东齐伋复刻体.ttf' })
* loader.update('静心茶舍 今日特饮')
* // 渲染前等待字体就绪（可选，旧字形兜底显示）
* await loader.ready()
* ```
*/
/**
* 取全局 uni 对象。
* 不用 declare global 声明：发布的 d.ts 会与用户工程里 @dcloudio/types
* 的 uni 声明冲突（重复标识符）；globalThis 交叉类型是零依赖的诚实写法
*/
function getUni() {
	const g = globalThis;
	if (!g.uni) throw new Error("[uni-webfont] 未检测到 uni 全局对象，请在 uni-app 环境中使用");
	return g.uni;
}
/** fontFamily 里的文件后缀（family 名不认扩展名） */
const FONT_EXT_RE = /\.(ttf|otf|woff2?|ttc)$/i;
var UniWebFontMode = class {
	constructor(config = {}) {
		this.defaultBaseUrl = "https://webfont.shenzilong.cn";
		if (config.baseUrl) this.defaultBaseUrl = config.baseUrl;
		this.engine = new IncrementalEngine({
			/** 串行必须：见文件头「字符累积 + 全量重载」策略说明 */
			maxConcurrent: 1,
			provider: null
		});
	}
	getEngine() {
		return this.engine;
	}
	/**
	* 创建（或复用）一个字体的增量加载器。
	* 返回的 loader 可反复 update：引擎按字符去重，只有新字符触发网络请求
	*/
	loadFont(options) {
		const fontName = options.fontName;
		const family = options.family ?? fontName.replace(FONT_EXT_RE, "").trim();
		const key = IncrementalEngine.fontKey(fontName, family);
		const baseUrl = options.baseUrl ?? this.defaultBaseUrl;
		const outType = options.outType ?? "ttf";
		const global = options.global ?? true;
		const maxCharsPerChunk = options.maxCharsPerChunk ?? 300;
		const debug = options.debug ?? false;
		/**
		* 累积字符集（目标全集）：每次子集请求都携带它，保证新字体
		* 一定是已渲染字体的超集。失败字符也计入——重试时靠它自愈。
		* 同字体二次 loadFont（跨页面复用 state）时从引擎播种已处理的字符，
		* 否则空累积集会让重载 URL 丢掉历史字符（无 unicode-range，重载即替换）
		*/
		const existing = this.engine.getState(key);
		const accumulated = new Set(existing ? [
			...existing.loadedChars,
			...existing.failedChars,
			...existing.pendingChars
		] : []);
		/** 累积全集 provider：覆盖引擎默认的「仅新字符」URL 构造 */
		const provider = (name, batchText, type) => {
			for (const ch of batchText) accumulated.add(ch);
			const text = Array.from(accumulated).join("");
			if (debug) console.log(`[uni-webfont] subset ${family}: +${batchText.length} → 累积 ${text.length} 字`);
			return Promise.resolve({
				url: `${baseUrl}/api?font=${encodeURIComponent(name)}&text=${encodeURIComponent(text)}&outType=${type}`,
				format: type === "woff2" ? "woff2" : "truetype"
			});
		};
		/** 片段就绪 → uni.loadFontFace 重载同 family（source 直传 URL，由平台下载） */
		const onLoadChunk = (chunk) => new Promise((resolve, reject) => {
			getUni().loadFontFace({
				family,
				source: `url("${chunk.url}")`,
				global,
				desc: options.desc,
				success: () => {
					if (debug) console.log(`[uni-webfont] ${family} 已生效（${chunk.chars.length} 字增量）`);
					resolve();
				},
				fail: (err) => {
					const msg = `uni-webfont loadFontFace 失败: ${family} — ${err?.errMsg ?? "未知错误"}`;
					if (debug) console.error(msg);
					reject(new Error(msg));
				}
			});
		});
		/** per-state provider：累积全集 URL（见文件头策略说明），同 key 复用时不重复注入 */
		this.engine.ensureState(key, fontName, {
			baseUrl,
			outType,
			onLoadChunk,
			provider
		});
		let disposed = false;
		return {
			update: (text) => {
				if (disposed) return;
				this.engine.submitText(key, text, maxCharsPerChunk);
			},
			isPending: () => {
				const s = this.engine.getState(key);
				return !!s && s.pendingChars.size > 0;
			},
			ready: async () => {
				while (this.engine.hasPending()) await new Promise((r) => setTimeout(r, 50));
			},
			retryFailed: () => this.engine.retryFailed(key),
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.engine.removeState(key);
			}
		};
	}
	/** 是否有片段在请求/注册中（所有字体） */
	hasPending() {
		return this.engine.hasPending();
	}
	/** 等待全部在途片段就绪（截图/导出前调用） */
	async ready() {
		while (this.hasPending()) await new Promise((r) => setTimeout(r, 50));
	}
};
/** 默认实例（与 webfont-sdk 的 WebFont / WebFontCanvas 命名约定一致） */
const UniWebFont = new UniWebFontMode();
//#endregion
export { UniWebFont, UniWebFontMode };
