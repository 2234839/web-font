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
 *   - 树扫描（walk）聚合同 family 字符，按 family 内容指纹短路无变化的重算
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
   * 自定义子集请求器（provider 抽象透传给 webfont-sdk）。
   * 默认走 HTTP API；测试、私有部署、离线场景可替换
   */
  provider?: ((fontName: string, text: string, outType?: string) => Promise<{ url: string; format: string }>) | null
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

/**
 * 脏节点溢出阈值：未 flush 脏节点超过该数（如模板整体替换）时
 * 全量 walk 反而更省（Set 遍历退化），flush 退化为全量。
 * 千级节点海报全量 walk 仅 ~1ms，阈值取个稳妥小值即可
 */
const FULL_SCAN_DIRTY_THRESHOLD = 512

/**
 * family 聚合桶：chars 为本轮字符集，nodes 为贡献节点（注册成功后回记
 * 脏集——只有这些节点可能用到新 chunk，链应用范围从全树缩小到贡献者）
 */
interface IGroup {
  loader: IFontFaceLoader
  fontName: string
  family: string
  chars: Set<string>
  nodes: ILeaferNode[]
  /** 贡献者超过阈值：注册后直接 dirtyAll（全量应用链更省） */
  overflow: boolean
}

/** Leafer 节点最小结构（避免硬依赖 leafer-ui 类型，保持 peerDep 可选） */
interface ILeaferNode {
  __tag?: string
  text?: unknown
  fontFamily?: unknown
  children?: unknown
  destroyed?: boolean
  forceRender?: () => void  /** 代理数据标记：leafer 编辑器场景节点属性存 proxy（__ 直写会丢），存在时静默写回退 setter */
  __proxyData?: unknown  /** on_ 为公开事件订阅（返回 id）；旧版 leafer 用 on__（下划线为内部 id 绑定） */
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
  /**
   * family -> 上次提交给 loader 的字符集串（内容指纹）。
   * 拖拽/缩放等操作每帧触发布局，内容没变时靠它短路掉
   * 「字符集收集 + loader.update 内部 diff」这两个大头，update 调用归零。
   * 存字符串本身而非 hash：比较成本是 memcmp 级且零碰撞风险
   */
  private committed = new Map<string, string>()
  /** 防抖定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 解绑事件用的 id 列表 */
  private eventIds: number[] = []
  /** 统一的事件解绑函数（on_/off_ 新旧版别名解析后的句柄） */
  private offEvents: ((ids: number[]) => void) | null = null
  /**
   * 脏节点集（增量模式核心）：property.change 的 target、child.add 的整棵子树。
   * flush 时只 walk 这些节点，把 O(全树) 降为 O(改动)。
   * Leafer 渲染管线自身就靠这套事件驱动（trackChanges 分支），
   * 凡是被画出来的文字变化必然经过这里——增量不会漏
   */
  private dirty = new Set<ILeaferNode>()
  /** 整树结构变化（首次扫描/模板替换）时置位，flush 退化为全量 walk */
  private dirtyAll = false
  /**
   * 待应用 chunk 链的 family → 链值（Node 模式）。
   * 字体注册成功的回调里不再立即全树改写——百万节点下百万次 fontFamily
   * 赋值会触发百万次 property.change，把 dirty 集污染成全量（实测打字场景
   * 退化到 20s）。改为标记待应用，下一次 walk（scan/flush）时顺路写入
   * 目标节点，零额外遍历。注册后仅 forceRender 触发重绘
   */
  private pendingChains = new Map<string, { chain: string; silent: boolean }>()
  /**
   * family → 待应用的贡献节点（合并累加，不覆盖：前一轮 commit 的节点
   * 在其 chunk 迟到时仍需要链，覆盖会丢节点导致字符回退系统字体）。
   * chunk 回调后清除。溢出（贡献者>阈值，如初始全量）时 silent 全量应用
   */
  private pendingApply = new Map<string, { nodes: ILeaferNode[]; overflow: boolean }>()
  /** 字体就绪待重绘（或本轮 flush 有链静默落地）；无 in-flight chunk 时尾部一次 forceRender */
  private renderPending = false

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
      provider: config.provider ?? null,
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
     * 事件携带 target / attrName / oldValue / newValue（PropertyEvent 五参构造），
     * 增量模式下只需把 target 记入脏节点集，flush 时精确收集该节点的字符
     */
    this.eventIds.push(
      on!.call(leafer, 'property.change', (e) => {
        const ev = e as { attrName?: string; target?: ILeaferNode }
        if (ev.attrName === 'text' || ev.attrName === 'fontFamily') {
          if (ev.target) {
            /** 增量路径：只记脏节点，不触发全量调度 */
            this.dirty.add(ev.target)
            this.schedule()
          } else {
            this.dirtyAll = true
            this.schedule()
          }
        }
      }),
    )

