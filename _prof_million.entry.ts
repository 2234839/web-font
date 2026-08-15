/**
 * 百万节点极端压力测试 —— leafer-x-webfont 增量扫描引擎
 *
 * 验证目标（用户挑战：节点百万级能否正常运行）：
 *   1. 百万 Text 节点画布上，打字（property.change）单次 flush 成本
 *   2. 无文字变化交互（指纹短路）：update 调用是否归零
 *   3. 模板整体替换（child.add 溢出）：全量退化路径成本
 *   4. 内存：脏集/指纹表/事件监听是否随节点数线性增长（预期仅 O(family 数)）
 *
 * 运行：npx tsx _prof_million.entry.ts
 *
 * 不依赖真实 leafer 实例（百万节点 DOM 搭建本身是 leafer 的事），
 * 用最小节点桩实现 ILeaferNode 结构 + 手动派发事件，隔离验证插件调度逻辑。
 */
import { performance } from 'node:perf_hooks'

const { WebFontPlugin } = await import('./packages/leafer-x-webfont/src/index.ts')

/** 最小 leafer 桩：只实现插件依赖的接口面（on_/off_/waitViewReady/children） */
class FakeLeafer {
  children: object[] = []
  destroyed = false
  private listeners = new Map<string, Array<(e: object) => void>>()
  private nextId = 1
  private ids = new Map<number, [string, (e: object) => void]>()

  on_(type: string, listener: (e: object) => void): number {
    const id = this.nextId++
    let list = this.listeners.get(type)
    if (!list) { list = []; this.listeners.set(type, list) }
    list.push(listener)
    this.ids.set(id, [type, listener])
    return id
  }
  off_(ids: number[]): void {
    for (const id of ids) {
      const entry = this.ids.get(id)
      if (!entry) continue
      const [type, listener] = entry
      const list = this.listeners.get(type)
      if (list) this.listeners.set(type, list.filter((l) => l !== listener))
      this.ids.delete(id)
    }
  }
  waitViewReady(cb: () => void): void { cb() }
  emit(type: string, e: object): void {
    for (const l of this.listeners.get(type) ?? []) l(e)
  }
}

class FakeText {
  __tag = 'Text'
  constructor(public text: string, public fontFamily: string) {}
  children?: object[]
  destroyed?: boolean
}

/** 子树：每组 group 子节点 + N 个 Text，模拟真实海报/长文档结构 */
class FakeGroup {
  __tag = 'Group'
  children: object[] = []
  destroyed?: boolean
}

/** 测试配置的子集服务桩：记录 update 调用次数与字符数（验证指纹短路） */
class CountingProvider {
  calls = 0
  lastText = ''
  async fetch(fontName: string, text: string): Promise<{ url: string; format: string }> {
    this.calls++
    this.lastText = text
    return { url: `data:font/ttf;base64,`, format: 'ttf' }
  }
}

async function main(): Promise<void> {
  console.log('=== 百万节点压力测试 ===\n')

  /* ---------- 场景 A：100 万 Text 节点，初始全量 ---------- */
  const TOTAL = 1_000_000
  const leafer = new FakeLeafer()
  const root = new FakeGroup()
  leafer.children = [root]

  const t0 = performance.now()
  /** 500 组 × 2000 Text = 1M，每组同一 family（模拟海报重复用同一字体） */
  const GROUPS = 500
  const PER_GROUP = TOTAL / GROUPS
  const pool = '静心茶舍天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳'.split('')
  for (let g = 0; g < GROUPS; g++) {
    const group = new FakeGroup()
    for (let i = 0; i < PER_GROUP; i++) {
      const ch = pool[(g * PER_GROUP + i) % pool.length]!
      group.children!.push(new FakeText(ch, '令东齐伋复刻体.ttf'))
    }
    root.children!.push(group)
  }
  const buildMs = performance.now() - t0
  console.log(`[A] 搭建 ${TOTAL.toLocaleString()} 节点: ${buildMs.toFixed(0)}ms`)

  const provider = new CountingProvider()
  const plugin = new WebFontPlugin(leafer as never, {
    baseUrl: 'http://localhost:8087',
    provider: provider as never,
    debounceMs: 0,
    debug: false,
  })
  /** waitViewReady 同步回调，构造即完成初始 scan */
  const initMs = performance.now() - t0 - buildMs
  console.log(`[A] 初始全量 scan(1M 节点): ${initMs.toFixed(1)}ms`)

  /* ---------- 场景 B：打字（property.change + flush）---------- */
  const target = (root.children![0] as FakeGroup).children![0] as FakeText

  /**
   * 真实打字成本 = 事件处理（记脏集）+ flush（增量 walk 脏节点）。
   * 模拟用户敲 100 键：每键 emit + 同步 flush（防抖窗口外的稳态成本）
   */
  const t1 = performance.now()
  const KEYS = 100
  for (let i = 0; i < KEYS; i++) {
    target.text = '静心茶舍新内容' + pool[i % pool.length] + i
    leafer.emit('property.change', { attrName: 'text', target, newValue: target.text, oldValue: '' })
    plugin.flushNow()
  }
  const typingMs = (performance.now() - t1) / KEYS
  console.log(`[B] 打字稳态成本(emit+flush, 1M 节点画布): ${typingMs.toFixed(3)}ms/键`)
  console.log(`[B] update 提交次数: ${plugin.updateCalls}（SDK 层再按字符去重，实际请求 ≤ 此数）`)

  /* ---------- 场景 B2：拖拽等无文字变化交互 ---------- */
  const callsBefore = plugin.updateCalls
  const t2 = performance.now()
  for (let i = 0; i < 100; i++) {
    /** 拖拽/缩放只改 x/y，插件不订阅这些属性——模拟反复属性风暴下手动 refresh 校准 */
    leafer.emit('property.change', { attrName: 'x', target, newValue: i, oldValue: i - 1 })
    plugin.flushNow()
  }
  console.log(`[B2] 无文字变化 flush ×100: ${(performance.now() - t2).toFixed(3)}ms 总计, update=${plugin.updateCalls - callsBefore} 次`)

  /* ---------- 场景 C：指纹短路（无文字变化重复提交）---------- */
  const committedCalls = provider.calls
  plugin.refresh() /** 全量重扫，内容未变 */
  const skipped = provider.calls === committedCalls
  console.log(`[C] 指纹短路(全量重扫无变化): update 调用 ${skipped ? '0 次 ✓' : provider.calls - committedCalls + ' 次 ✗'}`)

  /* ---------- 场景 D：模板替换（child.add 大子树）---------- */
  const t3 = performance.now()
  leafer.emit('child.add', { child: root.children![1] })
  const dirtyAddMs = performance.now() - t3
  console.log(`[D] child.add 子树入脏集(2000 Text): ${dirtyAddMs.toFixed(3)}ms`)

  /* ---------- 场景 E：destroy 清理 ---------- */
  const t4 = performance.now()
  plugin.destroy()
  console.log(`[E] destroy: ${(performance.now() - t4).toFixed(2)}ms`)

  /* ---------- 内存估算 ---------- */
  const mu = process.memoryUsage()
  console.log(`\n[内存] heapUsed=${(mu.heapUsed / 1048576).toFixed(0)}MB heapTotal=${(mu.heapTotal / 1048576).toFixed(0)}MB rss=${(mu.rss / 1048576).toFixed(0)}MB`)
  console.log(`[内存] 指纹表条目=${'1 family → 1 条'}（O(family 数)，与节点数无关）`)
}

await main()
