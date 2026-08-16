/**
 * 核心增量引擎 —— 按 fontKey 管理字符集与子集请求
 *
 * 职责（与「注册方式」无关，被 CSS 模式 / FontFace 模式共用）：
 * 1. 字符去重：同一字体下只对未加载过的字符发起子集请求
 * 2. 并发控制：全局并发池，任务在「provider 返回 + 注册完成」后才释放槽位，
 *    与旧版一致地把浏览器字体挂载也纳入限流
 * 3. 失败记忆：加载/注册失败的字符记入 failedChars，不再反复请求（可手动重试）
 * 4. provider 抽象：默认走 HTTP API，可注入离线裁剪 provider
 *
 * 不负责：把字体片段注册到运行环境（CSS @font-face / FontFace 由外层模式完成）
 */

/** 子集提供者：给定字体名+文本，返回字体片段 URL 与格式（HTTP 或 blob:） */
export type SubsetProvider = (fontName: string, text: string, outType: string) => Promise<{ url: string; format: string }>

/** 单个字体的增量状态 */
export interface IFontState {
  /** 字体名（API 查询用，如 '令东齐伋复刻体.ttf'），服务端支持模糊匹配 */
  fontName: string
  /** 该字体的服务基地址（HTTP provider 用） */
  baseUrl: string
  /** 输出格式 */
  outType: string
  /** 已成功加载的字符集 */
  loadedChars: Set<string>
  /** 加载失败过的字符集（字体不含此字 / 网络错误），避免反复请求 */
  failedChars: Set<string>
  /** 正在请求中的字符集（防重复并发） */
  pendingChars: Set<string>
  /**
   * 该字体的注册回调：新片段就绪时由模式层把字体挂到运行环境。
   * 返回 Promise 时引擎会等它完成才释放并发槽（保证 ready() 语义）。
   */
  onLoadChunk: ((chunk: LoadedChunk) => void | Promise<void>) | null
  /**
   * 该字体的专属 provider（优先于引擎级配置）。
   * uni 小程序模式用：无 unicode-range，需按累积全集而非增量构造 URL
   */
  provider?: SubsetProvider | null
}

/** 一次成功加载的增量片段 */
export interface LoadedChunk {
  /** 字体名 */
  fontName: string
  /** 本片段包含的字符 */
  chars: string[]
  /** 字体文件 URL */
  url: string
  /** 字体格式（woff2 / truetype） */
  format: string
}

/** 引擎配置 */
export interface IEngineConfig {
  /** 全局最大并发子集请求（含注册）数，默认 4 */
  maxConcurrent: number
  /** 自定义子集提供者（离线裁剪场景），null 表示走默认 HTTP */
  provider: SubsetProvider | null
}

/** 创建字体状态的初始选项 */
export interface IEnsureStateOptions {
  /** 服务基地址（HTTP provider 用） */
  baseUrl: string
  /** 输出格式 */
  outType: string
  /** 注册回调（可后补） */
  onLoadChunk?: (chunk: LoadedChunk) => void | Promise<void>
  /** 该字体的专属 provider（优先于引擎级配置） */
  provider?: SubsetProvider | null
}

export function createHttpProvider(baseUrl: string): SubsetProvider {
  return (fontName, text, outType) => {
    const url = `${baseUrl}/api?font=${encodeURIComponent(fontName)}&text=${encodeURIComponent(text)}&outType=${outType}`
    return Promise.resolve({ url, format: outType === 'woff2' ? 'woff2' : 'truetype' })
  }
}

export class IncrementalEngine {
  /** fontKey -> 字体状态 */
  private states = new Map<string, IFontState>()
  private config: IEngineConfig

  /** 并发池 */
  private active = 0
  private queue: Array<() => Promise<void>> = []
  /** 在途任务数（provider 请求 + 注册回调），hasPending / ready 用 */
  private flying = 0

