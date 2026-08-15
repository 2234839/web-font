/**
 * 真实 leafer 环境增量路径验证
 *
 * 桩测试（_prof_million.entry.ts）验证调度逻辑，本测试验证真实 leafer
 * 事件驱动链路：真实 @leafer-ui/node + 真实 HTTP 子集 API（localhost:8087）
 *   1. 新增 Text（child.add 子树入脏集）→ 自动触发子集请求
 *   2. 改 text（property.change 增量）→ 只提交新字符
 *   3. 不调 refresh() 的全自动路径（验证事件驱动，非手动全量）
 *
 * 运行：npx tsx scripts/test-leafer-incremental.mts
 * 前置：pnpm dev:backend（8087）
 */
import { Leafer, Text, Group, useCanvas } from '@leafer-ui/node'
import { Canvas as NapiCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'

/** 必须在创建任何 Leafer 实例之前初始化 napi canvas 平台 */
useCanvas('napi', { Canvas: NapiCanvas, loadImage })

const { WebFontPlugin } = await import('../packages/leafer-x-webfont/src/index.ts')

const BASE_URL = 'http://localhost:8087'

async function main(): Promise<void> {
  console.log('=== 真实 leafer 增量路径验证 ===\n')

  let fetchCount = 0
  const realFetch = globalThis.fetch
  /** 劫持 fetch 计数子集请求数 */
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api?font=')) fetchCount++
    return realFetch(input as never, init as never)
  }) as typeof fetch

  const leafer = new Leafer({ width: 400, height: 300, fill: '#ffffff' })
  const webfont = new WebFontPlugin(leafer as never, { baseUrl: BASE_URL, debounceMs: 0, debug: false })

  /* ---------- 1. 事件驱动初始化（不调 refresh，纯 waitViewReady 初始 scan） ---------- */
  const text1 = new Text({ text: '静心', fontFamily: '令东齐伋复刻体.ttf', fontSize: 64, fill: '#000', x: 20, y: 20 })
  leafer.add(text1)
  await webfont.ready()
  console.log(`[1] 初始 Text（waitViewReady 全量 scan）: fetch=${fetchCount}, updateCalls=${webfont.updateCalls}`)
  console.log(`[1] fontFamily 改写: ${JSON.stringify(text1.fontFamily)}`)

  /* ---------- 2. property.change 增量：改文字只提交新字符 ---------- */
  const before = fetchCount
  text1.text = '静心茶舍新'
  await new Promise((r) => setTimeout(r, 300))
  console.log(`[2] 改 text（property.change 增量）: 新增 fetch=${fetchCount - before}, updateCalls=${webfont.updateCalls}`)
  console.log(`[2] fontFamily 链: ${JSON.stringify(text1.fontFamily)}`)

  /* ---------- 3. child.add 增量：新增 Text 自动捕获 ---------- */
  const before3 = fetchCount
  const text2 = new Text({ text: '新品上市', fontFamily: '令东齐伋复刻体.ttf', fontSize: 32, fill: '#333', x: 20, y: 120 })
  leafer.add(text2)
  await new Promise((r) => setTimeout(r, 300))
  console.log(`[3] 新增 Text（child.add 增量）: 新增 fetch=${fetchCount - before3}, updateCalls=${webfont.updateCalls}`)

  /* ---------- 4. Group 子树新增（验证子树 walk） ---------- */
  const before4 = fetchCount
  const group = new Group()
  group.add(new Text({ text: '全场八折', fontFamily: '令东齐伋复刻体.ttf', fontSize: 24, fill: '#666', x: 20, y: 180 }))
  leafer.add(group)
  await new Promise((r) => setTimeout(r, 300))
  console.log(`[4] 新增 Group 子树（子树 walk）: 新增 fetch=${fetchCount - before4}, updateCalls=${webfont.updateCalls}`)

  /* ---------- 5. 无文字变化：拖拽模拟（改 x/y 不触发 update） ---------- */
  const before5 = fetchCount
  const calls5 = webfont.updateCalls
  for (let i = 0; i < 50; i++) {
    text1.x = 20 + i
    await new Promise((r) => setTimeout(r, 2))
  }
  await new Promise((r) => setTimeout(r, 300))
  console.log(`[5] 拖拽 50 次（无文字变化）: 新增 fetch=${fetchCount - before5}, 新增 updateCalls=${webfont.updateCalls - calls5}`)

  /* ---------- 6. 导出验证 ---------- */
  await webfont.ready()
  const out = (await leafer.export('png', { pixelRatio: 1 })) as { data: string }
  console.log(`[6] 导出 PNG: ${Math.round(out.data.length / 1024)}KB (base64)`)

  globalThis.fetch = realFetch
  webfont.destroy()
  leafer.destroy()
  console.log('\n=== 验证完成 ===')
}

await main()
