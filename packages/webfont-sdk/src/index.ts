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
import { WebFontCSSMode } from './css-mode'
import { WebFontFontFaceMode } from './fontface-mode'

export { WebFontCSSMode, WebFontFontFaceMode }
export { IncrementalEngine, createHttpProvider } from './engine'
export type { SubsetProvider, LoadedChunk, IFontState, IEngineConfig } from './engine'
export { NodeFontRegistry, loadGlobalFonts, isNodeEnvironment } from './node-registry'
export type { IGlobalFontsLike, INodeRegistryEntry } from './node-registry'
export type {
  IWebFontOptions, ILoadFontOptions, IObserveFontOptions, ILoadTextOptions,
  ITextLoader, IObserveTask,
} from './css-mode'
export type { IFontFaceOptions, IFontFaceLoader } from './fontface-mode'

/**
 * CSS 模式默认实例 —— 与旧 webfont-sdk.js 的全局 WebFont 对象 API 兼容
 */
export const WebFont = new WebFontCSSMode()

/** FontFace 模式默认实例（Canvas 场景） */
export const WebFontCanvas = new WebFontFontFaceMode()
