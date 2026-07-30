<script setup lang="ts">
/**
 * 字体详情页 —— 展示单个字体的完整预览效果
 *
 * SSG 策略：构建时预渲染路由 /fonts/__FONT_NAME__，
 * 产出完整 HTML 模板（title/meta/body 全含占位符）。
 * 后端收到 /fonts/实际字体名 时读取模板做字符串替换返回。
 */
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useHead } from "@unhead/vue";
import { fetchFonts } from "../api";
import type { FontInfo } from "../api";
import { FONT_NAME, FONT_SLUG, ORIGIN } from "../placeholders";
import { SITE_NAME } from "../seo";

const route = useRoute();
const router = useRouter();

/** 字体名 —— SSG 时为占位符，客户端 hydrate 后为真实字体名 */
const fontName = computed(() => decodeURIComponent(String(route.params.slug || "")));

/** 站点 origin —— SSG 时为占位符，客户端为真实地址 */
const origin = ref(ORIGIN);

/** SEO —— 使用占位符值，SSG 产出的 HTML 含占位符，后端替换 */
useHead({
  title: `${FONT_NAME} 字体预览 | ${SITE_NAME}`,
  meta: [
    {
      name: "description",
      content: `${FONT_NAME} 在线预览 — 服务端按需裁剪字体子集，woff2/ttf 格式，免费使用。WebFont 提供增量加载 SDK，轻松嵌入任何网站。`,
    },
    { property: "og:title", content: `${FONT_NAME} 字体预览` },
    {
      property: "og:description",
      content: `${FONT_NAME} 在线预览 — 按需裁剪，免费使用`,
    },
    { property: "og:url", content: `${ORIGIN}/fonts/${FONT_SLUG}` },
    { property: "og:type", content: "website" },
  ],
});

const fonts = ref<FontInfo[]>([]);
const notFound = ref(false);

onMounted(async () => {
  origin.value = location.origin;
  const allFonts = await fetchFonts().catch(() => []);
  fonts.value = allFonts;
  notFound.value = allFonts.length > 0 && !allFonts.some((f) => f.name === fontName.value);
});
</script>

<template>
  <div style="min-height: 100vh; background: #fafafa">
    <!-- 字体加载：SSG 时含占位符，后端替换后即指向正确字体子集 -->
    <link
      rel="stylesheet"
      :href="`${origin}/api?font=${fontName}&text=静心茶舍以茶为媒观自在一叶知秋山间晨露未晞茶人已入林深处指尖轻捻择其嫩芽天地无极乾坤借法&outType=woff2`"
    />

    <!-- 顶部导航 -->
    <div
      style="
        position: sticky;
        top: 0;
        z-index: 100;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid #eee;
        padding: 12px 24px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      "
    >
      <button
        style="
          padding: 6px 16px;
          border: 1px solid #ddd;
          border-radius: 6px;
          background: #fff;
          cursor: pointer;
          font-size: 14px;
        "
        @click="router.push('/fonts')"
      >
        ← 返回列表
      </button>
      <span style="font-size: 13px; color: #888">
        <a
          href="https://github.com/2234839/web-font"
          target="_blank"
          style="color: #8b7355; text-decoration: none"
          >WebFont →</a
        >
      </span>
    </div>

    <!-- 字体名称 -->
    <div style="text-align: center; padding: 60px 24px 40px">
      <h1
        :data-font="fontName"
        style="font-size: 36px; font-weight: 700; color: #2c2c2c; margin: 0; line-height: 1.3"
      >
        {{ fontName }}
      </h1>
      <p v-if="notFound" style="font-size: 14px; color: #e74c3c; margin: 12px 0 0">
        ⚠ 该字体不存在或已被删除
      </p>
      <p v-else style="font-size: 14px; color: #999; margin: 12px 0 0">
        在线预览 · 按需裁剪 · 免费使用
      </p>
    </div>

    <!-- 字体预览区域 -->
    <div style="max-width: 800px; margin: 0 auto; padding: 0 24px 80px">
      <!-- 大标题预览 -->
      <div
        style="
          background: #fff;
          border-radius: 12px;
          padding: 48px 40px;
          text-align: center;
          margin-bottom: 24px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        "
      >
        <div
          :style="{
            fontFamily: `'${fontName}', sans-serif`,
            fontSize: '56px',
            fontWeight: 600,
            color: '#2c2c2c',
            lineHeight: 1.3,
          }"
        >
          静心茶舍
        </div>
        <p
          :style="{
            fontFamily: `'${fontName}', sans-serif`,
            fontSize: '16px',
            color: '#888',
            margin: '20px 0 0',
            letterSpacing: '0.1em',
          }"
        >
          以茶为媒 · 静心观自在
        </p>
      </div>

      <!-- 正文预览 -->
      <div
        style="
          background: #fff;
          border-radius: 12px;
          padding: 40px;
          margin-bottom: 24px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        "
      >
        <h2
          :style="{
            fontFamily: `'${fontName}', serif`,
            fontSize: '24px',
            fontWeight: 600,
            margin: '0 0 20px',
            color: '#3a3a3a',
          }"
        >
          一叶知秋
        </h2>
        <p
          :style="{
            fontFamily: `'${fontName}', serif`,
            fontSize: '16px',
            lineHeight: 1.8,
            color: '#4a4a4a',
            textIndent: '2em',
            margin: 0,
          }"
        >
          山间晨露未晞，茶人已入林深处。指尖轻捻，择其嫩芽一二，置于竹篮之中。此乃一年之始，亦是一叶与万物的初遇。
        </p>
      </div>

      <!-- 字符集预览 -->
      <div
        style="
          background: #fff;
          border-radius: 12px;
          padding: 32px 40px;
          margin-bottom: 24px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        "
      >
        <div style="font-size: 13px; font-weight: 600; color: #999; margin-bottom: 16px">
          字符预览
        </div>
        <div
          :style="{
            fontFamily: `'${fontName}', monospace`,
            fontSize: '18px',
            color: '#555',
            lineHeight: 2,
            wordBreak: 'break-all',
          }"
        >
          天地无极乾坤借法：0123456789 ABCDEF
        </div>
      </div>

      <!-- 使用方法 -->
      <div
        style="
          background: #fff;
          border-radius: 12px;
          padding: 32px 40px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        "
      >
        <div style="font-size: 13px; font-weight: 600; color: #999; margin-bottom: 16px">
          使用方法
        </div>
        <pre
          style="
            background: #f5f5f5;
            padding: 16px 20px;
            border-radius: 8px;
            font-size: 13px;
            overflow-x: auto;
            margin: 0;
            color: #333;
          "
        ><code>&lt;link rel="stylesheet"
  href="{{ origin }}/api?font={{ fontName }}&amp;text=你的文字&amp;outType=woff2"&gt;

&lt;style&gt;
  .my-title { font-family: "{{ fontName }}"; }
&lt;/style&gt;</code></pre>
      </div>
    </div>
  </div>
</template>
