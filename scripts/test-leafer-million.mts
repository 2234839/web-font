/**
 * 真实 leafer 百万节点 + 文字变化 压测
 *
 * 与桩测试（_prof_million.entry.ts）的区别：用真实 @leafer-ui/node，
 * 走完整事件链（leafer 内部 emitPropertyEvent → 插件监听 → 增量 flush），
 * 验证真实事件风暴下的行为：
 *   1. 阶梯搭建 100k / 500k / 1M Text（真实节点对象、真实布局树）
 *   2. 初始全量 scan + rewriteFamily 风暴（每节点改写触发 property.change）
 *   3. 改单节点 text 的增量 flush 成本
 *   4. 连续打字模拟（同一节点高频改 text）
 *   5. 随机节点改动（模拟多人协作/批量替换）
 *   6. 全程监控 updateCalls / fetch 数（指纹短路 + SDK 去重）
 *
 * 运行：npx tsx scripts/test-leafer-million.mts
 * 前置：pnpm dev:backend（8087）
 */
import { Leafer, Text, Group, useCanvas } from '@leafer-ui/node'
import { Canvas as NapiCanvas, loadImage } from '@napi-rs/canvas'
import { performance } from 'node:perf_hooks'

/** 必须在创建任何 Leafer 实例之前初始化 napi canvas 平台 */
useCanvas('napi', { Canvas: NapiCanvas, loadImage })

const { WebFontPlugin } = await import('../packages/leafer-x-webfont/src/index.ts')

const BASE_URL = 'http://localhost:8087'
const POOL = '静心茶舍天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜'

/** 劫持 fetch 计数子集请求 */
let fetchCount = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/api?font=')) fetchCount++
  return realFetch(input as never, init as never)
}) as typeof fetch

function mem(label: string): void {
  const mu = process.memoryUsage()
  console.log(`  [mem] ${label}: heap=${(mu.heapUsed / 1048576).toFixed(0)}MB rss=${(mu.rss / 1048576).toFixed(0)}MB`)
}

/** 阶梯压一轮：搭建 total 个 Text → 初始 scan → 单点/连续/随机改动 */
async function runStage(total: number): Promise<void> {
  console.log(`\n===== 阶段：${(total / 1000).toFixed(0)}k Text 节点 =====`)

  /** 搭建：GROUPS 组 × 每组 N 个，全部同一 family（真实海报形态） */
  const t0 = performance.now()
  const leafer = new Leafer({ width: 800, height: 600, fill: '#fff' })
  const GROUPS = 100
  const PER = Math.floor(total / GROUPS)
  const allTexts: InstanceType<typeof Text>[] = []
  for (let g = 0; g < GROUPS; g++) {
    const group = new Group()
    for (let i = 0; i < PER; i++) {
      const ch = POOL[(g * PER + i) % POOL.length]!
      const t = new Text({ text: ch, fontFamily: '令东齐伋复刻体.ttf', fontSize: 12, fill: '#000', x: (i % 80) * 10, y: Math.floor(i / 80) * 14 })
      group.add(t)
      allTexts.push(t)
    }
    leafer.add(group)
  }
  const buildMs = performance.now() - t0
  console.log(`[搭建] ${(buildMs / 1000).toFixed(1)}s (${allTexts.length.toLocaleString()} Text)`)

  /** 插件构造（waitViewReady 已过，初始 scan 在 refresh 里显式触发以计时） */
  const t1 = performance.now()
  const webfont = new WebFontPlugin(leafer as never, { baseUrl: BASE_URL, debounceMs: 120 })
  webfont.refresh()
  const initScanMs = performance.now() - t1
  /** 等初始子集请求落定 + rewriteFamily 风暴引发的脏集 flush 消化 */
  await new Promise((r) => setTimeout(r, 500))
  webfont.flushNow()
  await webfont.ready().catch(() => undefined)
  console.log(`[初始 scan] ${initScanMs.toFixed(0)}ms, updateCalls=${webfont.updateCalls}, fetch=${fetchCount}`)
  mem('初始后')

  /* ---------- 单节点改 text（增量 flush） ---------- */
  const victim = allTexts[Math.floor(allTexts.length / 2)]!
  const t2 = performance.now()
  victim.text = '变化验证新字'
  webfont.flushNow()
  const singleMs = performance.now() - t2
  console.log(`[单点改动] flush=${singleMs.toFixed(3)}ms, updateCalls=${webfont.updateCalls}`)

  /* ---------- 连续打字：同一节点 50 次（防抖窗口内合并） ---------- */
  const callsBefore = webfont.updateCalls
  const fetchBefore = fetchCount
  const t3 = performance.now()
  for (let i = 0; i < 50; i++) {
    victim.text = '连续打字测试' + POOL[i % POOL.length]! + i
  }
  webfont.flushNow()
  await new Promise((r) => setTimeout(r, 200))
  const typingMs = performance.now() - t3
  console.log(`[连续打字50次] 总=${typingMs.toFixed(1)}ms, 新增update=${webfont.updateCalls - callsBefore}, 新增fetch=${fetchCount - fetchBefore}`)

  /* ---------- 随机 100 节点改动（批量替换/协作场景） ---------- */
  const t4 = performance.now()
  for (let i = 0; i < 100; i++) {
    const node = allTexts[Math.floor(Math.random() * allTexts.length)]!
    node.text = '随机改动' + POOL[i % POOL.length]! + i
  }
  webfont.flushNow()
  const randomMs = performance.now() - t4
  console.log(`[随机100节点] flush=${randomMs.toFixed(1)}ms, updateCalls=${webfont.updateCalls}`)

  /* ---------- 新增 Text（child.add 增量） ---------- */
  const t5 = performance.now()
  leafer.add(new Text({ text: '新增文字验证', fontFamily: '令东齐伋复刻体.ttf', fontSize: 24, fill: '#000', x: 0, y: 0 }))
  webfont.flushNow()
  const addMs = performance.now() - t5
  console.log(`[新增Text] flush=${addMs.toFixed(2)}ms`)

  await webfont.ready().catch(() => undefined)
  mem('结束')

  webfont.destroy()
  leafer.destroy()
  /** 给 GC 一点时间，避免下一阶段内存叠加干扰 */
  globalThis.gc?.()
  await new Promise((r) => setTimeout(r, 300))
}

async function main(): Promise<void> {
  console.log('=== 真实 leafer 百万节点压测 ===')
  console.log(`node=${process.version}, leafer-ui=@leafer-ui/node`)
  await runStage(100_000)
  await runStage(500_000)
  await runStage(1_000_000)
  globalThis.fetch = realFetch
  console.log('\n=== 压测完成 ===')
}

await main()
