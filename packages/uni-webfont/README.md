# uni-webfont —— uni-app 字体按需加载（中文字体子集化）

> 任意中文字体，按页面**实际用到的字符**动态裁剪加载：**10 个字 ≈ 10KB**。
> 突破小程序 2MB 主包限制，无需构建期裁字、无需整包下载 10MB+ 字体、文案改了零成本生效。

## 为什么需要它

中文字体动辄 5-20MB，而微信小程序主包限 2MB、整包下载超时白屏。uni-app 官方文档的建议是
["抽离出部分中文，减少体积"](https://uniapp.dcloud.net.cn/api/ui/font)——每改一次文案就得重新裁一次字体，文案一多就漏字。

**uni-webfont 把裁字搬到运行时**：把页面文字提交给子集化服务，服务端秒级裁出只含这些字的字体片段，`uni.loadFontFace` 注册生效。文案随便改，用多少加载多少。

| 方案 | 体积 | 文案可变 | 跨端 |
|---|---|---|---|
| 整包 ttf | 5-20MB | ✅ | ❌ 超主包限制 |
| 构建期裁字（fontmin 等） | 小 | ❌ 改文案需重裁 | ✅ |
| **uni-webfont 运行时子集** | **按字符数** | ✅ 随便改 | ✅ |

## 安装

```bash
pnpm add uni-webfont
# 或
npm install uni-webfont
```

> HBuilderX 非CLI 工程（无 node_modules）：从
> [uni_modules/gs-webfont](https://github.com/2234839/web-font/tree/new/uni_modules/gs-webfont)
> 复制目录到工程 `uni_modules/` 下，`import { UniWebFont } from '@/uni_modules/gs-webfont/js_sdk/index.js'`

## 快速开始

```ts
// 页面或 App.vue
import { UniWebFont } from 'uni-webfont'

const loader = UniWebFont.loadFont({ fontName: '令东齐伋复刻体.ttf' })
loader.update('静心茶舍 今日特饮')

// 样式里直接用（family = 字体名去扩展名）
// <view style="font-family: 令东齐伋复刻体">静心茶舍</view>
```

首次 `update` 后字体异步生效，旧字形（系统字体）保持显示直到新字体就绪，**无闪烁**。

### 等待就绪（截图/导出场景）

```ts
loader.update('要渲染的文字')
await loader.ready()
// 此时字体必然已生效，再截图/生成 canvas
```

### 追加文本（打字机/动态内容）

```ts
loader.update('第一段文字')
loader.update('第二段文字')  // 引擎自动去重，只请求新出现的字
```

## API

### `UniWebFont.loadFont(options): IUniFontLoader`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `fontName` | `string` | — | 字体文件名（服务端[字体列表](https://webfont.shenzilong.cn)里可选，支持模糊匹配） |
| `baseUrl` | `string` | 官方服务 | 私有部署地址 |
| `family` | `string` | 去扩展名字体名 | CSS font-family 用的名字 |
| `outType` | `'ttf' \| 'woff2'` | `'ttf'` | 小程序建议 ttf（iOS 低版本 woff2 兼容差） |
| `global` | `boolean` | `true` | 是否全局生效（微信 2.10.0+，在 App.vue 调用则全 app 生效） |
| `maxCharsPerChunk` | `number` | `300` | 单次请求最大字符数，超出自动分批串行加载 |
| `desc` | `object` | — | 字体描述符（style/weight/variant） |
| `debug` | `boolean` | `false` | 控制台输出加载日志 |

返回 loader：

| 方法 | 说明 |
|---|---|
| `update(text)` | 提交文本（自动去重，只请求出现过的字符） |
| `isPending()` | 该字体是否有片段在请求/注册中 |
| `ready()` | 等待全部在途片段就绪（截图/导出前调用） |
| `retryFailed()` | 清除失败记录，配合 update 重试失败字符 |
| `dispose()` | 释放该字体状态 |

### `UniWebFont.ready()` / `hasPending()`

全部字体的就绪等待（多字体页面导出前用）。

## 工作原理

```
update("静心茶舍") ──► 引擎去重（已加载字符跳过）
                         │
                         ▼ 新字符才请求
              GET /api?font=xx.ttf&text=静心茶舍&outType=ttf
                         │  服务端秒级裁出只含这些字的字体（~10KB）
                         ▼
              uni.loadFontFace({ family, source: url })
                         │  旧字形保持渲染直到新字体就绪 → 无闪烁
                         ▼
                    CSS font-family 生效
```

小程序 `loadFontFace` 不支持 `unicode-range`（同 family 只有一个生效字体），因此采用
「字符累积 + 全量重载」策略：引擎按字符去重只请求增量，但每次请求携带累积全集，
保证重载后的字体一定是已渲染字体的超集；同字体请求串行保序。

## 平台兼容

| 平台 | 支持 | 说明 |
|---|---|---|
| 微信/支付宝/百度/抖音/QQ 小程序 | ✅ | 需把 `webfont.shenzilong.cn` 加入小程序后台 downloadFile 合法域名（**https**） |
| H5 | ✅ | 无需任何配置 |
| App (vue/uvue) | ✅ | |
| app-nvue | ❌ | 平台不支持 loadFontFace，用 Weex DOM.addRule 自行处理 |

## 私有部署

默认使用官方免费服务 [webfont.shenzilong.cn](https://webfont.shenzilong.cn)，商用或内网场景传 `baseUrl` 指向自建服务即可：

服务端是开源的（Docker 一键部署）：[web-font](https://github.com/2234839/web-font)

```ts
const loader = UniWebFont.loadFont({
  fontName: '令东齐伋复刻体.ttf',
  baseUrl: 'https://your-font-server.com', // 自建服务
})
```

## 常见问题

**Q: 字体加载失败？**
微信小程序需在 mp.weixin.qq.com 后台「开发管理 → 开发设置 → 服务器域名」把 `https://webfont.shenzilong.cn` 加入 **downloadFile 合法域名**（loadFontFace 内部走下载通道，不是 request 域名）。

**Q: 为什么默认 ttf 不是 woff2？**
低版本 iOS 的 WebView 对 woff2 支持不全（[官方文档](https://uniapp.dcloud.net.cn/api/ui/font)），ttf 全端稳妥。纯 H5 场景可传 `outType: 'woff2'` 省约 30% 流量。

**Q: 请求会带什么数据？**
仅「字体名 + 待渲染字符」，无用户信息。服务端按文本缓存，同文案只裁一次。

**Q: 和 webfont-sdk 什么关系？**
[webfont-sdk](https://www.npmjs.com/package/webfont-sdk) 是通用引擎（Web DOM / Canvas FontFace 场景），
本包复用其增量引擎（去重/并发/失败记忆）并做 uni-app 桥接（loadFontFace + 字符累积重载）。

## 相关

- 在线体验：[webfont.shenzilong.cn](https://webfont.shenzilong.cn)
- LeaferJS 版插件：[leafer-x-webfont](https://www.npmjs.com/package/leafer-x-webfont)
- Web/Canvas 通用 SDK：[webfont-sdk](https://www.npmjs.com/package/webfont-sdk)

## License

MIT © 崮生（子虚）
