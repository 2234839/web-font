# webfont-sdk

> 中文字体按需增量加载 SDK —— 只加载页面/画布实际用到的字符（6 字 ≈ 6KB，而非 16MB），无闪烁。

[webfont.shenzilong.cn](https://webfont.shenzilong.cn) 子集化服务的官方前端 SDK，也是
[leafer-x-webfont](https://github.com/2234839/web-font/tree/main/packages/leafer-x-webfont)（LeaferJS 插件）的底层引擎。

## 特性

- **增量加载**：`IncrementalEngine` 按字符集去重，只请求新增字符，同类文字滚动输入不重复请求
- **双模式**：CSS 模式（`WebFont`，面向 DOM）+ FontFace 模式（`WebFontCanvas`，面向 Canvas）
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

## 文档

完整 API 文档：<https://webfont.shenzilong.cn/docs>

## License

MIT
