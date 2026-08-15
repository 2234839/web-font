/**
 * 构建后同步脚本：把 IIFE 产物带用法 banner 写入主站 public/webfont-sdk.js
 * index.html 引用 /webfont-sdk.js?v=%BUILD_TIME%，产物路径不变、零改动。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = resolve(pkgRoot, 'dist-iife/iife.iife.js')
const target = resolve(pkgRoot, '../../public/webfont-sdk.js')

const banner = `/**
 * WebFont SDK — 按需增量加载字体片段，无闪烁（本文件由 packages/webfont-sdk 构建，勿手改）
 *
 * 架构：核心增量引擎 + 两种注册模式
 *   - 核心：IncrementalEngine 按 fontKey 管理字符集，只请求增量；失败字符自动记忆不重试
 *   - CSS 模式（WebFont）：loadFont（轮询）/ observeFont（DOM 事件）/ loadText（手动传文本）
 *   - FontFace 模式（WebFontCanvas）：Canvas/canvas 场景，FontFace + unicodeRange 注册
 *
 * 用法：
 *   // 轮询模式
 *   WebFont.loadFont({ fontName, selector, family, interval });
 *
 *   // 事件驱动模式
 *   var obs = WebFont.observeFont({ fontName, selector, family });
 *   obs.dispose();
 *
 *   // 直接传文本模式
 *   var loader = WebFont.loadText({ fontName, text: "你好世界", family });
 *   loader.update("追加文字");
 *   loader.dispose();
 *
 *   // Canvas 模式（leafer / 原生 canvas）
 *   var face = WebFontCanvas.loadFontFace({ fontName }, function (chunk) { 在此重绘 });
 *   face.update("画布上的文字");
 *   await WebFontCanvas.ready();
 */

`

writeFileSync(target, banner + readFileSync(source, 'utf8'))
console.log(`synced: ${target} (from ${source})`)
