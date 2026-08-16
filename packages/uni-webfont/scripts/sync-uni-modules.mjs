/**
 * 构建后同步：把 dist-bundle 产物写入 uni_modules/gs-webfont/js_sdk/。
 * uni_modules 是 DCloud 插件市场的标准目录结构，HBuilderX 从这里读插件。
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const esm = resolve(pkgRoot, 'dist-bundle/index.js')
const iife = resolve(pkgRoot, 'dist-bundle/index.iife.js')
const targetDir = resolve(pkgRoot, '../../uni_modules/gs-webfont/js_sdk')
const dts = resolve(pkgRoot, 'dist/index.d.ts')

mkdirSync(targetDir, { recursive: true })

/**
 * ESM 版：uni-app CLI 工程（vite）直接 import 用。
 * 头部 banner 声明来源，提醒勿手改
 */
const banner = `/**
 * gs-webfont —— uni-app 字体按需加载（由 packages/uni-webfont 构建，勿手改）
 * 文档：https://webfont.shenzilong.cn
 */
`
writeFileSync(resolve(targetDir, 'index.js'), banner + readFileSync(esm, 'utf8'))
/** iife 版：HBuilderX 非 CLI 工程经 require/script 引入，挂全局 UniWebFontBundle */
copyFileSync(iife, resolve(targetDir, 'index.iife.js'))
/** d.ts：IDE 智能提示 */
copyFileSync(dts, resolve(targetDir, 'index.d.ts'))

console.log(`✓ synced → uni_modules/gs-webfont/js_sdk/`)
