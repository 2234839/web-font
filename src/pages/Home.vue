<script setup lang="ts">
/**
 * 首页 —— 字体裁剪工具（SPA 行为，交互为主）
 *
 * 由原 App.vue 拆分而来，去掉了 TypographyDemo 的伪路由切换，
 * demo 改为独立路由 /demo（见 Demo.vue）。
 * onMounted 内的所有浏览器 API 调用确保只在客户端执行，SSG 预渲染阶段不触发。
 */
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { fetchFonts, fetchConfig } from "../api";
import type { FontInfo, ServerConfig } from "../api";
import { t, toggleLocale, locale, syncLocaleFromStorage } from "../i18n";
import { usePageSeo } from "../useSeo";

/** 首页 SEO：首页是核心工具页，优先级最高 */
usePageSeo({
  title: "在线字体裁剪 | 按需加载 | 免费开源",
  description:
    "在线字体裁剪工具 — 服务端按需裁剪字体子集，大小无限制，免费开源。支持自定义裁剪、增量加载 SDK，轻松嵌入任何网站。",
  path: "/",
  priority: 1.0,
  changefreq: "weekly",
});

const router = useRouter();
const isDev = import.meta.env.DEV;

/** 站点 origin —— SSG 构建期为空串，客户端挂载后修正 */
const origin = ref("");
/** 是否带 ?demo 查询参数（兼容旧入口，重定向到 /demo 路由） */
const showDemoEntry = ref(false);

