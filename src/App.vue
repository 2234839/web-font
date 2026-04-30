<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { fetchFonts, fetchConfig } from "./api";
import type { FontInfo, ServerConfig } from "./api";

const isDev = import.meta.env.DEV;
const origin = location.origin;
import UploadSection from "./UploadSection.vue";
import StatsPanel from "./StatsPanel.vue";
import SelectorRow from "./FontSelector.vue";
import FontDebugPreview from "./FontDebugPreview.vue";

const SLOGAN = "如清风似闪电，超级快的字体子集化裁剪";

const text = ref("天地无极，乾坤借法");
const fonts = ref<FontInfo[]>([]);
const selectedFont = ref("");
const outType = ref<"woff2" | "ttf">("ttf");
const serverConfig = ref<ServerConfig>({
  enableTempUpload: false,
  adminUploadEnabled: false,
  supportedOutTypes: ["woff2", "ttf"],
});

onMounted(async () => {
  const [fontList, config] = await Promise.all([
    fetchFonts().catch(() => [] as FontInfo[]),
    fetchConfig().catch((): ServerConfig => ({ enableTempUpload: false, adminUploadEnabled: false })),
  ]);
  fonts.value = fontList;
  serverConfig.value = config;

  if (!config.supportedOutTypes?.includes(outType.value)) {
    outType.value = config.supportedOutTypes?.[0] || "ttf";
  }

  if (fontList.length > 0) {
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
    selectedFont.value = fontList[0].name;
  }
});

const cssStyle = computed(() => {
  const font = selectedFont.value;
  const ot = outType.value;
  if (!font) return "";
  const formatStr = ot === "woff2" ? "woff2" : "truetype";
  return `@font-face {
  font-family: "CustomFont";
  src: url("${origin}/api?font=${font}&text=${encodeURIComponent(text.value)}&outType=${ot}") format("${formatStr}");
}
.custom-font {
  color: red;
  font-family: "CustomFont";
}`;
});

let textLoader: { update: (text: string) => void; dispose: () => void } | null = null;

function onTextChange(value: string) {
  text.value = value;
  textLoader?.update(value);
}

const textareaRows = computed(() => {
  const lines = text.value.split("\n").length;
  return Math.max(2, Math.min(lines, 10));
});

let lastLoadKey = "";

function reloadFont(font: string, ot: "woff2" | "ttf") {
  const key = `${font}|${ot}`;
  if (!font || key === lastLoadKey) return;
  lastLoadKey = key;
  if (textLoader) textLoader.dispose();
  textLoader = (globalThis as any).WebFont?.loadText({
    fontName: font,
    text: text.value,
    family: "CustomFont",
    outType: ot,
  }) ?? null;
  const el = document.getElementById("webfont-preview");
  if (el) el.style.fontFamily = '"CustomFont", sans-serif';
}

function onFontChange(font: string) {
  selectedFont.value = font;
}

watch([selectedFont, outType], ([font, ot]) => {
  reloadFont(font, ot as "woff2" | "ttf");
});

async function refreshFonts() {
  const fontList = await fetchFonts();
  fonts.value = fontList;
  if (fontList.length > 0 && !selectedFont.value) {
    onFontChange(fontList[0].name);
  }
}
</script>