  constructor(config: Partial<IEngineConfig> = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 4,
      provider: config.provider ?? null,
    }
  }

  /** fontKey：fontName + family 唯一确定一个增量组 */
  static fontKey(fontName: string, family: string): string {
    return fontName + '|' + family
  }

  setProvider(provider: SubsetProvider | null): void {
    this.config.provider = provider
  }

  getState(key: string): IFontState | undefined {
    return this.states.get(key)
  }

  /** 获取或创建字体状态；已存在时按传入项更新 baseUrl / outType / 回调 */
  ensureState(key: string, fontName: string, options: IEnsureStateOptions): IFontState {
    let state = this.states.get(key)
    if (!state) {
      state = {
        fontName,
        baseUrl: options.baseUrl,
        outType: options.outType,
        loadedChars: new Set(),
        failedChars: new Set(),
        pendingChars: new Set(),
        onLoadChunk: options.onLoadChunk ?? null,
        provider: options.provider ?? null,
      }
      this.states.set(key, state)
      return state
    }
    state.baseUrl = options.baseUrl
    state.outType = options.outType
    if (options.onLoadChunk) state.onLoadChunk = options.onLoadChunk
    if (options.provider !== undefined) state.provider = options.provider
    return state
  }

  /** 删除状态（销毁时） */
  removeState(key: string): void {
    this.states.delete(key)
  }

  /** 是否还有在途任务（请求中或注册中，ready() 轮询用） */
  hasPending(): boolean {
    if (this.flying > 0) return true
    for (const s of this.states.values()) {
      if (s.pendingChars.size > 0) return true
    }
    return false
  }

  /** 清除失败记录（下次遇到这些字符会重新请求） */
  retryFailed(key: string): void {
    this.states.get(key)?.failedChars.clear()
  }

  /**
   * 提交一批文本：过滤出新字符并异步请求子集。
   * 乐观标记 pending，成功移入 loaded、失败移入 failed。
   * 超过 maxCharsPerChunk 时自动分批（uni 小程序 loadFontFace 无 unicode-range，
   * 单次需携带全量累积文本，长文本按批切分避免 URL 超限）。
   */
  submitText(key: string, text: string, maxCharsPerChunk = Infinity): void {
    const state = this.states.get(key)
    if (!state) return
    const newChars: string[] = []
    for (const ch of text) {
      if (state.loadedChars.has(ch) || state.pendingChars.has(ch) || state.failedChars.has(ch)) continue
      /** 跳过控制字符 */
      if (ch.charCodeAt(0) < 0x20) continue
      newChars.push(ch)
      state.pendingChars.add(ch)
    }
    if (newChars.length === 0) return
    for (let i = 0; i < newChars.length; i += maxCharsPerChunk) {
      const batch = newChars.slice(i, i + maxCharsPerChunk)
      this.enqueue(() => this.loadChunk(state, batch))
    }
  }

  /** 执行一次子集请求 + 注册（在并发槽内完成） */
  private async loadChunk(state: IFontState, chars: string[]): Promise<void> {
    this.flying++
    try {
      const text = chars.join('')
      const provider = state.provider ?? this.config.provider ?? createHttpProvider(state.baseUrl)
      const result = await provider(state.fontName, text, state.outType)
      /** 注册完成后才把字符记为已加载：注册失败可走 failedChars 重试路径 */
      await state.onLoadChunk?.({
        fontName: state.fontName,
        chars,
        url: result.url,
        format: result.format,
      })
      for (const ch of chars) {
        state.loadedChars.add(ch)
        state.pendingChars.delete(ch)
      }
    } catch {
      for (const ch of chars) {
        state.pendingChars.delete(ch)
        state.failedChars.add(ch)
      }
    } finally {
      this.flying--
    }
  }

  /** 并发池：超出 maxConcurrent 的任务排队等待 */
  private enqueue(fn: () => Promise<void>): void {
    if (this.active < this.config.maxConcurrent) {
      this.execute(fn)
    } else {
      this.queue.push(fn)
    }
  }

  /**
   * 执行一个任务，完成后从队列取下一个。
   * 注意：这里必须直接调用 next（fn），不能递归调用外层 run 闭包——
   * 那样会把下一个任务替换成本次任务重跑（闭包捕获），队列真身丢失
   */
  private execute(fn: () => Promise<void>): void {
    this.active++
    fn().finally(() => {
      this.active--
      const next = this.queue.shift()
      if (next) this.execute(next)
    })
  }

  setMaxConcurrent(n: number): void {
    this.config.maxConcurrent = Math.max(1, n | 0)
  }
}
