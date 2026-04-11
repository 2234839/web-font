import { createMemo, createSignal, createEffect, onMount, Show } from "solid-js";
import { fetchFonts, fetchConfig, type FontInfo, type ServerConfig } from "./api";
import UploadSection from "./UploadSection";
import { SelectorRow } from "./FontSelector";
import FontDebugPreview from "./FontDebugPreview";

const s = {
  wrap: {
    "max-width": "720px",
    margin: "0 auto",
    padding: "48px 24px",
    "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#1a1a1a",
    "line-height": "1.6",
  } as const,
  h1: {
    "font-size": "22px",
    "font-weight": 600,
    margin: "0 0 4px 0",
  } as const,
  desc: {
    "font-size": "24px",
    color: "#888",
    margin: "0 0 36px 0",
  } as const,
  label: {
    display: "block",
    "font-size": "13px",
    color: "#555",
    "margin-bottom": "6px",
  } as const,
  select: {
    width: "100%",
    padding: "8px 12px",
    "font-size": "15px",
    border: "1px solid #d9d9d9",
    "border-radius": "6px",
    outline: "none",
    "box-sizing": "border-box",
  } as const,
  textarea: {
    width: "100%",
    padding: "8px 12px",
    "font-size": "32px",
    border: "1px solid #d9d9d9",
    "border-radius": "6px",
    resize: "none",
    "box-sizing": "border-box",
    outline: "none",
    color: "#e74c3c",
    "line-height": "1.4",
  } as const,
  pre: {
    background: "#f7f7f8",
    padding: "16px",
    "border-radius": "6px",
    "font-size": "13px",
    "font-family": "'SF Mono', Menlo, Consolas, monospace",
    overflow: "auto",
    "white-space": "pre-wrap",
    "word-break": "break-all",
    "line-height": "1.5",
    margin: "0",
  } as const,
  section: {
    "margin-bottom": "28px",
  } as const,
  card: {
    padding: "16px",
    border: "1px solid #e8e8e8",
    "border-radius": "8px",
    "margin-bottom": "16px",
  } as const,
  btn: {
    padding: "6px 20px",
    "font-size": "14px",
    border: "1px solid #d9d9d9",
    "border-radius": "6px",
    cursor: "pointer",
    background: "#fff",
    color: "#333",
  } as const,
  input: {
    padding: "6px 12px",
    "font-size": "14px",
    border: "1px solid #d9d9d9",
    "border-radius": "6px",
    outline: "none",
    "box-sizing": "border-box",
  } as const,
};

