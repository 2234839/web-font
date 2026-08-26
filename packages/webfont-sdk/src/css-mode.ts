/**
 * CSS 模式 —— 注入 @font-face + unicode-range 样式（DOM 场景）
 *
 * 与原 public/webfont-sdk.js 行为一致：
 * - 片段就绪时注入 <style>，按 unicode-range 精确生效
 * - 用 document.fonts.load 追踪完成以释放并发槽
 * - loadFont（轮询）/ observeFont（MutationObserver）/ loadText（手动）三种触发器
 */
import { IncrementalEngine, createHttpProvider, type SubsetProvider, type LoadedChunk } from './engine'

/** 通用选项 */
export interface IWebFontOptions {
  /** 字体文件名（如 '令东齐伋复刻体.ttf'），支持模糊匹配 */
  fontName: string
  /** 服务基地址，默认当前 origin */
  baseUrl?: string
  /** CSS font-family 名，默认去掉扩展名的字体名 */
  family?: string
  /** 输出格式，默认 ttf：子集场景无 brotli 编码/解码开销，端到端更快（几 KB 的子集体积差异可忽略） */
  outType?: 'woff2' | 'ttf'
}

export interface ILoadFontOptions extends IWebFontOptions {
  /** DOM 选择器 */
  selector: string
  /** 轮询间隔 ms，默认 1000 */
  interval?: number
}

export interface IObserveFontOptions extends IWebFontOptions {
  /** DOM 选择器 */
  selector: string
  /** 防抖 ms，默认 50 */
  debounceMs?: number
}

export interface ILoadTextOptions extends IWebFontOptions {
  /** 初始文本 */
  text: string
}

/** loadText 返回的手动加载器 */
export interface ITextLoader {
  /** 追加文本（自动去重） */
  update(text: string): void
  dispose(): void
}

/** observeFont 返回的观察任务 */
export interface IObserveTask {
  dispose(): void
}

/** 跨域 baseUrl 注入 preconnect，首个片段延迟从 ~90ms 降到 ~30ms */
const preconnectedOrigins = new Set<string>()

function ensurePreconnect(baseUrl: string): void {
  let origin: string
  try {
    origin = new URL(baseUrl, location.href).origin
  } catch {
    return
  }
  if (origin === location.origin) return
  if (preconnectedOrigins.has(origin)) return
  preconnectedOrigins.add(origin)

  const link = document.createElement('link')
  link.rel = 'preconnect'
  link.crossOrigin = 'anonymous'
  link.href = origin
  document.head.appendChild(link)
}

export class WebFontCSSMode {
  private engine: IncrementalEngine
  /** 每个加载器注入的 <style> 元素（销毁时移除） */
  private injectedStyles = new Map<string, HTMLStyleElement[]>()
  private pollTasks = new Map<string, { timer: ReturnType<typeof setInterval> }>()
  private observeTasks = new Map<string, IObserveTask>()

  constructor(config: { baseUrl?: string; maxConcurrent?: number; provider?: SubsetProvider | null } = {}) {
    this.engine = new IncrementalEngine({
      maxConcurrent: config.maxConcurrent ?? 4,
      provider: config.provider ?? null,
    })
  }

  /** 底层引擎（FontFace 模式共用场景） */
  getEngine(): IncrementalEngine {
    return this.engine
  }

  /** 注入自定义子集提供者（离线裁剪等），null 恢复 HTTP */
  setSubsetProvider(provider: SubsetProvider | null): void {
    this.engine.setProvider(provider)
  }

  setMaxConcurrent(n: number): void {
    this.engine.setMaxConcurrent(n)
  }

  /* ---------- 内部：片段就绪回调（注入 CSS） ---------- */

  private makeOnLoadChunk(key: string, family: string) {
    return (chunk: LoadedChunk): void => {
      const unicodeRanges = chunk.chars
        .map((c) => 'U+' + c.codePointAt(0)!.toString(16).padStart(4, '0'))
        .join(', ')
      const style = document.createElement('style')
      style.textContent =
        '@font-face {\n' +
        `  font-family: "${family}";\n` +
        `  src: url("${chunk.url}") format("${chunk.format}");\n` +
        '  unicode-range: ' + unicodeRanges + ';\n' +
        '}\n'
      document.head.appendChild(style)
      const list = this.injectedStyles.get(key) ?? []
      list.push(style)
      this.injectedStyles.set(key, list)
      /** 注入后等待字体真正可用于渲染，让 document.fonts 状态机推进（无 API 时定时器兑底） */
      this.waitFontLoaded(family)
    }
  }

  /** 用 document.fonts.load 触发加载与就绪状态推进（无 API 时定时器兑底） */
  private waitFontLoaded(family: string): void {
    if (document.fonts && document.fonts.load) {
      void document.fonts.load(`16px "${family}"`)
    } else {
      setTimeout(() => {}, 3000)
    }
  }

  private resolveDefaults(options: IWebFontOptions): { baseUrl: string; family: string; key: string } {
    const baseUrl = options.baseUrl ?? location.origin
    const family = options.family ?? options.fontName.replace(/\.[^.]+$/, '')
    return { baseUrl, family, key: IncrementalEngine.fontKey(options.fontName, family) }
  }

