# webfont-sdk

> 中文字体按需增量加载 SDK —— 只加载页面/画布实际用到的字符（6 字 ≈ 6KB，而非 16MB），无闪烁。

[webfont.shenzilong.cn](https://webfont.shenzilong.cn) 子集化服务的官方前端 SDK，也是
[leafer-x-webfont](https://github.com/2234839/web-font/tree/main/packages/leafer-x-webfont)（LeaferJS 插件）的底层引擎。

## 特性

- **增量加载**：`IncrementalEngine` 按字符集去重，只请求新增字符，同类文字滚动输入不重复请求
- **双模式**：CSS 模式（`WebFont`，面向 DOM）+ FontFace 模式（`WebFontCanvas`，面向 Canvas）
- **API 客户端**：`webfont-sdk/api` 子路径封装字体列表 / 元数据 / 上传 / 统计等 REST 接口
- **失败记忆**：裁剪失败的字符自动记录，不反复重试浪费请求
- **unicodeRange 注册**：Canvas 模式用 unicodeRange 精确注册字符片段，天然无闪烁
- **并发控制**：可配置请求并发池，避免瞬时打爆服务端
- **自定义 provider**：`setSubsetProvider` 可替换为本地裁剪（离线场景）

## 安装

```bash
npm install webfont-sdk
```

## 使用

### CSS 模式 —— DOM 页面按需加载

```ts
import { WebFont } from 'webfont-sdk'

// 事件驱动：自动观察 selector 内的文字变化
const observer = WebFont.observeFont({
  fontName: '令东齐伋复刻体.ttf',
  selector: '.title, .content',
  family: 'MyFont',
  baseUrl: 'https://webfont.shenzilong.cn', // 默认 location.origin
})
observer.dispose()

// 手动传文本
const loader = WebFont.loadText({ fontName: '令东齐伋复刻体.ttf', text: '静心茶舍', family: 'MyFont' })
loader.update('追加的文字')
loader.dispose()
```

### FontFace 模式 —— Canvas / LeaferJS 场景

```ts
import { WebFontCanvas } from 'webfont-sdk'

const face = WebFontCanvas.loadFontFace({ fontName: '令东齐伋复刻体.ttf' }, () => {
  /* 字体片段就绪，在此重绘画布 */
})
face.update('画布上的文字')
await WebFontCanvas.ready()
```

### script 标签直引（不打包场景）

```html
<script src="https://webfont.shenzilong.cn/webfont-sdk.js"></script>
<script>
  WebFont.observeFont({ fontName: '令东齐伋复刻体.ttf', selector: '.title', family: 'MyFont' })
</script>
```

## 服务端 REST API 客户端

增量加载之外，SDK 还封装了子集化服务的公开 REST 接口（字体列表 / 元数据 / 上传 / 统计），
独立子路径导出，不进主入口：

```ts
import { createWebFontApi } from 'webfont-sdk/api'

const api = createWebFontApi({ baseUrl: 'https://webfont.shenzilong.cn' })

/** 字体列表（文件名 + 是否临时字体） */
const fonts = await api.fonts()

/** 字体元数据：codepoint 区间 / 各字符集覆盖率 / name 表信息 / 站长配置 */
const meta = await api.fontMeta('霞鹜文楷.ttf')

/** 上传临时字体（默认到期自动清理；admin 模式需 apiKey） */
const result = await api.upload({ data: file, filename: '我的字体.ttf' })
if (!result.success) console.error(result.error)

/** 服务配置 / 运行统计 */
const config = await api.config()
const stats = await api.stats()
```

## 文档

完整 API 文档：<https://webfont.shenzilong.cn/docs>

## License

MIT
