/**
 * leafer-x-webfont —— LeaferJS 字体按需加载插件
 *
 * 原理：Leafer 的 Text 元素渲染时直接拼 `canvas.font = fontFamily`，
 * 依赖浏览器字体系统。大字体（尤其中文字体 10MB+）无法直接注册。
 * 本插件订阅画布内 Text 的 text / fontFamily 变化，把「实际用到的字符」
 * 交给 webfont-sdk（FontFace 模式）增量加载：fetch 子集 buffer →
 * FontFace(unicodeRange) 注册 → forceRender 重绘。
 *
 * 去重 / 并发池 / 失败字符记忆 / provider 抽象全部在 webfont-sdk 引擎层实现，
 * 本插件只做 Leafer 桥接：
 *   - 树扫描（walk）聚合同 family 字符
 *   - property.change + layout.end 事件订阅（防抖）
 *   - fontFamily 规范化改写（'xx.ttf' → 'xx'，canvas font 串要求合法标识符）
 *   - 片段就绪后 forceRender
 *
 * 用法：
 * ```ts
 * import { Leafer, Text } from 'leafer-ui'
 * import { WebFontPlugin } from 'leafer-x-webfont'
 *
 * const leafer = new Leafer({ view: window })
 * const webfont = new WebFontPlugin(leafer)
 * leafer.add(new Text({ text: '静心茶舍', fontFamily: '令东齐伋复刻体.ttf', fontSize: 64 }))
 * // 字体到位后画布自动重渲染；导出前 await webfont.ready()
 * ```
 */
import { WebFontFontFaceMode, type IFontFaceLoader } from 'webfont-sdk'

/** 插件配置 */
export interface IWebFontPluginConfig {
  /** 子集化服务基地址，默认官方在线服务 */
  baseUrl?: string
  /**
   * fontFamily 属性的解析规则：
   * - 不传（默认）：任意 fontFamily 值（如 '令东齐伋复刻体.ttf'、'霞鹜文楷'）都尝试向 API 请求；
   *   失败字符自动记忆不重试（webfont-sdk 引擎层），不阻塞渲染
   * - 传入函数则完全自定义：返回 null 表示不处理该字体
   */
  resolveFont?: (fontFamily: string) => string | null
  /** 请求子集时的输出格式 */
  outType?: 'woff2' | 'ttf'
  /** 文本变化防抖（ms），打字场景避免每敲一键发一次请求 */
  debounceMs?: number
  /**
   * 初始全量扫描后，是否持续监听画布变化（默认 true）。
   * 关闭后仅处理创建时已存在的文本，适合静态海报导出
   */
  watch?: boolean
  /** 是否在控制台输出调试日志 */
  debug?: boolean
  /**
   * 是否自动把节点 fontFamily 改写为合法 CSS family 名（去掉 .ttf 等后缀）。
   * 默认 true：canvas font 解析不认带扩展名的 family，不改写会静默回退系统字体
   */
  rewriteFamily?: boolean
}

/** fontFamily 里的文件后缀（注册 FontFace / CSS 都不认） */
const FONT_EXT_RE = /\.(ttf|otf|woff2?|ttc)$/i
/** 泛型族名没有对应字体文件，跳过 */
const GENERIC_FAMILY_RE = /^(sans-serif|serif|monospace|caption|system-ui|cursive|fantasy)$/i

/** Leafer 节点最小结构（避免硬依赖 leafer-ui 类型，保持 peerDep 可选） */
interface ILeaferNode {
  __tag?: string
  text?: unknown
  fontFamily?: unknown
  children?: unknown
  destroyed?: boolean
  forceRender?: () => void
  /** on_ 为公开事件订阅（返回 id）；旧版 leafer 用 on__（下划线为内部 id 绑定） */
  on_?: (type: string, listener: (e: unknown) => void, bind?: unknown) => number
  off_?: (ids: number[]) => void
  /** 旧版 API 兼容（on__ 在新版本已更名 on_） */
  on__?: (type: string, listener: (e: unknown) => void, bind?: unknown) => number
  off__?: (ids: number[]) => void
  waitViewReady?: (cb: () => void) => void
}