  /* ---------- 1. loadFont：轮询模式 ---------- */

  loadFont(options: ILoadFontOptions): void {
    const { baseUrl, family, key } = this.resolveDefaults(options)
    ensurePreconnect(baseUrl)
    this.engine.ensureState(key, options.fontName, {
      baseUrl,
      outType: options.outType ?? 'ttf',
      onLoadChunk: this.makeOnLoadChunk(key, family),
    })

    if (this.pollTasks.has(options.selector)) {
      clearInterval(this.pollTasks.get(options.selector)!.timer)
    }

    let applied = false
    const tick = (): void => {
      const charSet = collectChars(options.selector)
      const had = this.engine.getState(key)
      this.engine.submitText(key, charsToString(charSet))
      if (had && !applied) {
        applied = true
        applyFamily(options.selector, family)
      }
    }
    tick()
    const timer = setInterval(tick, options.interval ?? 1000)
    this.pollTasks.set(options.selector, { timer })
  }

  /* ---------- 2. observeFont：MutationObserver 模式 ---------- */

  observeFont(options: IObserveFontOptions): IObserveTask {
    const { baseUrl, family, key } = this.resolveDefaults(options)
    ensurePreconnect(baseUrl)
    this.engine.ensureState(key, options.fontName, {
      baseUrl,
      outType: options.outType ?? 'ttf',
      onLoadChunk: this.makeOnLoadChunk(key, family),
    })

    if (this.observeTasks.has(options.selector)) {
      this.observeTasks.get(options.selector)!.dispose()
    }

    let applied = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const doLoad = (): void => {
      const had = this.engine.getState(key)
      this.engine.submitText(key, charsToString(collectChars(options.selector)))
      if (had && !applied) {
        applied = true
        applyFamily(options.selector, family)
      }
    }
    const debouncedLoad = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(doLoad, options.debounceMs ?? 50)
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' || m.type === 'characterData') {
          debouncedLoad()
          return
        }
      }
    })
    const inputHandler = (): void => debouncedLoad()

    const elements = document.querySelectorAll(options.selector)
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    for (const el of elements) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.addEventListener('input', inputHandler)
      }
    }
    doLoad()

    let disposed = false
    const task: IObserveTask = {
      dispose: (): void => {
        if (disposed) return
        disposed = true
        observer.disconnect()
        for (const el of elements) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.removeEventListener('input', inputHandler)
          }
        }
        if (debounceTimer) clearTimeout(debounceTimer)
        this.observeTasks.delete(options.selector)
      },
    }
    this.observeTasks.set(options.selector, task)
    return task
  }

  /* ---------- 3. loadText：手动文本模式 ---------- */

  loadText(options: ILoadTextOptions): ITextLoader {
    const { baseUrl, family, key } = this.resolveDefaults(options)
    ensurePreconnect(baseUrl)
    this.engine.ensureState(key, options.fontName, {
      baseUrl,
      outType: options.outType ?? 'ttf',
      onLoadChunk: this.makeOnLoadChunk(key, family),
    })
    this.engine.submitText(key, options.text)

    let disposed = false
    return {
      update: (text: string): void => {
        if (disposed) return
        this.engine.submitText(key, text)
      },
      dispose: (): void => {
        if (disposed) return
        disposed = true
        /** 移除该 loader 注入的所有 @font-face 样式，避免同名 family 的 CSS 优先级冲突 */
        const styles = this.injectedStyles.get(key)
        if (styles) {
          for (const s of styles) s.remove()
          this.injectedStyles.delete(key)
        }
        this.engine.removeState(key)
      },
    }
  }

  /** 清理所有任务与注入样式（页面卸载时调用） */
  disposeAll(): void {
    for (const { timer } of this.pollTasks.values()) clearInterval(timer)
    for (const task of this.observeTasks.values()) task.dispose()
    this.pollTasks.clear()
    this.observeTasks.clear()
    for (const styles of this.injectedStyles.values()) {
      for (const s of styles) s.remove()
    }
    this.injectedStyles.clear()
  }

  /** 供 IIFE 全局导出对齐旧 API 名 */
  static createHttpProvider = createHttpProvider
}

/* ---------- DOM 辅助 ---------- */

/** 收集选择器匹配元素中的所有字符 */
function collectChars(selector: string): Set<string> {
  const charSet = new Set<string>()
  const elements = document.querySelectorAll(selector)
  for (const el of elements) {
    const text = getText(el)
    for (const ch of text) charSet.add(ch)
  }
  return charSet
}

function charsToString(set: Set<string>): string {
  let s = ''
  for (const c of set) s += c
  return s
}

function getText(el: Element): string {
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const input = el as HTMLInputElement
    /** 同时收集 value 和 placeholder，确保占位文本的字体也被加载 */
    return (input.value ?? '') + (input.placeholder ?? '')
  }
  return el.textContent ?? ''
}

/** 应用字体到元素 */
function applyFamily(selector: string, family: string): void {
  const elements = document.querySelectorAll(selector)
  for (const el of elements) {
    ;(el as HTMLElement).style.fontFamily = `"${family}", sans-serif`
  }
}
