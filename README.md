# WebFont — 中文字体按需裁剪 + AI 字体技能

> 按需裁剪中文字体，6 个字 ≈ 6KB。让任何网页、海报、H5 都能用上高级中文字体。

[English](README.en.md)

**中文字体包太大**（思源黑体 16MB+），没法像英文字体那样直接 `@font-face` 引入。

本项目在服务端按需子集化字体——传什么文字，就只返回那些字符的字体子集。一张海报用了 20 个字？返回的字体文件就是 20KB，而不是 16MB。

```html
<!-- 一段 CSS 即可使用任意中文字体 -->
<style>
@font-face {
  font-family: "MyFont";
  src: url("https://webfont.shenzilong.cn/api?font=令东齐伋复刻体&text=静心茶舍&outType=woff2") format("woff2");
}
.title { font-family: "MyFont", serif; }
</style>
<h1 class="title">静心茶舍</h1>
```

## 谁在用

**任何需要中文 Web Font 的场景：**

- 海报 / H5 活动页 — 几个字裁剪后只有几 KB
- 品牌官网 — 高级字体不再受限于体积
- 小程序 / PWA — 流量敏感，按需加载
- 静态博客 / CMS — 文字内容确定，CSS 直出即可
- AI 生成网页 — 让 AI 也能输出有设计感的中文字体方案

## 核心能力

> [在线体验中文字体效果对比](https://webfont.shenzilong.cn/?demo) — 同一内容，字体不同，体验天壤之别

### Runtime Font Delivery

服务端按需子集化 + 客户端增量加载。

```
6 个字 → 服务端裁剪 → 返回约 6KB 子集字体（而非 16MB 完整字体）
```

**裁剪性能**（Node.js 实测，令东齐伋复刻体，50 轮平均值）：

| 场景 | ttf | woff2 | 输出大小 |
|------|-----|-------|----------|
| 拉丁 + 数字（Hello World 123） | **0.11ms** | 0.13ms | 0.4KB |
| 8 个汉字 | **0.17ms** | 0.38ms | 8KB |
| 千字文前段（88 字） | **0.37ms** | 2.11ms | 78KB |

小字集（常用场景）裁剪已达**亚毫秒级**；耗时随字形数量线性增长，woff2 的额外开销来自 brotli 压缩（原生硬下限）。响应头 `X-Timing-Find/Read/Subset/Total` 可观测各阶段耗时。

JS SDK 三种加载模式：

```html
<script src="https://webfont.shenzilong.cn/webfont-sdk.js"></script>
<script>
  // 推荐：MutationObserver 事件驱动，DOM 变化自动加载新字符
  WebFont.observeFont({ fontName: "令东齐伋复刻体.ttf", selector: ".content", family: "MySerif" });

  // 轮询模式
  WebFont.loadFont({ fontName: "令东齐伋复刻体.ttf", selector: ".title", family: "MySerif" });

  // 手动传入文本
  var loader = WebFont.loadText({ fontName: "令东齐伋复刻体.ttf", text: "你好世界", family: "MySerif" });
  loader.update("追加文字");
</script>
```

同一字体下所有模式共享字符集，零重复请求，零闪烁。

### AI Chinese Font Skill

给 AI（Claude、Cursor、Copilot 等）注入中文字体应用能力。AI 读取 Skill Prompt 后可以：

- 自动选择匹配场景的中文字体
- 正确处理中英混排
- 建立字体层级（Font Hierarchy）
- 生成 fallback 链和 Runtime 加载策略

```
Prompt: "生成一个东方禅意风格的茶品牌官网"

无 Skill: font-family: sans-serif → 系统黑体 → 廉价感

有 Skill: zen 风格 → 宋体标题 + 楷体正文 → 自动子集化 → 质感显著提升
```

## 快速开始

### 直接调用 API

无需 SDK，一段 CSS 即可。服务端只返回你需要的字符子集。

```css
@font-face {
  font-family: "MyFont";
  src: url("https://webfont.shenzilong.cn/api?font=令东齐伋复刻体&text=你的文字&outType=woff2") format("woff2");
}
```

### 自部署

```bash
# Node.js / LLRT
pnpm install && pnpm build && pnpm build_backend
node ./dist_backend/app.cjs
```

Docker（~30MB 极简镜像）：

```yaml
services:
  webfont:
    image: docker.io/llej0/web-font:latest
    ports:
      - "8087:8087"
    volumes:
      - ./fonts:/home/font
    environment:
      - ENABLE_TEMP_UPLOAD=true
      - ADMIN_API_KEY=your-secret-key
      - SUBSET_CACHE_MAX_SIZE=10485760
      # 临时字体保留时限（秒），超时未使用自动删除，默认 10800（3小时）
      - TEMP_RETENTION_SECONDS=10800
      # 子集化内存水位阈值(MB)，RSS 超此值时排队等待，默认 600
      - SUBSET_MEM_SOFT_LIMIT_MB=600
```

## API

| 接口 | 说明 |
|------|------|
| `GET /api?font={name}&text={chars}&outType={woff2\|ttf}` | 裁剪字体，只返回指定字符的子集 |
| `GET /api/fonts` | 列出可用字体 |
| `GET /api/config` | 获取服务配置 |
| `POST /api/upload?mode=temp` | 临时上传（自动清理） |
| `POST /api/upload?mode=admin` | 永久上传（需 API Key） |

字体名支持模糊匹配：精确 > 前缀 > 包含。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                        使用场景                              │
│  海报/H5  ·  品牌官网  ·  博客  ·  小程序  ·  AI 生成页面    │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │  AI Chinese Font Skill │ ← 中文字体应用能力
              │  + Skill Prompt        │ ← 字体裁剪 + 加载策略
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              │  Runtime Font Delivery  │ ← 按需子集化 + 增量加载
              │  SDK + API              │
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              │  Subset Engine          │ ← fonteditor-core
              │  parse → subset →       │   字体解析、子集化、格式转换
              │  optimize → serialize   │
              └─────────────────────────┘
```

## 项目结构

```
web-font/
├── backend/            # 服务端：HTTP API + 字体裁剪引擎
│   ├── routes/         # API 路由
│   ├── font_util/      # 字体裁剪核心
│   └── server/         # HTTP 服务器（兼容 Node.js + LLRT）
├── src/                # 前端：Vue 3 单页应用
├── public/
│   └── webfont-sdk.js  # Runtime Font Delivery SDK
├── skills/             # AI Chinese Font Skill
├── examples/           # Before/After 对比演示
└── vendor/             # fonteditor-core
```

## 鸣谢

- [kekee000/fonteditor-core](https://github.com/kekee000/fonteditor-core) — 字体解析、子集化、格式转换
- [字体天下](http://www.fonts.net.cn/commercial-free-32767/fonts-zh-1.html) — 免费商用中文字体
- 入选[阮一峰科技爱好者周刊第 100 期](https://www.ruanyifeng.com/blog/2020/03/weekly-issue-100.html)

## License

MIT © [崮生](https://shenzilong.cn)
