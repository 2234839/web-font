import { createMemo, createSignal, onMount, Show, For } from "solid-js";
import { fetchFonts, fetchConfig, uploadFont, type FontInfo, type ServerConfig } from "./api";

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
    "font-size": "14px",
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
    height: "72px",
    padding: "8px 12px",
    "font-size": "32px",
    border: "1px solid #d9d9d9",
    "border-radius": "6px",
    resize: "vertical",
    "box-sizing": "border-box",
    outline: "none",
    color: "#e74c3c",
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
  const [serverConfig, set_serverConfig] = createSignal<ServerConfig>({
    enableTempUpload: false,
    adminUploadEnabled: false,
  });

  onMount(async () => {
    const [fontList, config] = await Promise.all([fetchFonts().catch(() => []), fetchConfig().catch(() => ({ enableTempUpload: false, adminUploadEnabled: false }))]);
    set_fonts(fontList);
    set_serverConfig(config);
    if (fontList.length > 0) {
      set_selectedFont(fontList[0].name);
    }
  });

  const cssStyle = createMemo(() => {
    const font = selectedFont();
    if (!font) return "";
    return `@font-face {
  font-family: "CustomFont";
  src: url("${location.origin}/api?font=${font}&text=${encodeURIComponent(text())}") format("truetype");
}
.custom-font {
  color: red;
  font-family: "CustomFont";
}`;
  });

  /** 字体切换时使用 SDK 重新加载 */
  const prevFontRef = { value: "" };
  createMemo(() => {
    const font = selectedFont();
    if (!font) return;
    if (font !== prevFontRef.value) {
      prevFontRef.value = font;
      const el = document.getElementById("webfont-preview");
      if (el) el.style.fontFamily = 'inherit';
      (globalThis as any).WebFont?.loadFont({
        fontName: font,
        selector: "#webfont-preview",
        family: "CustomFont",
      });
    }
  });

  async function refreshFonts() {
    const fontList = await fetchFonts();
    set_fonts(fontList);
    if (fontList.length > 0 && !selectedFont()) {
      set_selectedFont(fontList[0].name);
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
      <p style={s.desc}>输入文本，获取仅包含所需字符的子集字体 CSS</p>

      <section style={s.section}>
        <label style={s.label}>选择字体</label>
        <select
          style={s.select}
          value={selectedFont()}
          onChange={(e) => set_selectedFont(e.target.value)}
        >
          <option value="">-- 请选择 --</option>
          <For each={fonts()}>
            {(f) => (
              <option value={f.name}>
                {f.name} ({f.dir})
              </option>
            )}
          </For>
        </select>
      </section>

      <section style={s.section}>
        <label style={s.label}>输入文本预览效果</label>
        <textarea
          id="webfont-preview"
          style={{
            ...s.textarea,
          }}
          value={text()}
          onInput={(e) => set_text(e.target.value)}
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
                  const a = document.createElement("a");
                  a.href = `/api?font=${selectedFont()}&text=${encodeURIComponent(text())}`;
                  a.download = selectedFont().replace(/\.[^.]+$/, "") + "_subset.ttf";
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

      <section style={{ ...s.section, "font-size": "12px", color: "#aaa", "line-height": "1.8" }}>
        <p><b>原理：</b>服务端根据 text 参数裁剪字体，只返回所需字符的子集。相同 URL 的请求会被浏览器自动缓存。</p>
        <p><b>基础用法：</b>将 CSS 复制到你的页面，修改 text 参数中的文字即可：</p>
        <pre style={{ ...s.pre, "font-size": "12px", "margin-top": "4px" }}>{`<style>
@font-face {
  font-family: "MyFont";
  src: url("${location.origin}/api?font=字体名&text=你的文字") format("truetype");
}
.title { font-family: "MyFont"; }
</style>
<h1 class="title">你的文字</h1>`}</pre>
        <p style={{ "margin-top": "12px" }}><b>进阶用法（推荐）：</b>动态内容场景下，使用 JS SDK 自动监听元素文字变化，按需增量加载字体片段，不会出现全量字体闪烁。<a href="/webfont-sdk.js" download="webfont-sdk.js">下载 SDK</a></p>
        <pre style={{ ...s.pre, "font-size": "12px", "margin-top": "4px" }}>{`<script src="${location.origin}/webfont-sdk.js"><\/script>
<script>
  WebFont.loadFont({
    fontName: "${selectedFont()}",
    selector: ".title",
    family: "MyFont",
  });
<\/script>`}</pre>
      </section>

      <UploadSection config={serverConfig()} onUploaded={refreshFonts} />
    </div>
  );
}

