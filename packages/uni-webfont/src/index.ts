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
import { IncrementalEngine, type SubsetProvider, type LoadedChunk } from 'webfont-sdk/engine'

/** uni.loadFontFace 参数（最小访问面，避免依赖 @dcloudio/types） */
interface IUniLoadFontFaceOptions {
  family: string
  source: string
  global?: boolean
  desc?: { style?: string; weight?: string; variant?: string }
  success?: () => void
  fail?: (err: { errMsg?: string }) => void
  complete?: () => void
}

/** uni 宿主全局对象的最小类型面 */
interface IUniGlobal {
  loadFontFace(options: IUniLoadFontFaceOptions): void
}

/**
 * 取全局 uni 对象。
 * 不用 declare global 声明：发布的 d.ts 会与用户工程里 @dcloudio/types
 * 的 uni 声明冲突（重复标识符）；globalThis 交叉类型是零依赖的诚实写法
 */
function getUni(): IUniGlobal {
  const g = globalThis as typeof globalThis & { uni?: IUniGlobal }
  if (!g.uni) {
    throw new Error('[uni-webfont] 未检测到 uni 全局对象，请在 uni-app 环境中使用')
  }
  return g.uni
}

/** 单个字体的加载选项 */
export interface IUniFontOptions {
  /** 字体文件名（如 '令东齐伋复刻体.ttf'），服务端支持模糊匹配 */
  fontName: string
  /** 子集化服务基地址，默认官方在线服务 */
  baseUrl?: string
  /** loadFontFace 注册的 family 名，默认去掉扩展名的字体名 */
  family?: string
  /**
   * 输出格式，默认 'ttf'。
   * 小程序建议 ttf（iOS 低版本对 woff2 兼容性差）；纯 H5 场景可传 'woff2' 省流量
   */
  outType?: 'ttf' | 'woff2'
  /** 是否全局生效（微信 2.10.0+，需在 App.vue 调用才对全 app 生效），默认 true */
  global?: boolean
  /** 单次请求携带的最大字符数，超出自动分批串行加载，默认 300（URL 长度安全值） */
  maxCharsPerChunk?: number
  /** 字体描述符透传（style / weight / variant） */
  desc?: { style?: string; weight?: string; variant?: string }
  /** 是否在控制台输出调试日志 */
  debug?: boolean
}

/** loadFont 返回的增量加载器 */
export interface IUniFontLoader {
  /** 提交文本（自动去重，只请求出现过的字符） */
  update(text: string): void
  /** 该字体是否有片段在请求/注册中 */
  isPending(): boolean
  /** 等待全部在途片段就绪（截图/导出前调用） */
  ready(): Promise<void>
  /** 清除失败记录，配合 update 重试失败字符 */
  retryFailed(): void
  dispose(): void
}

/** fontFamily 里的文件后缀（family 名不认扩展名） */
const FONT_EXT_RE = /\.(ttf|otf|woff2?|ttc)$/i

export class UniWebFontMode {
  private engine: IncrementalEngine
  /** 未显式传 baseUrl 时的默认服务地址 */
  private defaultBaseUrl = 'https://webfont.shenzilong.cn'

  constructor(config: { baseUrl?: string } = {}) {
    if (config.baseUrl) this.defaultBaseUrl = config.baseUrl
    this.engine = new IncrementalEngine({
      /** 串行必须：见文件头「字符累积 + 全量重载」策略说明 */
      maxConcurrent: 1,
      provider: null,
    })
  }

  getEngine(): IncrementalEngine {
    return this.engine
  }

  /**
   * 创建（或复用）一个字体的增量加载器。
   * 返回的 loader 可反复 update：引擎按字符去重，只有新字符触发网络请求
   */
  loadFont(options: IUniFontOptions): IUniFontLoader {
    const fontName = options.fontName
    const family = options.family ?? fontName.replace(FONT_EXT_RE, '').trim()
    const key = IncrementalEngine.fontKey(fontName, family)
    const baseUrl = options.baseUrl ?? this.defaultBaseUrl
    const outType = options.outType ?? 'ttf'
    const global = options.global ?? true
    const maxCharsPerChunk = options.maxCharsPerChunk ?? 300
    const debug = options.debug ?? false

    /**
     * 累积字符集（目标全集）：每次子集请求都携带它，保证新字体
     * 一定是已渲染字体的超集。失败字符也计入——重试时靠它自愈。
     * 同字体二次 loadFont（跨页面复用 state）时从引擎播种已处理的字符，
     * 否则空累积集会让重载 URL 丢掉历史字符（无 unicode-range，重载即替换）
     */
    const existing = this.engine.getState(key)
    const accumulated = new Set<string>(
      existing
        ? [...existing.loadedChars, ...existing.failedChars, ...existing.pendingChars]
        : [],
    )

    /** 累积全集 provider：覆盖引擎默认的「仅新字符」URL 构造 */
    const provider: SubsetProvider = (name, batchText, type) => {
      for (const ch of batchText) accumulated.add(ch)
      const text = Array.from(accumulated).join('')
      if (debug) console.log(`[uni-webfont] subset ${family}: +${batchText.length} → 累积 ${text.length} 字`)
      return Promise.resolve({
        url: `${baseUrl}/api?font=${encodeURIComponent(name)}&text=${encodeURIComponent(text)}&outType=${type}`,
        format: type === 'woff2' ? 'woff2' : 'truetype',
      })
    }

    /** 片段就绪 → uni.loadFontFace 重载同 family（source 直传 URL，由平台下载） */
    const onLoadChunk = (chunk: LoadedChunk) =>
      new Promise<void>((resolve, reject) => {
        getUni().loadFontFace({
          family,
          source: `url("${chunk.url}")`,
          global,
          desc: options.desc,
          success: () => {
            if (debug) console.log(`[uni-webfont] ${family} 已生效（${chunk.chars.length} 字增量）`)
            resolve()
          },
          fail: (err) => {
            const msg = `uni-webfont loadFontFace 失败: ${family} — ${err?.errMsg ?? '未知错误'}`
            if (debug) console.error(msg)
            reject(new Error(msg))
          },
        })
      })

    /** per-state provider：累积全集 URL（见文件头策略说明），同 key 复用时不重复注入 */
    this.engine.ensureState(key, fontName, { baseUrl, outType, onLoadChunk, provider })

    let disposed = false
    return {
      update: (text: string): void => {
        if (disposed) return
        this.engine.submitText(key, text, maxCharsPerChunk)
      },
      isPending: (): boolean => {
        const s = this.engine.getState(key)
        return !!s && s.pendingChars.size > 0
      },
      ready: async (): Promise<void> => {
        while (this.engine.hasPending()) {
          await new Promise((r) => setTimeout(r, 50))
        }
      },
      retryFailed: (): void => this.engine.retryFailed(key),
      dispose: (): void => {
        if (disposed) return
        disposed = true
        this.engine.removeState(key)
      },
    }
  }

  /** 是否有片段在请求/注册中（所有字体） */
  hasPending(): boolean {
    return this.engine.hasPending()
  }

  /** 等待全部在途片段就绪（截图/导出前调用） */
  async ready(): Promise<void> {
    while (this.hasPending()) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** 默认实例（与 webfont-sdk 的 WebFont / WebFontCanvas 命名约定一致） */
export const UniWebFont = new UniWebFontMode()