export class WebFontPlugin {
  /** 宿主 Leafer 实例 */
  private leafer: ILeaferNode | null
  private config: Required<Pick<IWebFontPluginConfig, 'debounceMs' | 'watch' | 'debug' | 'rewriteFamily'>> &
    IWebFontPluginConfig

  /** SDK FontFace 模式（增量引擎在这层：去重/并发/失败记忆） */
  private mode: WebFontFontFaceMode
  /** family -> 增量加载器（由 SDK 管理） */
  private loaders = new Map<string, IFontFaceLoader>()
  /** 防抖定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 解绑事件用的 id 列表 */
  private eventIds: number[] = []
  /** 统一的事件解绑函数（on_/off_ 新旧版别名解析后的句柄） */
  private offEvents: ((ids: number[]) => void) | null = null

  constructor(leafer: ILeaferNode, config: IWebFontPluginConfig = {}) {
    this.leafer = leafer
    this.config = {
      debounceMs: config.debounceMs ?? 120,
      watch: config.watch ?? true,
      debug: config.debug ?? false,
      rewriteFamily: config.rewriteFamily ?? true,
      baseUrl: config.baseUrl,
      outType: config.outType,
      resolveFont: config.resolveFont,
    }

    this.mode = new WebFontFontFaceMode({
      baseUrl: config.baseUrl,
      provider: null,
    })

    this.bindEvents()
    /** 画布初始化完成后做一次全量扫描 */
    leafer.waitViewReady?.(() => this.scan())
  }

  /* ============================================================
   * 事件绑定 —— 监听 Text 属性变化与新增节点
   * ============================================================ */

  private bindEvents(): void {
    if (!this.config.watch) return

    /**
     * 事件订阅：新版 leafer-ui 是 on_/off_，旧版为 on__/off__。
     * 统一收敛到 on_/off_ 两个别名上，构造时一次性解析。
     */
    const leafer = this.leafer!
    const on = leafer.on_ ?? leafer.on__
    const off = leafer.off_ ?? leafer.off__
    this.offEvents = off ? (ids) => off.call(leafer, ids) : null

    /**
     * Leafer 的属性变化事件（PropertyEvent.CHANGE = 'property.change'）由每个 Leaf
     * 直接 emit 到 leafer 根节点（见 leafer 源码 LeafDataProxy.emitPropertyEvent：
     * `leafer.emitEvent(event)`），在根上监听即可捕获所有子元素的 text / fontFamily
     * 变化。用字符串而非导入常量，保持对 leafer-ui 的 peerDep 可选。
     */
    this.eventIds.push(
      on!.call(leafer, 'property.change', (e) => {
        const ev = e as { attrName?: string }
        if (ev.attrName === 'text' || ev.attrName === 'fontFamily') {
          this.schedule()
        }
      }),
    )

    /** 布局结束（新增/删除节点都会触发布局）——覆盖新增 Text、海报模板切换等场景 */
    this.eventIds.push(
      on!.call(leafer, 'layout.end', () => this.schedule()),
    )
  }

  /* ============================================================
   * 扫描与调度
   * ============================================================ */