function App() {
  const [text, set_text] = createSignal("天地无极，乾坤借法");
  const [fonts, set_fonts] = createSignal<FontInfo[]>([]);
  const [selectedFont, set_selectedFont] = createSignal("");
  const [outType, set_outType] = createSignal<"woff2" | "ttf">("ttf");
  const [serverConfig, set_serverConfig] = createSignal<ServerConfig>({
    enableTempUpload: false,
    adminUploadEnabled: false,
    supportedOutTypes: ["woff2", "ttf"],
  });

  const SLOGAN = "如清风似闪电，超级快的字体子集化裁剪";

  onMount(async () => {
    const [fontList, config] = await Promise.all([fetchFonts().catch(() => []), fetchConfig().catch(() => ({ enableTempUpload: false, adminUploadEnabled: false }))]);
    set_fonts(fontList);
    set_serverConfig(config);
    /** 服务端不支持当前 outType 时自动回退 */
    if (!config.supportedOutTypes?.includes(outType())) {
      set_outType(config.supportedOutTypes?.[0] || "ttf");
    }
    if (fontList.length > 0) {
      /** 标语随机使用一个可用字体展示 */
      const usableFonts = fontList.filter((f) => /\.(ttf)$/i.test(f.name));
      const randomFont = usableFonts[Math.floor(Math.random() * usableFonts.length)];
      (globalThis as any).WebFont?.loadText({
        fontName: randomFont.name,
        text: SLOGAN,
        family: "SloganFont",
      });
      const sloganEl = document.getElementById("slogan");
      if (sloganEl) {
        sloganEl.style.fontFamily = '"SloganFont", sans-serif';
        sloganEl.title = randomFont.name;
      }

      set_selectedFont(fontList[0].name);
    }
  });

  const cssStyle = createMemo(() => {
    const font = selectedFont();
    const ot = outType();
    if (!font) return "";
    const formatStr = ot === "woff2" ? "woff2" : "truetype";
    return `@font-face {
  font-family: "CustomFont";
  src: url("${location.origin}/api?font=${font}&text=${encodeURIComponent(text())}&outType=${ot}") format("${formatStr}");
}
.custom-font {
  color: red;
  font-family: "CustomFont";
}`;
  });

  /** loadText loader 引用，字体或文本变化时增量加载 */
  let textLoader: { update: (text: string) => void; dispose: () => void } | null = null;

  /** 文本变化时增量加载字体 */
  const onTextChange = (value: string) => {
    set_text(value);
    if (!textLoader) return;
    textLoader.update(value);
  };

  /** 根据文本行数动态计算 textarea 高度 */
  const textareaRows = createMemo(() => {
    const lines = text().split("\n").length;
    return Math.max(2, Math.min(lines, 10));
  });

  /** 记录上次加载的 font 和 outType，避免重复加载 */
  let lastLoadKey = "";

  /** 字体切换或格式切换时重新加载字体 */
  const reloadFont = (font: string, ot: "woff2" | "ttf") => {
    const key = `${font}|${ot}`;
    if (!font || key === lastLoadKey) return;
    lastLoadKey = key;
    if (textLoader) textLoader.dispose();
    textLoader = (globalThis as any).WebFont?.loadText({
      fontName: font,
      text: text(),
      family: "CustomFont",
      outType: ot,
    }) ?? null;
    const el = document.getElementById("webfont-preview");
    if (el) el.style.fontFamily = '"CustomFont", sans-serif';
  };

  const onFontChange = (font: string) => {
    set_selectedFont(font);
  };

  /** 字体或输出格式变化时重新加载 */
  createEffect(() => {
    reloadFont(selectedFont(), outType());
  });

  async function refreshFonts() {
    const fontList = await fetchFonts();
    set_fonts(fontList);
    if (fontList.length > 0 && !selectedFont()) {
      onFontChange(fontList[0].name);
    }
  }

  return (
    <div style={s.wrap}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
        <h1 style={s.h1}>Web Font</h1>
        <a
          href="https://github.com/2234839/web-font"
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-flex", "align-items": "center", "gap": "4px", "font-size": "13px", color: "#888", "text-decoration": "none", border: "1px solid #d9d9d9", "border-radius": "6px", padding: "4px 10px" }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          Star on GitHub
        </a>
      </div>
      <p id="slogan" style={s.desc}>{SLOGAN}</p>

      <section style={s.section}>
        <SelectorRow
          fonts={fonts()}
          selectedFont={selectedFont()}
          onFontChange={onFontChange}
          supportedOutTypes={serverConfig().supportedOutTypes || ["woff2", "ttf"]}
          outType={outType()}
          onOutTypeChange={set_outType}
        />
      </section>

      <section style={s.section}>
        <label style={s.label}>输入文本预览效果</label>
        <textarea
          id="webfont-preview"
          style={{
            ...s.textarea,
          }}
          rows={textareaRows()}
          value={text()}
          onInput={(e) => onTextChange(e.target.value)}
          placeholder="在此输入文本..."
        />
      </section>

      <Show when={selectedFont()}>
        <section style={s.section}>
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "6px" }}>
            <label style={{ ...s.label, margin: "0" }}>CSS 代码</label>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                style={{ ...s.btn, padding: "3px 12px", "font-size": "12px" }}
                onClick={() => {
                  const ot = outType();
                  const a = document.createElement("a");
                  a.href = `/api?font=${selectedFont()}&text=${encodeURIComponent(text())}&outType=${ot}`;
                  a.download = selectedFont().replace(/\.[^.]+$/, "") + `_subset.${ot}`;
                  a.click();
                }}
              >
                下载字体
              </button>
              <button
                style={{ ...s.btn, padding: "3px 12px", "font-size": "12px" }}
                onClick={async (e) => {
                  const btn = e.currentTarget;
                  try {
                    await navigator.clipboard.writeText(cssStyle());
                    btn.textContent = "已复制";
                    setTimeout(() => { btn.textContent = "复制 CSS"; }, 1500);
                  } catch {
                    btn.textContent = "复制失败";
                    setTimeout(() => { btn.textContent = "复制 CSS"; }, 1500);
                  }
                }}
              >
                复制 CSS
              </button>
            </div>
          </div>
          <pre style={s.pre}>{cssStyle()}</pre>
        </section>
      </Show>

      <Show when={import.meta.env.DEV}>
        <FontDebugPreview />
      </Show>

      <UploadSection config={serverConfig()} onUploaded={refreshFonts} />

      <section style={{ ...s.section, "font-size": "12px", color: "#aaa", "line-height": "1.8" }}>
        <p><b>原理：</b>服务端根据 text 参数裁剪字体，只返回所需字符的子集。相同 URL 的请求会被浏览器自动缓存。</p>
        <p><b>基础用法：</b>将 CSS 复制到你的页面，修改 text 参数中的文字即可：</p>
        <pre style={{ ...s.pre, "font-size": "12px", "margin-top": "4px" }}>{`<style>
@font-face {
  font-family: "MyFont";
  src: url("${location.origin}/api?font=字体名&text=你的文字") format("woff2");
}
.title { font-family: "MyFont"; }
</style>
<h1 class="title">你的文字</h1>`}</pre>
        <p style={{ "margin-top": "12px" }}><b>JS SDK（推荐）：</b>增量加载字体片段，按需请求，不会出现全量字体闪烁。<a href="/webfont-sdk.js" download="webfont-sdk.js">下载 SDK</a></p>
        <pre style={{ ...s.pre, "font-size": "12px", "margin-top": "4px" }}>{`<script src="${location.origin}/webfont-sdk.js"><\/script>
<script>
  WebFont.loadFont({
    fontName: "字体文件名.ttf",
    selector: ".my-element",
    family: "MyFont",
    interval: 1000,
  });
<\/script>`}</pre>
        <p style={{ "margin-top": "8px" }}>还支持 <code>WebFont.observeFont()</code>（MutationObserver 事件驱动）和 <code>WebFont.loadText()</code>（手动传文本）两种方式，多种方式可同时使用，SDK 内部自动按字体去重增量加载。</p>
      </section>

      <footer style={{ "margin-top": "48px", "padding-top": "16px", "border-top": "1px solid #eee", "font-size": "12px", color: "#999", "text-align": "center" }}>
        <p>感谢 <a href="https://www.ruanyifeng.com/blog/2020/03/weekly-issue-100.html" target="_blank" rel="noopener noreferrer" style={{ color: "#999" }}>阮一峰科技爱好者周刊（第 100 期）</a> 收录本项目</p>
      </footer>
    </div>
  );
}

export default App;
