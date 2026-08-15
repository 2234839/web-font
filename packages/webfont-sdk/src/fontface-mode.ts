/**
 * FontFace 模式 —— Canvas 场景（leafer / fabric / konva / 原生 canvas）
 *
 * 与 CSS 模式的差异：不注入 <style>，直接 fetch 字体 buffer 用 FontFace API 注册，
 * 且带 unicodeRange（多个片段同名注册时按字符精确生效，避免覆盖）。
 * 注册完成后回调 onReady，由调用方触发画布重绘。
 */
import { IncrementalEngine, createHttpProvider, type SubsetProvider, type LoadedChunk, type IFontState } from './engine'

export interface IFontFaceOptions {
  /** 字体文件名（如 '令东齐伋复刻体.ttf'），支持模糊匹配 */
  fontName: string
  /** 服务基地址 */
  baseUrl?: string
  /** 注册用的 family 名，默认去掉扩展名 */
  family?: string
  /** 输出格式，默认 woff2 */
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
}

export class WebFontFontFaceMode {
  private engine: IncrementalEngine
  /** 未显式传 baseUrl 时的默认服务地址 */
  private defaultBaseUrl = 'https://webfont.shenzilong.cn'
  /** family -> 已注册的 FontFace（dispose 时从 document.fonts 删除） */
  private faces = new Map<string, FontFace[]>()

  constructor(config: { baseUrl?: string; maxConcurrent?: number; provider?: SubsetProvider | null } = {}) {
    this.engine = new IncrementalEngine({
      maxConcurrent: config.maxConcurrent ?? 4,
      provider: config.provider ?? null,
    })
    if (config.baseUrl) this.defaultBaseUrl = config.baseUrl
  }

  getEngine(): IncrementalEngine {
    return this.engine
  }

  setSubsetProvider(provider: SubsetProvider | null): void {
    this.engine.setProvider(provider)
  }

  /**
   * 创建（或复用）一个字体的 FontFace 增量加载器
   *
   * @param options 字体选项
   * @param onChunk 单个片段注册完成后回调（调用方在此触发画布重绘）
   */
  loadFontFace(options: IFontFaceOptions, onChunk?: (chunk: LoadedChunk) => void): IFontFaceLoader {
    const fontName = options.fontName
    const family = options.family ?? fontName.replace(/\.(ttf|otf|woff2?|ttc)$/i, '').trim()
    const key = IncrementalEngine.fontKey(fontName, family)
    const baseUrl = options.baseUrl ?? this.defaultBaseUrl

    const handleChunk = async (chunk: LoadedChunk): Promise<void> => {
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

    this.engine.ensureState(key, fontName, {
      baseUrl,
      outType: options.outType ?? 'woff2',
      onLoadChunk: (chunk) => handleChunk(chunk),
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
        /** FontFace 不主动删除：其他画布可能还在用同 family（保守策略） */
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
export type { SubsetProvider, LoadedChunk, IFontState }
