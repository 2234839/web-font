/**
 * Node 端 leafer-x-webfont 集成测试
 *
 * 验证链路：@leafer-ui/node → WebFontPlugin 扫描 → webfont-sdk Node 模式
 * （HTTP 子集 API → GlobalFonts 唯一 family 注册 → fontFamily 链回退写回）
 * → Leafer 渲染导出 PNG → 与全量基准 SSIM 对比。
 *
 * 运行：npx tsx scripts/test-leafer-node.mts
 */
import { Leafer, Text, useCanvas } from '@leafer-ui/node'
import { Canvas as NapiCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'node:fs'

/** 必须在创建任何 Leafer 实例之前初始化 napi canvas 平台 */
useCanvas('napi', { Canvas: NapiCanvas, loadImage })

const { WebFontPlugin } = await import('../packages/leafer-x-webfont/src/index.ts')
const { fontSubset } = await import('../backend/font_util/font.ts')

/** 本地后端服务（8087 已运行） */
const BASE_URL = 'http://localhost:8087'
const FONT_FILE = 'font/令东齐伋复刻体.ttf'
const TEXT = '静心茶舍'
const OUT_DIR = 'benchmark_results/debug'

/** leafer.export('png') 返回 { data: 'data:image/png;base64,...', width, height } */
async function renderAndExport(family: string, outFile: string): Promise<number> {
  const leafer = new Leafer({ width: 400, height: 120, fill: '#ffffff' })
  leafer.add(new Text({ text: TEXT, fontFamily: family, fontSize: 64, fill: '#000000', x: 20, y: 20 }))
  await new Promise((r) => setTimeout(r, 200))
  const out = (await leafer.export('png', { pixelRatio: 1 })) as { data: string }
  const buf = Buffer.from(out.data.split(',')[1]!, 'base64')
  writeFileSync(outFile, buf)
  leafer.destroy()
  return buf.length
}

async function main(): Promise<void> {
  /* ---------- 1. 全量基准图：直接 GlobalFonts 注册（不经插件） ---------- */
  const full = readFileSync(FONT_FILE)
  const fullSubset = await fontSubset(full.buffer.slice(0), TEXT, { sourceType: 'ttf', outType: 'ttf' })
  GlobalFonts.register(new Uint8Array(fullSubset), 'BaselineFont')
  const baselineSize = await renderAndExport('BaselineFont', `${OUT_DIR}/node_leafer_baseline.png`)
  console.log('[1] 基准图:', baselineSize, 'bytes')

  /* ---------- 2. 插件链路：HTTP API + 增量 + 链回退 ---------- */
  const leafer = new Leafer({ width: 400, height: 120, fill: '#ffffff' })
  const webfont = new WebFontPlugin(leafer as never, { baseUrl: BASE_URL, debug: true })
  const text = new Text({ text: TEXT, fontFamily: '令东齐伋复刻体.ttf', fontSize: 64, fill: '#000000', x: 20, y: 20 })
  leafer.add(text)
  webfont.refresh()
  await webfont.ready()
  await new Promise((r) => setTimeout(r, 200))

  console.log('[2] 节点 fontFamily =', JSON.stringify(text.fontFamily))
  const chainOk = /__\d/.test(String(text.fontFamily))
  console.log('[2] fontFamily 链写回:', chainOk ? '✓' : '✗ 链未生效')

  await new Promise((r) => setTimeout(r, 200))
  const out = (await leafer.export('png', { pixelRatio: 1 })) as { data: string }
  const buf = Buffer.from(out.data.split(',')[1]!, 'base64')
  writeFileSync(`${OUT_DIR}/node_leafer_test.png`, buf)
  console.log('[2] 插件链路图:', buf.length, 'bytes')

  /* ---------- 3. SSIM 对比 ---------- */
  const { calculateSSIM } = await import('./ssim.ts')
  const { PNG } = await import('pngjs')
  const a = PNG.sync.read(readFileSync(`${OUT_DIR}/node_leafer_baseline.png`))
  const b = PNG.sync.read(readFileSync(`${OUT_DIR}/node_leafer_test.png`))
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`[3] 尺寸不一致: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
    return
  }
  const ssim = calculateSSIM(a.data, b.data, a.width, a.height)
  console.log(`[3] SSIM = ${ssim.toFixed(4)}`, ssim > 0.95 ? '✓ 通过' : '✗ 未达 0.95')

  webfont.destroy()
  leafer.destroy()
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})

