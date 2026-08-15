/**
 * FontFace 模式 —— Canvas 场景（leafer / fabric / konva / 原生 canvas）
 *
 * 与 CSS 模式的差异：不注入 <style>，直接 fetch 字体 buffer 用 FontFace API 注册，
 * 且带 unicodeRange（多个片段同名注册时按字符精确生效，避免覆盖）。
 * 注册完成后回调 onReady，由调用方触发画布重绘。
 */
import { IncrementalEngine, createHttpProvider, type SubsetProvider, type LoadedChunk, type IFontState } from './engine'
import { NodeFontRegistry, loadGlobalFonts, isNodeEnvironment } from './node-registry'

export interface IFontFaceOptions {
  /** 字体文件名（如 '令东齐伋复刻体.ttf'），支持模糊匹配 */
  fontName: string
  /** 服务基地址 */
  baseUrl?: string
  /** 注册用的 family 名，默认去掉扩展名 */
  family?: string
  /** 输出格式，默认 woff2（Node 端自动降级 ttf，见 loadFontFace） */
  outType?: 'woff2' | 'ttf'
}

/** 单个 FontFace 字体的增量加载器（leafer 插件等持有） */
export interface IFontFaceLoader {
  /** 提交文本（自动去重，只请求新字符） */
  update(text: string): void
  /** 该字体是否有片段在请求中 */
  isPending(): boolean
  /** 清除失败记录（重试场景） */
  retryFailed(): void
  dispose(): void
  /**
   * 当前生效的 fontFamily 链（仅 Node 模式有意义）。
   * Node 端每个 chunk 注册为唯一 family，Skia 链回退按字形匹配；
   * 新 chunk 就绪后链会变长，调用方需把它写回 Text 节点的 fontFamily。
   * 浏览器模式恒返回 null（FontFace unicodeRange 天然支持增量）。
   */
  fontFamilyChain(): string | null
}

export class WebFontFontFaceMode {
  private engine: IncrementalEngine
  /** 未显式传 baseUrl 时的默认服务地址 */
  private defaultBaseUrl = 'https://webfont.shenzilong.cn'
  /** family -> 已注册的 FontFace（dispose 时从 document.fonts 删除；浏览器模式用） */
  private faces = new Map<string, FontFace[]>()
  /** family -> Node 注册表（Node 模式用；浏览器环境恒为空） */
  private nodeRegistries = new Map<string, NodeFontRegistry>()
  /** Node 模式懒加载的 GlobalFonts（null = 未加载或加载失败） */
  private globalFonts: Awaited<ReturnType<typeof loadGlobalFonts>> = null
  /** 是否 Node 环境（构造时探测一次，后续分支依据） */
  private readonly nodeEnv: boolean

  constructor(config: { baseUrl?: string; maxConcurrent?: number; provider?: SubsetProvider | null } = {}) {
    this.engine = new IncrementalEngine({
      maxConcurrent: config.maxConcurrent ?? 4,
      provider: config.provider ?? null,
    })
    if (config.baseUrl) this.defaultBaseUrl = config.baseUrl
    this.nodeEnv = isNodeEnvironment()
  }

  getEngine(): IncrementalEngine {
    return this.engine
  }

  setSubsetProvider(provider: SubsetProvider | null): void {
    this.engine.setProvider(provider)
  }

  /**
   * 创建（或复用）一个字体的 FontFace 增量加载器。
   * 自动按环境分支：浏览器走 FontFace(unicodeRange)；Node 走 @napi-rs/canvas
   * GlobalFonts（每 chunk 唯一 family，调用方需读 fontFamilyChain 写回节点）。
   *
   * @param options 字体选项
   * @param onChunk 单个片段注册完成后回调（调用方在此触发画布重绘 / 更新 fontFamily 链）
   */
  loadFontFace(options: IFontFaceOptions, onChunk?: (chunk: LoadedChunk) => void): IFontFaceLoader {
    const fontName = options.fontName
    const family = options.family ?? fontName.replace(/\.(ttf|otf|woff2?|ttc)$/i, '').trim()
    const key = IncrementalEngine.fontKey(fontName, family)
    const baseUrl = options.baseUrl ?? this.defaultBaseUrl
    /** Node 模式统一用 ttf：woff2 注册返回 null 不可靠（探针实证） */
    const outType = this.nodeEnv ? 'ttf' : options.outType ?? 'woff2'

    /** 浏览器分支：FontFace + unicodeRange（多 chunk 同 family 按字符精确生效） */
    const handleChunkBrowser = async (chunk: LoadedChunk): Promise<void> => {
      const unicodeRanges = chunk.chars
        .map((c) => 'U+' + c.codePointAt(0)!.toString(16).padStart(4, '0'))
        .join(', ')
      const res = await fetch(chunk.url)
      const buffer = await res.arrayBuffer()
      const face = new FontFace(family, buffer, { unicodeRange: unicodeRanges })
      await face.load()
      document.fonts.add(face)
      const list = this.faces.get(family) ?? []
      list.push(face)
      this.faces.set(family, list)
      onChunk?.(chunk)
    }

    /**
     * Node 分支：GlobalFonts.register（每 chunk 唯一 family，逗号链回退）。
     * 首次调用时懒加载 @napi-rs/canvas；未安装则抛错（开发期 fail fast）。
     */
    const handleChunkNode = async (chunk: LoadedChunk): Promise<void> => {
      if (!this.globalFonts) this.globalFonts = await loadGlobalFonts()
      if (!this.globalFonts) {
        throw new Error('Node 环境未安装 @napi-rs/canvas，无法注册字体（pnpm add @napi-rs/canvas）')
      }
      let registry = this.nodeRegistries.get(family)
      if (!registry || !registry.bound) {
        registry = new NodeFontRegistry(family)
        registry.bind(this.globalFonts)
        this.nodeRegistries.set(family, registry)
      }
      const res = await fetch(chunk.url)
      const buffer = new Uint8Array(await res.arrayBuffer())
      registry.registerChunk(chunk, buffer)
      onChunk?.(chunk)
    }

    this.engine.ensureState(key, fontName, {
      baseUrl,
      outType,
      onLoadChunk: (chunk) => (this.nodeEnv ? handleChunkNode(chunk) : handleChunkBrowser(chunk)),
    })

    let disposed = false
    return {
      update: (text: string): void => {
        if (disposed) return
        this.engine.submitText(key, text)
      },
      isPending: (): boolean => {
        const s = this.engine.getState(key)
        return !!s && s.pendingChars.size > 0
      },
      retryFailed: (): void => this.engine.retryFailed(key),
      dispose: (): void => {
        if (disposed) return
        disposed = true
        this.engine.removeState(key)
        /** 浏览器 FontFace 不主动删除：其他画布可能还在用同 family（保守策略）。
         *  Node 端 GlobalFonts 进程级共享，同样保留（进程退出自然释放） */
      },
      fontFamilyChain: (): string | null => {
        if (!this.nodeEnv) return null
        return this.nodeRegistries.get(family)?.fontChain() ?? null
      },
    }
  }

  /** 是否有片段在请求/注册中（导出图片前轮询用） */
  hasPending(): boolean {
    return this.engine.hasPending()
  }

  /** 等待所有 pending 片段就绪（导出图片前调用） */
  async ready(): Promise<void> {
    while (this.hasPending()) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

export { createHttpProvider, IncrementalEngine }
export { NodeFontRegistry, loadGlobalFonts, isNodeEnvironment }
export type { SubsetProvider, LoadedChunk, IFontState }