<template>
  <div style="max-width: 720px; margin: 0 auto; padding: 48px 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; line-height: 1.6">
    <div style="display: flex; align-items: center; justify-content: space-between">
      <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 4px 0">Web Font</h1>
      <a
        href="https://github.com/2234839/web-font"
        target="_blank"
        rel="noopener noreferrer"
        style="display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: #888; text-decoration: none; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 10px"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        Star on GitHub
      </a>
    </div>
    <p id="slogan" style="font-size: 24px; color: #888; margin: 0 0 36px 0">{{ SLOGAN }}</p>

    <section style="margin-bottom: 28px">
      <SelectorRow
        :fonts="fonts"
        :selectedFont="selectedFont"
        :onFontChange="onFontChange"
        :supportedOutTypes="serverConfig.supportedOutTypes || ['woff2', 'ttf']"
        :outType="outType"
        :onOutTypeChange="(v: 'woff2' | 'ttf') => outType = v"
      />
    </section>

    <section style="margin-bottom: 28px">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">输入文本预览效果</label>
      <textarea
        id="webfont-preview"
        :rows="textareaRows"
        :value="text"
        @input="onTextChange(($event.target as HTMLTextAreaElement).value)"
        placeholder="在此输入文本..."
        style="width: 100%; padding: 8px 12px; font-size: 32px; border: 1px solid #d9d9d9; border-radius: 6px; resize: none; box-sizing: border-box; outline: none; color: #e74c3c; line-height: 1.4"
      />
    </section>

    <section v-if="selectedFont" style="margin-bottom: 28px">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
        <label style="display: block; font-size: 13px; color: #555; margin: 0">CSS 代码</label>
        <div style="display: flex; gap: 6px">
          <button
            style="padding: 3px 12px; font-size: 12px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333"
            @click="() => {
              const a = document.createElement('a');
              a.href = `/api?font=${selectedFont}&text=${encodeURIComponent(text)}&outType=${outType}`;
              a.download = selectedFont.replace(/\.[^.]+$/, '') + `_subset.${outType}`;
              a.click();
            }"
          >
            下载字体
          </button>
          <button
            style="padding: 3px 12px; font-size: 12px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333"
            @click="async (e: MouseEvent) => {
              const btn = e.currentTarget as HTMLButtonElement;
              try {
                await navigator.clipboard.writeText(cssStyle);
                btn.textContent = '已复制';
                setTimeout(() => { btn.textContent = '复制 CSS'; }, 1500);
              } catch {
                btn.textContent = '复制失败';
                setTimeout(() => { btn.textContent = '复制 CSS'; }, 1500);
              }
            }"
          >
            复制 CSS
          </button>
        </div>
      </div>
      <pre style="background: #f7f7f8; padding: 16px; border-radius: 6px; font-size: 13px; font-family: 'SF Mono', Menlo, Consolas, monospace; overflow: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; margin: 0">{{ cssStyle }}</pre>
    </section>

    <FontDebugPreview v-if="isDev" />

    <UploadSection :config="serverConfig" :onUploaded="refreshFonts" />

    <StatsPanel />

    <section style="margin-bottom: 28px; font-size: 12px; color: #aaa; line-height: 1.8">
      <p><b>原理：</b>服务端根据 text 参数裁剪字体，只返回所需字符的子集。相同 URL 的请求会被浏览器自动缓存。</p>
      <p><b>基础用法：</b>将 CSS 复制到你的页面，修改 text 参数中的文字即可：</p>
      <pre style="background: #f7f7f8; padding: 16px; border-radius: 6px; font-size: 13px; font-family: 'SF Mono', Menlo, Consolas, monospace; overflow: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; margin-top: 4px">{{ `&lt;style&gt;\n@font-face {\n  font-family: "MyFont";\n  src: url("${origin}/api?font=字体名&text=你的文字") format("woff2");\n}\n.title { font-family: "MyFont"; }\n&lt;/style&gt;\n&lt;h1 class="title"&gt;你的文字&lt;/h1&gt;` }}</pre>
      <p style="margin-top: 12px"><b>JS SDK（推荐）：</b>增量加载字体片段，按需请求，不会出现全量字体闪烁。<a href="/webfont-sdk.js" download="webfont-sdk.js">下载 SDK</a></p>
      <pre style="background: #f7f7f8; padding: 16px; border-radius: 6px; font-size: 13px; font-family: 'SF Mono', Menlo, Consolas, monospace; overflow: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; margin-top: 4px">{{ `&lt;script src="${origin}/webfont-sdk.js"&gt;&lt;/script&gt;\n&lt;script&gt;\n  WebFont.loadFont({\n    fontName: "字体文件名.ttf",\n    selector: ".my-element",\n    family: "MyFont",\n    interval: 1000,\n  });\n&lt;/script&gt;` }}</pre>
      <p style="margin-top: 8px">还支持 <code>WebFont.observeFont()</code>（MutationObserver 事件驱动）和 <code>WebFont.loadText()</code>（手动传文本）两种方式，多种方式可同时使用，SDK 内部自动按字体去重增量加载。</p>
    </section>

    <footer style="margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center">
      <p>感谢 <a href="https://www.ruanyifeng.com/blog/2020/03/weekly-issue-100.html" target="_blank" rel="noopener noreferrer" style="color: #999">阮一峰科技爱好者周刊（第 100 期）</a> 收录本项目</p>
      <p style="margin-top: 8px">觉得好用？<a href="https://shenzilong.cn/%E5%85%B3%E4%BA%8E/%E8%B5%9E%E5%8A%A9.html#20241227142305-g5225eu" target="_blank" rel="noopener noreferrer" style="color: #e6a700; text-decoration: underline">请作者喝杯咖啡</a>，支持持续开发</p>
    </footer>

    <a
      href="https://shenzilong.cn/%E5%85%B3%E4%BA%8E/%E8%B5%9E%E5%8A%A9.html#20241227142305-g5225eu"
      target="_blank"
      rel="noopener noreferrer"
      style="position: fixed; right: 0; top: 50%; transform: translateY(-50%); background: #e6a700; color: #fff; padding: 12px 6px; font-size: 12px; writing-mode: vertical-rl; text-decoration: none; border-radius: 6px 0 0 6px; box-shadow: -2px 0 8px rgba(0,0,0,0.1); z-index: 999; transition: padding 0.2s"
      onmouseover="this.style.paddingRight='10px'"
      onmouseout="this.style.paddingRight='6px'"
    >
      赞助支持
    </a>
  </div>
</template>