function UploadSection(props: { config: ServerConfig; onUploaded: () => void }) {
  const [tempFile, set_tempFile] = createSignal<File | null>(null);
  const [adminFile, set_adminFile] = createSignal<File | null>(null);
  const [adminApiKey, set_adminApiKey] = createSignal("");
  const [uploading, set_uploading] = createSignal(false);
  const [msg, set_msg] = createSignal<{ ok: boolean; text: string } | null>(null);

  function showMsg(ok: boolean, text: string) {
    set_msg({ ok, text });
    setTimeout(() => set_msg(null), 3000);
  }

  async function handleTempUpload() {
    const file = tempFile();
    if (!file) return;
    set_uploading(true);
    const result = await uploadFont(file, "temp");
    set_uploading(false);
    if (result.success) {
      showMsg(true, "上传成功");
      set_tempFile(null);
      props.onUploaded();
    } else {
      showMsg(false, result.error ?? "上传失败");
    }
  }

  async function handleAdminUpload() {
    const file = adminFile();
    if (!file) return;
    set_uploading(true);
    const result = await uploadFont(file, "admin", adminApiKey());
    set_uploading(false);
    if (result.success) {
      showMsg(true, "上传成功");
      set_adminFile(null);
      props.onUploaded();
    } else {
      showMsg(false, result.error ?? "上传失败");
    }
  }

  const canUpload = () => props.config.enableTempUpload || props.config.adminUploadEnabled;

  return (
    <Show when={canUpload()}>
      <section style={s.section}>
        <label style={{ ...s.label, "font-size": "14px", "font-weight": 500, "margin-bottom": "12px" }}>上传字体</label>

        <Show when={msg()}>
          {(m) => (
            <div
              style={{
                padding: "8px 12px",
                "margin-bottom": "12px",
                "border-radius": "6px",
                "font-size": "13px",
                background: m().ok ? "#f0faf0" : "#fef2f2",
                color: m().ok ? "#166534" : "#b91c1c",
                border: `1px solid ${m().ok ? "#bbf7d0" : "#fecaca"}`,
              }}
            >
              {m().text}
            </div>
          )}
        </Show>

        <Show when={props.config.enableTempUpload}>
          <div style={s.card}>
            <div style={{ "font-size": "14px", "font-weight": 500, "margin-bottom": "4px" }}>临时上传</div>
            <div style={{ "font-size": "12px", color: "#999", "margin-bottom": "12px" }}>
              最多保留 10 个文件，超出后自动删除最早上传的
            </div>
            <div style={{ display: "flex", "gap": "8px", "align-items": "center" }}>
              <label style={{ ...s.btn, display: "inline-flex", "align-items": "center", cursor: "pointer" }}>
                选择文件
                <input
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2"
                  style={{ display: "none" }}
                  onChange={(e) => set_tempFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <span style={{ "font-size": "13px", color: "#666" }}>
                {tempFile()?.name ?? "未选择文件"}
              </span>
              <button
                style={{ ...s.btn, opacity: tempFile() && !uploading() ? 1 : 0.5, cursor: tempFile() && !uploading() ? "pointer" : "not-allowed" }}
                disabled={!tempFile() || uploading()}
                onClick={handleTempUpload}
              >
                {uploading() ? "..." : "上传"}
              </button>
            </div>
          </div>
        </Show>

        <Show when={props.config.adminUploadEnabled}>
          <div style={s.card}>
            <div style={{ "font-size": "14px", "font-weight": 500, "margin-bottom": "4px" }}>管理员上传</div>
            <div style={{ "font-size": "12px", color: "#999", "margin-bottom": "12px" }}>
              永久保存，需要 API Key 认证
            </div>
            <input
              type="text"
              autocomplete="off"
              style={{ ...s.input, width: "100%", "margin-bottom": "10px" }}
              value={adminApiKey()}
              onInput={(e) => set_adminApiKey(e.target.value)}
              placeholder="API Key"
            />
            <div style={{ display: "flex", "gap": "8px", "align-items": "center" }}>
              <label style={{ ...s.btn, display: "inline-flex", "align-items": "center", cursor: "pointer" }}>
                选择文件
                <input
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2"
                  style={{ display: "none" }}
                  onChange={(e) => set_adminFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <span style={{ "font-size": "13px", color: "#666" }}>
                {adminFile()?.name ?? "未选择文件"}
              </span>
              <button
                style={{ ...s.btn, opacity: adminFile() && adminApiKey() && !uploading() ? 1 : 0.5, cursor: adminFile() && adminApiKey() && !uploading() ? "pointer" : "not-allowed" }}
                disabled={!adminFile() || !adminApiKey() || uploading()}
                onClick={handleAdminUpload}
              >
                {uploading() ? "..." : "上传"}
              </button>
            </div>
          </div>
        </Show>
      </section>
    </Show>
  );
}

export default App;