import UploadSection from "../UploadSection.vue";
import StatsPanel from "../StatsPanel.vue";
import SelectorRow from "../FontSelector.vue";
import FontDebugPreview from "../FontDebugPreview.vue";
import CodeBlock from "../components/CodeBlock.vue";

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
  /** 客户端挂载：修正 SSG 阶段无法获取的语言偏好 */
  syncLocaleFromStorage();
  origin.value = location.origin;
  showDemoEntry.value = location.search.includes("demo");
  /** 兼容旧 ?demo 入口：直接跳转到 /demo 独立路由 */
  if (showDemoEntry.value) {
    router.replace("/demo");
    return;
  }

  const [fontList, config] = await Promise.all([
    fetchFonts().catch(() => [] as FontInfo[]),
    fetchConfig().catch((): ServerConfig => ({ enableTempUpload: false, adminUploadEnabled: false, supportedOutTypes: ["woff2", "ttf"] })),
  ]);
  fonts.value = fontList;
  serverConfig.value = config;

  if (!config.supportedOutTypes?.includes(outType.value)) {
    outType.value = config.supportedOutTypes?.[0] || "ttf";
  }

  if (fontList.length > 0) {
    const usableFonts = fontList.filter((f) => /\.(ttf)$/i.test(f.name));
    const randomFont = usableFonts[Math.floor(Math.random() * usableFonts.length)];
    const sloganText = t("slogan");
    (globalThis as any).WebFont?.loadText({
      fontName: randomFont.name,
      text: sloganText,
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
  /** origin.value 在 SSG 构建期为空串，客户端 onMounted 后修正为 location.origin */
  return `@font-face {
  font-family: "CustomFont";
  src: url("${origin.value}/api?font=${font}&text=${encodeURIComponent(text.value)}&outType=${ot}") format("${formatStr}");
}
.custom-font {
  color: red;
  font-family: "CustomFont";
}`;
});

/** 基础用法代码示例（依赖 origin，需 computed） */
const basicUsageCode = computed(() => {
  return '<style>\n@font-face {\n  font-family: "MyFont";\n  src: url("' + origin.value + '/api?font=\u5b57\u4f53\u540d&text=\u4f60\u7684\u6587\u5b57") format("woff2");\n}\n.title { font-family: "MyFont"; }\n</style>\n<h1 class="title">\u4f60\u7684\u6587\u5b57</h1>';
});

/** JS SDK 代码示例 */
const jsSdkCode = computed(() => {
  return '<script src="' + origin.value + '/webfont-sdk.js"><\/script>\n<script>\n  WebFont.loadFont({\n    fontName: "\u5b57\u4f53\u6587\u4ef6\u540d.ttf",\n    selector: ".my-element",\n    family: "MyFont",\n    interval: 1000,\n  });\n<\/script>';
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

/** 下载当前裁剪后的字体文件 */
function downloadSubsetFont() {
  const font = selectedFont.value;
  if (!font) return;
  const a = document.createElement("a");
  a.href = `/api?font=${font}&text=${encodeURIComponent(text.value)}&outType=${outType.value}`;
  a.download = font.replace(/\.[^.]+$/, "") + `_subset.${outType.value}`;
  a.click();
}

/** 复制 CSS 到剪贴板，按钮文案短暂反馈结果 */
async function copyCss(e: MouseEvent) {
  const btn = e.currentTarget as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText(cssStyle.value);
    btn.textContent = t("copied");
    setTimeout(() => {
      btn.textContent = t("copyCss");
    }, 1500);
  } catch {
    btn.textContent = t("copyFailed");
    setTimeout(() => {
      btn.textContent = t("copyCss");
    }, 1500);
  }
}

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
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
      <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 4px 0">Web Font</h1>
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; flex-shrink: 0">
        <button @click="toggleLocale" style="font-size: 13px; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 12px; cursor: pointer; background: #fff; color: #333; white-space: nowrap; flex-shrink: 0; line-height: 1.6">
          {{ locale === 'zh' ? 'EN' : '中' }}
        </button>
        <router-link to="/fonts" style="font-size: 13px; color: #fff; text-decoration: none; border-radius: 6px; padding: 5px 14px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex-shrink: 0; background: linear-gradient(135deg, #1677ff, #0958d9); font-weight: 500; box-shadow: 0 2px 8px rgba(22, 119, 255, 0.3)">
          {{ t('browseFonts') }}
        </router-link>
        <router-link to="/demo" style="font-size: 13px; color: #8b7355; text-decoration: none; border: 1px solid #8b7355; border-radius: 6px; padding: 4px 12px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex-shrink: 0">
          {{ t('agentSkillDemo') }}
        </router-link>
        <a
          href="https://github.com/2234839/web-font"
          target="_blank"
          rel="noopener noreferrer"
          style="display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: #888; text-decoration: none; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 10px; white-space: nowrap; flex-shrink: 0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          Star on GitHub
        </a>
      </div>
    </div>
    <p id="slogan" style="font-size: 24px; color: #888; margin: 0 0 36px 0">{{ t('slogan') }}</p>

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
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">{{ t('inputLabel') }}</label>
      <textarea
        id="webfont-preview"
        :rows="textareaRows"
        :value="text"
        @input="onTextChange(($event.target as HTMLTextAreaElement).value)"
        :placeholder="t('inputPlaceholder')"
        style="width: 100%; padding: 8px 12px; font-size: 32px; border: 1px solid #d9d9d9; border-radius: 6px; resize: none; box-sizing: border-box; outline: none; color: #e74c3c; line-height: 1.4"
      />
    </section>

    <section v-if="selectedFont" style="margin-bottom: 28px">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
        <label style="display: block; font-size: 13px; color: #555; margin: 0">{{ t('cssLabel') }}</label>
        <div style="display: flex; gap: 6px">
          <button
            style="padding: 3px 12px; font-size: 12px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333"
            @click="downloadSubsetFont"
          >
            {{ t('downloadFont') }}
          </button>
          <button
            style="padding: 3px 12px; font-size: 12px; border: 1px solid #d9d9d9; border-radius: 6px; cursor: pointer; background: #fff; color: #333"
            @click="copyCss"
          >
            {{ t('copyCss') }}
          </button>
        </div>
      </div>
      <CodeBlock :code="cssStyle" lang="css" />
    </section>

    <FontDebugPreview v-if="isDev" />

    <UploadSection :config="serverConfig" :onUploaded="refreshFonts" />

    <StatsPanel />

    <section style="margin-bottom: 28px; font-size: 12px; color: #aaa; line-height: 1.8">
      <p><b>{{ t('principle') }}</b>{{ t('principleText') }}</p>
      <p><b>{{ t('basicUsage') }}</b>{{ t('basicUsageText') }}</p>
      <div style="margin-top: 4px"><CodeBlock :code="basicUsageCode" lang="html" /></div>
      <p style="margin-top: 12px"><b>{{ t('jsSdk') }}</b>{{ t('jsSdkText') }}<a href="/webfont-sdk.js" download="webfont-sdk.js">{{ t('downloadSdk') }}</a></p>
      <div style="margin-top: 4px"><CodeBlock :code="jsSdkCode" lang="html" /></div>
      <p style="margin-top: 8px">{{ t('sdkModes') }}<code>WebFont.observeFont()</code>{{ t('observeFont') }}<code>WebFont.loadText()</code>{{ t('loadText') }}</p>
    </section>

    <footer style="margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center">
      <p>{{ t('thanks') }}<a href="https://www.ruanyifeng.com/blog/2020/03/weekly-issue-100.html" target="_blank" rel="noopener noreferrer" style="color: #999">阮一峰科技爱好者周刊（第 100 期）</a> {{ t('thanksText') }}</p>
      <p style="margin-top: 8px">{{ t('buyCoffee') }}<a href="https://shenzilong.cn/%E5%85%B3%E4%BA%8E/%E8%B5%9E%E5%8A%A9.html#" target="_blank" rel="noopener noreferrer" style="color: #e6a700; text-decoration: underline">{{ t('buyCoffeeAction') }}</a>{{ t('buyCoffeeSuffix') }}</p>
      <p style="margin-top: 12px"><a href="https://github.com/2234839/web-font/blob/new/skills/chinese-web-font.md" target="_blank" style="color: #8b7355; text-decoration: underline">{{ t('viewSkill') }}</a></p>
    </footer>

    <a
      href="https://shenzilong.cn/%E5%85%B3%E4%BA%8E/%E8%B5%9E%E5%8A%A9.html#"
      target="_blank"
      rel="noopener noreferrer"
      style="position: fixed; right: 0; top: 50%; transform: translateY(-50%); background: #e6a700; color: #fff; padding: 12px 6px; font-size: 12px; writing-mode: vertical-rl; text-decoration: none; border-radius: 6px 0 0 6px; box-shadow: -2px 0 8px rgba(0,0,0,0.1); z-index: 999; transition: padding 0.2s"
      onmouseover="this.style.paddingRight='10px'"
      onmouseout="this.style.paddingRight='6px'"
    >
      {{ t('sponsor') }}
    </a>
  </div>
</template>
