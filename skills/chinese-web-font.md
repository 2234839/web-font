---
name: chinese-web-font
description: 中文字体按需裁剪与加载能力，可让 AI 在生成中文网页时引入特殊中文字体，按字符子集化加载，极大减少流量。
---

# Chinese Web Font Skill

## WebFont API

按需裁剪中文字体，只返回页面实际使用的字符。6 个字 ≈ 6KB。

### CSS 直出

```html
<style>
@font-face {
  font-family: "MyFont";
  src: url("https://webfont.shenzilong.cn/api?font=令东齐伋复刻体&text=静心茶舍&outType=woff2") format("woff2");
}
</style>
```

`text` 参数写什么字，就只返回那些字的子集。

### 查看可用字体

```
GET https://webfont.shenzilong.cn/api/fonts
```

返回当前服务器上所有可用字体列表。响应中 `temporary: true` 表示临时字体，随时可能被清理，不要使用。使用前先调用此接口确认字体是否存在。

### 其他接口

```
GET  https://webfont.shenzilong.cn/api?font={name}&text={chars}&outType=woff2  — 裁剪字体
GET  https://webfont.shenzilong.cn/api/fonts                                    — 列出可用字体
GET  https://webfont.shenzilong.cn/api/config                                   — 服务配置
POST https://webfont.shenzilong.cn/api/upload?mode=temp                         — 临时上传字体
```

字体名支持模糊匹配（精确 > 前缀 > 包含）。`outType` 支持 `woff2` 和 `ttf`。

### SDK 增量加载

```html
<script src="https://webfont.shenzilong.cn/webfont-sdk.js"></script>
<script>
  WebFont.observeFont({ fontName: "令东齐伋复刻体.ttf", selector: ".content", family: "MyFont" });
</script>
```

三种模式：`observeFont`（推荐，DOM 事件驱动）、`loadFont`（轮询）、`loadText`（手动文本）。

SDK 支持文字动态变化：当 DOM 内容改变时，`observeFont` 会自动检测新字符并增量加载，无需手动更新。适合 AI 生成内容、动态渲染等场景。

## 关键规则

- **行高**：中文正文 1.8，标题 1.3。中文笔画密集，比英文需要更大行距
- **字重**：中文 400/700 区分明显，中间字重（300/500）表现弱，不要依赖
- **中英混排**：中文与英文/数字之间加空格
- **字号级差**：标题间至少 4px 差距，否则层级模糊
- **首行缩进**：`text-indent: 2em` 是中文正文的传统

## 可用字体

如果可以发请求，先调用 `GET https://webfont.shenzilong.cn/api/fonts` 查看最新可用字体列表。响应中 `temporary: true` 的字体随时可能被清理，可仅作演示，并提示用户。

如果不能发请求，公共服务永久字体有：

- `令东齐伋复刻体.ttf` — 宋体风格，古典优雅，适合传统文化、禅意
- `问藏书房.ttf` — 书法风格，适合文艺、文化场景

## Fallback 链

```css
/* 衬线 */ "CustomFont", "Noto Serif CJK SC", "STSong", "SimSun", serif;
/* 无衬线 */ "CustomFont", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
/* 楷体 */ "CustomFont", "LXGW WenKai", "STKaiti", "KaiTi", cursive;
```

## 风格速查

**zen（禅意）**：衬线标题 + 楷体正文，line-height 2.0，大量留白，暖色 #faf9f6
**modern-tech（科技）**：无衬线粗标题，letter-spacing -0.02em，强对比
**luxury（奢侈）**：衬线细字重(300)，超大 letter-spacing 0.15em，极简
**editorial（编辑）**：衬线标题 + 无衬线正文，首行缩进，行长 60~80 字符
**warm（温暖）**：楷体为主，line-height 2.0，暖色系