    /**
     * 子树增删（ChildEvent.ADD/REMOVE = 'child.add'/'child.remove'）：携带 child。
     * 新节点的初始属性是构造期直接写入 data，不走 setAttr，不触发 property.change；
     * 因此新增必须整棵子树入脏集（子树内可能包含任意深度的 Text）。
     * 删除的节点下次 walk 时靠 destroyed 标记跳过，无需单独处理
     */
    for (const type of ['child.add', 'child.remove'] as const) {
      this.eventIds.push(
        on!.call(leafer, type, (e) => {
          const ev = e as { child?: ILeaferNode }
          if (ev.child) {
            this.dirty.add(ev.child)
            this.schedule()
          } else {
            this.dirtyAll = true
            this.schedule()
          }
        }),
      )
    }

    /**
     * 不订阅 layout.end：它每帧触发（拖拽/缩放也算布局），百万节点画布上
     * 周期性全量 walk 会造成持续卡顿。结构与属性变化已由上面两个事件完整
     * 覆盖——这正是 Leafer 自家 Watcher 的订阅集（源码 __listenEvents：
     * [property.change] + [child.add, child.remove]），渲染可靠 = 事件可靠。
     * 绕过事件直接改 __.text 的场景请手动调 refresh()
     */
  }

  /* ============================================================
   * 扫描与调度
   * ============================================================ */

  /** 判定节点是否 Text（__tag 或鸭子类型双保险，兼容第三方 Text 实现） */
  private isTextNode(node: ILeaferNode): boolean {
    return node.__tag === 'Text' || (typeof node.text === 'string' && typeof node.fontFamily === 'string')
  }

  /**
   * 收集单个 Text 节点的字符进聚合桶（含 fontFamily 规范化改写）。
   * 全量 walk 与增量 flush 共用，保证两条路径行为一致
   */
  private collect(groups: Map<string, IGroup>, node: ILeaferNode): void {
    const fontFamily: string = node.fontFamily as string
    const text: string = String(node.text ?? '')
    if (!fontFamily || !text) return
    const fontName = this.resolveFontName(fontFamily)
    if (!fontName) return
    const family = normalizeFamily(fontName)
    const entry = getOrCreate(groups, family, () => ({ loader: this.getLoader(fontName, family), fontName, family, chars: new Set<string>(), nodes: [], overflow: false }))
    if (!entry.overflow) {
      if (entry.nodes.length >= FULL_SCAN_DIRTY_THRESHOLD) entry.overflow = true
      else entry.nodes.push(node)
    }
    /**
     * 待应用链优先（新注册 chunk 链），其次规范化改写（去 .ttf 后缀）。
     * 写入方式按 pendingChains 的 silent 标记分流：
     * - 静默写（直接写 __ 数据层）：溢出/初始全量场景，公共 setter 的完整
     *   属性变更管线百万次 = 实测 2.2s 风暴；静默写 ~50ns/次，且 family 名
     *   替换不改字形 metrics（同一字体子集），bounds 不变无需重排
     * - 公共 setter：少量贡献者（打字等），leafer 自己会失效重绘该节点，
     *   无需 forceRender
     * 静默写不触发重绘，由 flush 尾部统一 forceRender 补上
     */
    const pending = this.pendingChains.get(family)
    if (pending && node.fontFamily !== pending.chain) {
      if (pending.silent) {
        this.writeFamilySilently(node, pending.chain)
        this.renderPending = true
      } else {
        /** 公共 setter：leafer 自动失效并局部重绘该节点，无需 forceRender */
        ;(node as { fontFamily: string }).fontFamily = pending.chain
      }
    } else if (this.config.rewriteFamily && node.fontFamily !== family && !isChunkChain(fontFamily)) {
      if (pending?.silent) {
        this.writeFamilySilently(node, family)
        this.renderPending = true
      } else {
        ;(node as { fontFamily: string }).fontFamily = family
      }
    }
    for (const ch of text) entry.chars.add(ch)
  }

  /**
   * 静默写入 fontFamily（直接写 __ 数据层，不触发 property.change）。
   * leafer 渲染读的正是它（__getAttr → __.__get），下一帧生效；
   * 不触发事件 = 不污染 dirty 集 = 无风暴。若未来 leafer 改为只认
   * setter 路径，退化为公共 setter（行为仍正确，仅多一轮调度）
   */
  private writeFamilySilently(node: ILeaferNode, value: string): void {
    const data = (node as { __?: Record<string, unknown> }).__
    if (data && typeof data === 'object' && !node.__proxyData) {
      data.fontFamily = value
    } else {
      ;(node as { fontFamily: string }).fontFamily = value
    }
  }

  /** walk 子树收集 Text 字符：visited 防环/防重（脏子树交叉时幂等） */
  private walkInto(node: ILeaferNode | null | undefined, groups: Map<string, IGroup>, visited: Set<ILeaferNode>): void {
    if (!node || node.destroyed || visited.has(node)) return
    visited.add(node)
    if (this.isTextNode(node)) this.collect(groups, node)
    const children = node.children
    if (Array.isArray(children)) {
      for (const child of children as ILeaferNode[]) this.walkInto(child, groups, visited)
    }
  }

  /** 全量扫描（安全网）：初始扫描 / 脏节点溢出退化路径。直接调用时复位增量状态 */
  private scan(): void {
    this.dirtyAll = false
    const groups = new Map<string, IGroup>()
    this.walkInto(this.leafer, groups, new Set())
    this.commit(groups)
  }

  /** 提交聚合桶：内容指纹短路（字符串精确相等），无变化时 loader.update 调用归零 */
  private commit(groups: Map<string, IGroup>): void {
    for (const [family, entry] of groups) {
      /** 指纹相等 = 这段字符集已提交过（SDK 三态过滤兜底），跳过本次 update */
      const collected = charsToString(entry.chars)
      if (this.committed.get(family) === collected) continue
      this.committed.set(family, collected)
      /** 贡献者合并累加（不覆盖）：迟到的 chunk 仍能找到它的贡献节点 */
      const prev = this.pendingApply.get(family)
      this.pendingApply.set(family, {
        nodes: prev ? prev.nodes.concat(entry.nodes) : entry.nodes,
        overflow: (prev?.overflow ?? false) || entry.overflow,
      })
      this.updateCalls++
      entry.loader.update(collected)
    }
  }

  /** 累计实际提交给 loader 的 update 次数（性能/调试指标：指纹短路越有效增长越慢） */
  public updateCalls = 0
  /**
   * 调度一次防抖 flush：窗口内已有待触发任务时直接复用（trailing 语义）。
   * 不用 clear+set 重置式 debounce：百万节点初始改写会触发百万次事件，
   * 重置式每次都 clear+set（~1μs/次，累计秒级浪费）；且 trailing 保证
   * 连续打字时每 debounceMs 必有一次 flush（字体更及时），不会无限推迟
   */
  private schedule(): void {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flush()
    }, this.config.debounceMs)
  }

  /** flush：增量 walk 脏节点集（或 dirtyAll 时全量），链落地后尾部统一重绘 */
  private flush(): void {
    /** 脏节点积累过多（如模板整体替换）：全量 walk 一次更省，顺带复位增量状态 */
    if (this.dirtyAll || this.dirty.size > FULL_SCAN_DIRTY_THRESHOLD) {
      this.dirty.clear()
      this.dirtyAll = false
      this.scan()
    } else {
      const groups = new Map<string, IGroup>()

      /** 每次 flush 的 visited 必须新建：跨 flush 的同一节点内容可能已变 */
      const visited = new Set<ILeaferNode>()
      for (const node of this.dirty) {
        /** 脏节点本身 + 其子树都可能有 Text：child.add 只给根，子节点构造期赋值无事件 */
        this.walkInto(node, groups, visited)
      }
      this.dirty.clear()
      this.commit(groups)
    }
    /**
     * 字体就绪或有链静默落地：合并成一次 forceRender。
     * 仍有 in-flight chunk 时推迟（renderPending 保持 true），等最后一个
     * chunk 落地后一并重绘——否则每个 chunk 回调都全画布重绘一次，
     * 百万节点下 N 个 chunk = N 次秒级重绘
     */
    if (this.renderPending && !this.hasPendingLoads()) {
      this.renderPending = false
      this.leafer?.forceRender?.()
    }
  }

  /** 是否仍有 in-flight 的子集请求 */
  private hasPendingLoads(): boolean {
    for (const loader of this.loaders.values()) {
      if (loader.isPending()) return true
    }
    return false
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

  /** 获取（或创建）family 对应的 SDK 增量加载器；注册成功后按模式分流处理 */
  private getLoader(fontName: string, family: string): IFontFaceLoader {
    let loader = this.loaders.get(family)
    if (!loader) {
      loader = this.mode.loadFontFace(
        { fontName, family },
        () => {
          const chain = loader!.fontFamilyChain()
          const apply = this.pendingApply.get(family)
          if (chain) {
            /**
             * Node 模式：chunk 注册在 `${family}__N` 唯一名下，节点需链回退。
             * 溢出（初始全量等）→ 静默链 + dirtyAll，下轮全量 walk 顺路写；
             * 少量贡献者（打字）→ 公共 setter（leafer 自动失效重绘该节点）。
             * 不在这里立即全树改写（百万节点 O(全树) 风暴 + dirty 污染）
             */
            this.pendingChains.set(family, { chain, silent: !apply || apply.overflow })
            if (apply) {
              this.pendingApply.delete(family)
              if (apply.overflow) {
                this.dirtyAll = true
                /** 静默链路径：leafer 不知情，标记待重绘（尾部一次 forceRender） */
                this.renderPending = true
              } else {
                for (const n of apply.nodes) this.dirty.add(n)
              }
            }
          } else {
            /**
             * 浏览器模式（无链）：FontFace(unicodeRange) 就绪不触发画布重绘，
             * 标记待重绘，由 flush 尾部合并执行
             */
            this.renderPending = true
          }
          this.schedule()
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
    this.dirty.clear()
    this.scan()
  }

  /**
   * 立即执行一次增量 flush（跳过防抖等待）：emit 后同步验证、
   * 导出前能尽快提交新字符。自动调度下无需手动调用
   */
  public flushNow(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.flush()
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
    /**
     * 就绪语义闭环：字体/链全部落地后，同步消化残留的增量状态
     * （dirtyAll / renderPending / 未消化的贡献者）。否则它们会被下一个
     * 不相关的用户操作（如单点打字）捡走——百万节点下表现为「改一个字
     * 卡 800ms」的全量 scan。ready 语义就是分界线：调用前插件内部事可以
     * 慢慢消化，调用后外部预期画布已是终态
     */
    if (this.dirty.size > 0 || this.dirtyAll || this.renderPending) {
      this.flushNow()
      await this.mode.ready()
    }
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
    this.committed.clear()
    this.dirty.clear()
    this.dirtyAll = false
    this.leafer = null
  }
}

/* ============================================================
 * 辅助函数
 * ============================================================ */

/**
 * chunk family 后缀（Node 模式每 chunk 唯一 family：`base__0`、`base__1`…）。
 * 用于把链形态还原为 base family，避免 scan 把改写后的链当成新字体。
 */
const CHUNK_SUFFIX_RE = /__(\d+)$/

/**
 * 判断 fontFamily 是否已是 Node 模式改写后的 chunk 链形态
 *（含 `"base__0"` 引号或 `"base__0", "base__1"` 逗号链）。
 * scan 时遇到链形态直接跳过改写，防止链被抹回 base 名。
 */
function isChunkChain(fontFamily: string): boolean {
  return fontFamily.includes('__') && /__\d+["']?$/.test(fontFamily.split(',')[0]!.trim())
}

/**
 * fontFamily 原始值 -> 合法 CSS family 名。
 * - 去除文件后缀与首尾空白（含引号）
 * - Node 模式改写后的 chunk 链（`"base__0", "base__1"`）还原为 base 名，
 *   防止 scan 把链当作新 family 反复创建 loader（套娃 bug）
 */
function normalizeFamily(fontFamily: string): string {
  /** 取链首成员（逗号分隔），去掉首尾引号 */
  const first = fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, '')
  const bare = first.replace(FONT_EXT_RE, '').trim()
  return bare.replace(CHUNK_SUFFIX_RE, '')
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
