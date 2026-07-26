# WebFont — Runtime Font Delivery + AI Chinese Font Skill

> Subset Chinese fonts on demand — 6 characters ≈ 6KB. Use premium Chinese fonts on any web page.

[中文](README.md)

**Chinese fonts are huge** (Source Han Sans: 16MB+). You can't just `@font-face` them like English fonts.

This project subsets fonts on the server side — pass in the text you need, get back only those glyphs. A poster with 20 characters? The font file is 20KB, not 16MB.

```html
<!-- One CSS block to use any Chinese font -->
<style>
@font-face {
  font-family: "MyFont";
  src: url("https://webfont.shenzilong.cn/api?font=令东齐伋复刻体&text=静心茶舍&outType=woff2") format("woff2");
}
.title { font-family: "MyFont", serif; }
</style>
<h1 class="title">静心茶舍</h1>
```

## Who Is This For

**Any project that needs Chinese Web Fonts:**

- Posters / H5 pages — a few characters subset to a few KB
- Brand websites — premium fonts no longer limited by file size
- Mini apps / PWA — bandwidth-sensitive, load on demand
- Static blogs / CMS — content is known, CSS-only output
- AI-generated pages — let AI output well-designed Chinese font solutions

## Features

> [Live Font Demo](https://webfont.shenzilong.cn/) — same content, different fonts, completely different feel

### Runtime Font Delivery

Server-side subsetting + client-side incremental loading.

```
6 characters → server subsets font → returns ~6KB (not 16MB)
```

**Subsetting performance** (Node.js benchmark, Lingdong Qiji Fuke, avg of 50 rounds):

| Case | ttf | woff2 | Output size |
|------|-----|-------|-------------|
| Latin + digits (Hello World 123) | **0.11ms** | 0.13ms | 0.4KB |
| 8 CJK characters | **0.17ms** | 0.38ms | 8KB |
| Thousand Character Classic excerpt (88 chars) | **0.37ms** | 2.11ms | 78KB |

Small character sets (the common case) hit **sub-millisecond** subsetting; time scales linearly with glyph count, with woff2's extra cost from brotli compression (a native hard limit). Response headers `X-Timing-Find/Read/Subset/Total` expose per-stage timing.

JS SDK with three loading modes:

```html
<script src="https://webfont.shenzilong.cn/webfont-sdk.js"></script>
<script>
  // Recommended: MutationObserver-driven, auto-loads new characters on DOM change
  WebFont.observeFont({ fontName: "令东齐伋复刻体.ttf", selector: ".content", family: "MySerif" });

  // Polling mode
  WebFont.loadFont({ fontName: "令东齐伋复刻体.ttf", selector: ".title", family: "MySerif" });

  // Manual text mode
  var loader = WebFont.loadText({ fontName: "令东齐伋复刻体.ttf", text: "你好世界", family: "MySerif" });
  loader.update("追加文字");
</script>
```

All modes share the same character set per font — zero duplicate requests, zero flicker.

### AI Chinese Font Skill

Inject Chinese font application capability into AI (Claude, Cursor, Copilot, etc.). With the Skill Prompt, AI can:

- Auto-select fonts matching the scene
- Handle Chinese-English mixed typesetting
- Build proper font hierarchy
- Generate fallback chains and runtime loading strategies

```
Prompt: "Build a zen-style tea brand website"

Without Skill: font-family: sans-serif → system default → looks generic

With Skill: zen style → serif heading + kai body → auto subset → visual quality leap
```

## Quick Start

### API Only

No SDK needed. One CSS block to use any Chinese font. Server returns only the character subset you need.

```css
@font-face {
  font-family: "MyFont";
  src: url("https://webfont.shenzilong.cn/api?font=令东齐伋复刻体&text=你的文字&outType=woff2") format("woff2");
}
```

### Self-hosted

```bash
# Node.js / LLRT
pnpm install && pnpm build && pnpm build_backend
node ./dist_backend/app.cjs
```

Docker (~30MB image):

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
```

## API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /api?font={name}&text={chars}&outType={woff2\|ttf}` | Subset font to specified characters |
| `GET /api/fonts` | List available fonts |
| `GET /api/config` | Get server configuration |
| `POST /api/upload?mode=temp` | Temporary font upload (auto-cleanup) |
| `POST /api/upload?mode=admin` | Permanent font upload (requires API key) |

Font name supports fuzzy matching: exact → prefix → contains.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Use Cases                              │
│  Posters/H5  ·  Brand Sites  ·  Blogs  ·  Mini Apps  ·  AI  │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │   AI Chinese Font Skill │ ← Chinese font application
              │   + AI Skill Prompt     │ ← Chinese font application
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              │   Runtime Font Delivery │ ← On-demand subsetting + incremental loading
              │   SDK + API             │
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              │   Subset Engine         │ ← fonteditor-core
              │   parse → subset →      │   Font parsing, subsetting, format conversion
              │   optimize → serialize  │
              └─────────────────────────┘
```

## Project Structure

```
web-font/
├── backend/            # Server: HTTP API + font subsetting engine
│   ├── routes/         # API route handlers
│   ├── font_util/      # Font subsetting core
│   └── server/         # HTTP server (Node.js + LLRT dual runtime)
├── src/                # Frontend: Vue 3 SPA
├── public/
│   └── webfont-sdk.js  # Runtime Font Delivery SDK
├── skills/             # AI Chinese Font Skill
├── examples/           # Before/After demo pages
└── vendor/             # fonteditor-core
```

## Acknowledgments

- [kekee000/fonteditor-core](https://github.com/kekee000/fonteditor-core) — Font parsing, subsetting, and format conversion
- [字体天下](http://www.fonts.net.cn/commercial-free-32767/fonts-zh-1.html) — Free commercial-use Chinese fonts
- Featured in [阮一峰科技爱好者周刊第 100 期](https://www.ruuyifeng.com/blog/2020/03/weekly-issue-100.html)

## License

MIT © [崮生](https://shenzilong.cn)
