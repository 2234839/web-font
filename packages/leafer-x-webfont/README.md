# leafer-x-webfont

> LeaferJS 中文字体插件 —— 画布里的 Text 用什么字，就只加载那几个字（6 字 ≈ 6KB，而非 16MB）。

## 为什么需要它

Leafer 的 `Text` 元素渲染时直接拼 `canvas.font = fontFamily`，依赖浏览器字体系统。
中文字体动辄 10MB+，`FontFace` 注册又慢又耗流量，海报/设计器场景根本没法用。

本插件订阅画布内 `Text` 的 `text` / `fontFamily` 变化，只对**实际用到的字符**调用
[webfont](https://github.com/2234839/web-font) 子集化 API，注册 KB 级子集字体后自动重渲染画布：

```
new Text({ text: '静心茶舍', fontFamily: '令东齐伋复刻体.ttf' })
→ 服务端裁剪 → 返回 ~6KB 子集 → FontFace 注册 → 画布自动重绘
```

## 安装

```bash
npm install leafer-x-webfont
```

## 使用

```ts
import { Leafer, Text } from 'leafer-ui'
import { WebFontPlugin } from 'leafer-x-webfont'

const leafer = new Leafer({ view: window })

// 一行接入
const webfont = new WebFontPlugin(leafer)

leafer.add(new Text({ text: '静心茶舍', fontFamily: '令东齐伋复刻体.ttf', fontSize: 64 }))
// 字体到位后画布自动重渲染
```

### 导出图片前

```ts
await webfont.ready()          // 等待所有已用字符的子集注册完成
const blob = await leafer.export('png', { pixelRatio: 2 })
```

### 配置项

```ts
new WebFontPlugin(leafer, {
  baseUrl: 'https://webfont.shenzilong.cn', // 自部署时改这里
  outType: 'ttf',        // 默认 ttf：子集场景无 brotli 编码/解码开销，端到端更快；流量敏感可改 'woff2'
  debounceMs: 120,
  watch: true,        // 持续监听画布变化；静态海报导出可关掉
  debug: false,
  resolveFont: null,  // 自定义 fontFamily 解析规则，返回 null 跳过
})
```

## 特性

- **零配置**：任意 `fontFamily`（含 `xxx.ttf` 文件名写法）自动识别，字体不存在时静默回退
- **增量去重**：同一字体下字符集只增不减，改一个字只多发一个字符的子集请求
- **失败记忆**：字体不含的字符自动记入失败集，不反复 404
- **导出友好**：`webfont.ready()` 保证 `leafer.export()` 时字体已注册

## 本地开发

```bash
# 仓库根目录
pnpm install
pnpm dev            # 起前后端

# 打开 demo（插件源码直引，无需构建）
open packages/leafer-x-webfont/demo/index.html
```

## License

MIT
