<script setup lang="ts">
/**
 * /docs 路由 —— SDK 集成文档（独立页面）
 *
 * 由首页 sdk-doc section 拆分而来，便于单独分享、被搜索引擎索引。
 * 代码示例依赖 origin（客户端挂载后修正为 location.origin）。
 */
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { usePageSeo } from "../useSeo";
import { t, toggleLocale, locale, syncLocaleFromStorage } from "../i18n";
import CodeBlock from "../components/CodeBlock.vue";

/** 文档页 SEO：独立 title/description，可被搜索引擎单独索引 */
usePageSeo({
  title: "SDK 集成文档 | 按需加载中文字体",
  description:
    "WebFont SDK 集成文档 — @font-face 基础用法与 JS SDK 增量加载，只加载页面用到的字符，轻松为任何网站接入中文字体子集化。",
  path: "/docs",
  priority: 0.8,
  changefreq: "weekly",
});

const router = useRouter();

/** 站点 origin —— SSG 构建期为空串，客户端挂载后修正 */
const origin = ref("");

onMounted(() => {
  syncLocaleFromStorage();
  origin.value = location.origin;
});

/** 基础用法代码示例（依赖 origin，需 computed） */
const basicUsageCode = computed(() => {
  return '<style>\n@font-face {\n  font-family: "MyFont";\n  src: url("' + origin.value + '/api?font=字体名&text=你的文字") format("woff2");\n}\n.title { font-family: "MyFont"; }\n</style>\n<h1 class="title">你的文字</h1>';
});

/** JS SDK 代码示例 */
const jsSdkCode = computed(() => {
  return '<script src="' + origin.value + '/webfont-sdk.js"><\/script>\n\n<h1 class="title">你的文字</h1>\n<p class="content">输入任意文字，SDK 自动裁剪加载</p>\n\n<script>\n  WebFont.observeFont({\n    fontName: "字体文件名.ttf",\n    selector: ".title, .content",\n    family: "MyFont",\n  });\n<\/script>';
});
</script>

<template>
  <div style="max-width: 720px; margin: 0 auto; padding: 48px 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; line-height: 1.6">
    <!-- 标题栏 -->
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 24px">
      <div>
        <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 4px 0">{{ t('docsTitle') }}</h1>
        <p style="font-size: 13px; color: #999; margin: 0">{{ t('docsSubtitle') }}</p>
      </div>
      <div style="display: flex; gap: 8px; align-items: center">
        <button @click="toggleLocale" style="font-size: 13px; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 12px; cursor: pointer; background: #fff; color: #333">
          {{ locale === 'zh' ? 'EN' : '中' }}
        </button>
        <button @click="router.push('/')" style="font-size: 13px; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 12px; cursor: pointer; background: #fff; color: #333">
          {{ t('back') }}
        </button>
      </div>
    </div>

    <div style="font-size: 14px; color: #444; line-height: 1.9">
      <p><b>{{ t('principle') }}</b>{{ t('principleText') }}</p>

      <p style="margin-top: 16px"><b>{{ t('basicUsage') }}</b>{{ t('basicUsageText') }}</p>
      <div style="margin-top: 4px"><CodeBlock :code="basicUsageCode" lang="html" /></div>

      <p style="margin-top: 20px"><b>{{ t('jsSdk') }}</b>{{ t('jsSdkText') }}<a href="/webfont-sdk.js" download="webfont-sdk.js" style="color: #1677ff">{{ t('downloadSdk') }}</a></p>
      <div style="margin-top: 4px"><CodeBlock :code="jsSdkCode" lang="html" /></div>

      <p style="margin-top: 12px">{{ t('sdkModes') }}<code>WebFont.observeFont()</code>{{ t('observeFont') }}<code>WebFont.loadText()</code>{{ t('loadText') }}</p>
    </div>
  </div>
</template>
