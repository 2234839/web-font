/**
 * Node 端字体注册器 —— @napi-rs/canvas GlobalFonts 适配层
 *
 * 背景约束（探针实证，见 benchmark_results/debug/ 或会话记录）：
 * 1. 同 family 二次 register 被忽略（Skia 命中首个实例，增量 chunk 丢失）
 * 2. remove(key) 后同 family 重注册结果异常（疑似 Skia 字体缓存干扰）
 * 3. woff2 buffer 可直接注册（虽然 register 返回 null，渲染正常）
 *
 * 因此采用「每 chunk 唯一 family + 逗号链回退」策略：
 * - 每个 chunk 注册为独立 family（`{base}__{n}`），永不复用
 * - 节点 fontFamily 改写为逗号分隔的 chunk family 链
 * - Skia 按字形粒度匹配：A 缺字自动落到 B，实测与单字体全量注册像素一致
 * - remove(key) 用注册返回的 FontKey 注销，单个 chunk 可独立卸载
 */
import type { LoadedChunk } from './engine'

/** @napi-rs/canvas 的 GlobalFonts 最小接口（避免硬依赖，保持 optional peerDep） */
export interface IGlobalFontsLike {
  register: (data: Uint8Array | ArrayBuffer, family: string) => unknown
  remove: (key: unknown) => boolean
}

/**
 * 动态 import 的模块 specifier（包未安装时不参与类型解析，运行时 catch 返回 null）。
 * 用变量间接引用，打包器不会尝试静态解析该路径。
 */
const NAPI_CANVAS_MODULE = '@napi-rs/canvas'

/** Node 注册器状态 */
export interface INodeRegistryEntry {
  /** chunk 索引（0 起） */
  index: number
  /** 唯一 family 名（`${base}__${n}`） */
  family: string
  /** register 返回的 FontKey（remove 用；woff2 注册时可能为 null） */
  fontKey: unknown
  /** chunk 字符集（dispose 时无需用，仅调试） */
  chars: string[]
}

/** 一个逻辑字体（用户视角的 family）的 Node 端注册表 */
export class NodeFontRegistry {
  /** 基础 family 名（用户设置的原始名，去后缀） */
  readonly base: string
  /** 已注册 chunk 列表（顺序即 fontFamily 链顺序） */
  private entries: INodeRegistryEntry[] = []
  /** family 名 -> entry（快速查重） */
  private familyIndex = new Map<string, INodeRegistryEntry>()
  /** 注入的 GlobalFonts（浏览器环境为 null，构造后由 ensure 注入） */
  private globalFonts: IGlobalFontsLike | null = null

  constructor(base: string) {
    this.base = base
  }

  /** 绑定 GlobalFonts（懒加载 @napi-rs/canvas 成功后调用） */
  bind(globalFonts: IGlobalFontsLike): void {
    this.globalFonts = globalFonts
  }

  /** 是否已绑定（未绑定时 registerChunk 会抛错） */
  get bound(): boolean {
    return this.globalFonts !== null
  }

  /**
   * 注册一个新 chunk：唯一 family 名 + 逗号链回退
   * @returns 新的 fontFamily 链（调用方把它设置到 Text 节点上）
   */
  registerChunk(chunk: LoadedChunk, buffer: Uint8Array): string {
    if (!this.globalFonts) throw new Error('NodeFontRegistry not bound to GlobalFonts')
    const index = this.entries.length
    const family = `${this.base}__${index}`
    const fontKey = this.globalFonts.register(buffer, family)
    const entry: INodeRegistryEntry = { index, family, fontKey, chars: chunk.chars }
    this.entries.push(entry)
    this.familyIndex.set(family, entry)
    return this.fontChain()
  }

  /**
   * 当前完整的 fontFamily 链（逗号分隔，带引号防中文名/特殊字符问题）：
   * `"base__0", "base__1", ...`
   * 最后追加原始 base 名（此时 base 未注册，仅作为语义占位/调试可读性）
   */
  fontChain(): string {
    if (this.entries.length === 0) return quote(this.base)
    return this.entries.map((e) => quote(e.family)).join(', ')
  }

  /** 已注册 chunk 数（调试用） */
  get size(): number {
    return this.entries.length
  }

  /**
   * 卸载全部 chunk（dispose 用）。
   * FontKey 为 null 的（woff2 首注册返回 null 的场景）跳过 remove。
   */
  dispose(): void {
    if (!this.globalFonts) return
    for (const entry of this.entries) {
      if (entry.fontKey != null) {
        try {
          this.globalFonts.remove(entry.fontKey)
        } catch {
          /** remove 失败不阻塞 dispose（字体可能已被外部清理） */
        }
}
    }
    this.entries.length = 0
    this.familyIndex.clear()
  }
}

/** family 名加引号（CSS font 串规范，中文名必须带引号） */
function quote(family: string): string {
  return `"${family}"`
}

/** 动态加载 @napi-rs/canvas 的 GlobalFonts（未安装/非 Node 环境返回 null） */
export async function loadGlobalFonts(): Promise<IGlobalFontsLike | null> {
  try {
    /** 动态 specifier：避免打包器静态解析（未安装时也能构建） */
    const specifier = NAPI_CANVAS_MODULE
    const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as {
      GlobalFonts?: IGlobalFontsLike
    }
    return mod.GlobalFonts ?? null
  } catch {
    return null
  }
}

/** 当前是否 Node 环境（无 document 且有 node 进程标记，用于模式分支） */
export function isNodeEnvironment(): boolean {
  const g = globalThis as { document?: unknown; process?: { versions?: { node?: string } } }
  return typeof g.document === 'undefined' && !!g.process?.versions?.node
}
