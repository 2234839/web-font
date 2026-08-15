/**
 * 归因对照：百万节点下连续赋值 text 的成本，插件开 vs 关
 *
 * 疑问：压测里「连续打字50次」1M 节点耗时 ~3s，需确认这是 leafer 自身
 * setter（text 改动 → 布局失效）的固有成本，还是插件监听引入的。
 *
 * 运行：npx tsx scripts/test-leafer-million-baseline.mts
 */
import { Leafer, Text, Group, useCanvas } from '@leafer-ui/node'
import { Canvas as NapiCanvas, loadImage } from '@napi-rs/canvas'
import { performance } from 'node:perf_hooks'

useCanvas('napi', { Canvas: NapiCanvas, loadImage })

const POOL = '静心茶舍天地玄黄宇宙洪荒'

async function buildTree(total: number) {
  const leafer = new Leafer({ width: 800, height: 600, fill: '#fff' })
  const GROUPS = 100
  const PER = Math.floor(total / GROUPS)
  const allTexts: InstanceType<typeof Text>[] = []
  for (let g = 0; g < GROUPS; g++) {
    const group = new Group()
    for (let i = 0; i < PER; i++) {
      const t = new Text({ text: POOL[i % POOL.length]!, fontFamily: 'sans-serif', fontSize: 12, fill: '#000', x: (i % 80) * 10, y: Math.floor(i / 80) * 14 })
      group.add(t)
      allTexts.push(t)
    }
    leafer.add(group)
  }
  return { leafer, allTexts }
}

async function main(): Promise<void> {
  const TOTAL = 1_000_000
  console.log(`=== 无插件基线：${TOTAL.toLocaleString()} 节点下 50 次 text 赋值 ===`)
  const { leafer, allTexts } = await buildTree(TOTAL)
  const victim = allTexts[Math.floor(allTexts.length / 2)]!
  await new Promise((r) => setTimeout(r, 200))

  const t0 = performance.now()
  for (let i = 0; i < 50; i++) {
    victim.text = '连续打字测试' + POOL[i % POOL.length]! + i
  }
  const noPluginMs = performance.now() - t0
  console.log(`[无插件] 50 次赋值: ${noPluginMs.toFixed(1)}ms (${(noPluginMs / 50).toFixed(1)}ms/次)`)
  leafer.destroy()
}

await main()
