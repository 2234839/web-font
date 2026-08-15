/**
 * IIFE 入口 —— 构建为 public/webfont-sdk.js（script 标签直接引入）
 *
 * 全局暴露 WebFont，API 与历史版本完全兼容：
 *   WebFont.loadFont / observeFont / loadText / disposeAll /
 *   setMaxConcurrent / setSubsetProvider
 * 另暴露 WebFont.canvas（FontFace 模式，高级场景可用）。
 */
import { WebFont, WebFontCanvas } from './index'

const g = globalThis as unknown as {
  WebFont: typeof WebFont
  WebFontCanvas: typeof WebFontCanvas
  /** WebFont 上也挂一份 canvas 引用（WebFont.canvas.loadFontFace），方便 Canvas 场景一处取用 */
}
g.WebFont = WebFont
g.WebFontCanvas = WebFontCanvas
/** 补充别名：与文档注释一致，WebFont.canvas 即 FontFace 模式实例 */
;(WebFont as unknown as { canvas: typeof WebFontCanvas }).canvas = WebFontCanvas