  /** 全量扫描画布中所有 Text 的 text + fontFamily，按 family 聚合新字符 */
  private scan(): void {
    const groups = new Map<string, { loader: IFontFaceLoader; fontName: string; family: string; chars: Set<string> }>()

    const walk = (node: ILeaferNode | null | undefined): void => {
      if (!node || node.destroyed) return
      const isText = node.__tag === 'Text' || (typeof node.text === 'string' && typeof node.fontFamily === 'string')
      if (isText) {
        const fontFamily: string = node.fontFamily as string
        const text: string = String(node.text ?? '')
        if (fontFamily && text) {
          const fontName = this.resolveFontName(fontFamily)
          if (fontName) {
            const family = normalizeFamily(fontName)
            const entry = getOrCreate(groups, family, () => ({ loader: this.getLoader(fontName, family), fontName, family, chars: new Set() }))
            /** 自动改写节点 fontFamily 为合法 CSS 名（canvas font 串要求） */
            if (this.config.rewriteFamily && node.fontFamily !== family) {
              ;(node as { fontFamily: string }).fontFamily = family
            }
            for (const ch of text) entry.chars.add(ch)
          }
        }
      }
      const children = node.children
      if (Array.isArray(children)) {
        for (const child of children as ILeaferNode[]) walk(child)
      }
    }

    walk(this.leafer)

    for (const [, { loader, chars }] of groups) {
      loader.update(charsToString(chars))
    }
  }

  /** 防抖触发扫描 */
  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.scan()
    }, this.config.debounceMs)
  }

  /* ============================================================
   * 字体解析与加载器管理
   * ============================================================ */

  /**
   * 解析 fontFamily：决定是否需要走子集化。
   * 用户自定义 resolveFont 优先；默认策略是「非泛型族名都尝试」。
   */
  private resolveFontName(fontFamily: string): string | null {
    if (this.config.resolveFont) return this.config.resolveFont(fontFamily)
    if (GENERIC_FAMILY_RE.test(fontFamily.trim())) return null
    return fontFamily
  }

  /** 获取（或创建）family 对应的 SDK 增量加载器；注册成功后重绘画布 */
  private getLoader(fontName: string, family: string): IFontFaceLoader {
    let loader = this.loaders.get(family)
    if (!loader) {
      loader = this.mode.loadFontFace(
        { fontName, family },
        () => {
          /** 字体注册成功后强制重绘整个画布（文本 metrics 需要重新计算） */
          this.leafer?.forceRender?.()
        },
      )
      this.loaders.set(family, loader)
      this.log('new font loader:', fontName, '->', family)
    }
    return loader
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) console.log('[leafer-x-webfont]', ...args)
  }

  /* ============================================================
   * 公开 API
   * ============================================================ */

  /** 立即做一次全量扫描（外部手动改完画布内容后调用） */
  public refresh(): void {
    this.scan()
  }

  /**
   * 等待当前所有待加载字体就绪（用于导出图片前）：
   * ```ts
   * await webfont.ready()
   * const blob = await leafer.export('png')
   * ```
   * 引擎层在「请求 + FontFace 注册」都完成后才算就绪，导出不会丢字体
   */
  public async ready(): Promise<void> {
    await this.mode.ready()
  }

  /** 已加载（或加载中）的字体 family 列表（调试 / 状态展示用） */
  public get families(): string[] {
    return [...this.loaders.keys()]
  }

  /** 销毁插件（解绑事件、丢弃加载器；FontFace 保留在 document.fonts 供继续渲染） */
  public destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.offEvents?.(this.eventIds)
    this.eventIds.length = 0
    this.offEvents = null
    for (const loader of this.loaders.values()) loader.dispose()
    this.loaders.clear()
    this.leafer = null
  }
}

/* ============================================================
 * 辅助函数
 * ============================================================ */

/** fontFamily 原始值 -> 合法 CSS family 名（去除文件后缀与首尾空白） */
function normalizeFamily(fontFamily: string): string {
  return fontFamily.replace(FONT_EXT_RE, '').trim()
}

/** Map 的 get-or-create 惯用封装 */
function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let v = map.get(key)
  if (!v) {
    v = create()
    map.set(key, v)
  }
  return v
}

/** 字符集合 -> 字符串（保持插入序，便于日志与请求参数稳定） */
function charsToString(set: Set<string>): string {
  let s = ''
  for (const c of set) s += c
  return s
}
