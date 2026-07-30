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
import { fetchFonts, fetchFontMeta } from "../api";
import type { FontInfo, FontMeta } from "../api";
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
/** 字体元数据（字符覆盖率） */
const meta = ref<FontMeta | null>(null);
const metaLoading = ref(false);

onMounted(async () => {
  origin.value = location.origin;
  const [allFonts] = await Promise.all([
    fetchFonts().catch(() => [] as FontInfo[]),
  ]);
  fonts.value = allFonts;
  notFound.value = allFonts.length > 0 && !allFonts.some((f) => f.name === fontName.value);

  /** 加载字体元数据（覆盖率+支持的字符集） */
  metaLoading.value = true;
  meta.value = await fetchFontMeta(fontName.value).catch(() => null);
  metaLoading.value = false;
});

/**
 * 将分号分隔的长文本拆成多行数组。
 * 字体 name 表中 designer/description 等字段常把多人用 ";" 连接，
 * 拆分后逐行渲染更清晰。
 */
function splitSemicolon(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 默认预览文案（font-config.json 未配 previewText 时使用） */
const DEFAULT_PREVIEW = "静心茶舍以茶为媒观自在一叶知秋山间晨露未晞茶人已入林深处指尖轻捻择其嫩芽天地无极乾坤借法";

/** 当前字体的预览文案：优先用 config.previewText */
const previewContent = computed(() => meta.value?.config?.previewText ?? DEFAULT_PREVIEW);

/** 预览文字拆分：第一段做大标题，其余做副文本 */
const previewLines = computed(() => {
  const text = previewContent.value;
  /** 按空格拆分，第一段做大字标题 */
  const parts = text.split(/\s+/).filter(Boolean);
  return {
    title: parts[0] ?? text,
    subtitle: parts.slice(1).join(" ") || "",
    full: text,
  };
});

/** 正文标题：优先 config.bodyTitle */
const bodyTitle = computed(() => meta.value?.config?.bodyTitle ?? "清风明月");

/** 正文段落：优先 config.bodyText */
const bodyText = computed(() => meta.value?.config?.bodyText ?? "山中有桂树，常伴青云飞。");

/** 字符预览行：优先 config.charsetPreview */
const charsetPreview = computed(() => meta.value?.config?.charsetPreview ?? "天地玄黄宇宙洪荒：0123456789 ABCDEF");
</script>

<template>
  <div style="min-height: 100vh; background: #fafafa">
    <!-- 字体加载：SSG 时含占位符，后端替换后即指向正确字体子集 -->
    <link
      rel="stylesheet"
      :href="`${origin}/api?font=${fontName}&text=${encodeURIComponent(previewContent)}&outType=woff2`"
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
        {{ meta?.config?.displayName ?? fontName }}
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
        v-if="meta"
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
          {{ previewLines.title }}
        </div>
        <p
          v-if="previewLines.subtitle"
          :style="{
            fontFamily: `'${fontName}', sans-serif`,
            fontSize: '16px',
            color: '#888',
            margin: '20px 0 0',
            letterSpacing: '0.1em',
          }"
        >
          {{ previewLines.subtitle }}
        </p>
      </div>

      <!-- 正文预览 -->
      <div
        v-if="meta"
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
          {{ bodyTitle }}
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
          {{ bodyText }}
        </p>
      </div>

      <!-- 字符集预览 -->
      <div
        v-if="meta"
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
          {{ charsetPreview }}
        </div>
      </div>

      <!-- 字符覆盖率 -->
      <div
        v-if="metaLoading || meta"
        style="
          background: #fff;
          border-radius: 12px;
          padding: 32px 40px;
          margin-bottom: 24px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        "
      >
        <!-- 标签 + 开源链接 -->
        <div
          v-if="meta?.config"
          style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px"
        >
          <span
            v-for="tag in meta.config.tags"
            :key="tag"
            style="
              font-size: 12px;
              padding: 3px 10px;
              border-radius: 12px;
              background: #f0f5ff;
              color: #1677ff;
            "
          >{{ tag }}</span>
          <a
            v-if="meta.config.homepage"
            :href="meta.config.homepage"
            target="_blank"
            style="
              font-size: 12px;
              padding: 3px 10px;
              border-radius: 12px;
              background: #f6f6f6;
              color: #666;
              text-decoration: none;
              display: inline-flex;
              align-items: center;
              gap: 4px;
            "
          >📎 开源仓库</a>
        </div>

        <!-- 简介 -->
        <p
          v-if="meta?.config?.description"
          style="font-size: 14px; color: #666; line-height: 1.7; margin: 0 0 20px"
        >
          {{ meta.config.description }}
        </p>

        <div style="font-size: 13px; font-weight: 600; color: #999; margin-bottom: 16px">
          字符覆盖率
          <span v-if="meta" style="font-weight: 400; margin-left: 8px; color: #bbb">
            共 {{ meta.totalCodePoints }} 个字符
          </span>
        </div>

        <div v-if="metaLoading" style="color: #ccc; font-size: 14px">分析中...</div>

        <div v-else-if="meta" style="display: flex; flex-direction: column; gap: 12px">
          <div v-for="item in meta.coverage" :key="item.name">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px">
              <span style="font-size: 13px; color: #555">{{ item.name }}</span>
              <span style="font-size: 12px; color: #999">
                {{ item.covered }}/{{ item.total }} · {{ item.percent }}%
              </span>
            </div>
            <!-- 进度条 -->
            <div style="height: 6px; background: #f0f0f0; border-radius: 3px; overflow: hidden">
              <div
                :style="{
                  width: item.percent + '%',
                  height: '100%',
                  borderRadius: '3px',
                  transition: 'width 0.4s ease',
                  background:
                    item.percent >= 90
                      ? '#52c41a'
                      : item.percent >= 50
                        ? '#faad14'
                        : '#ff4d4f',
                }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 字体信息（来自 name 表） -->
      <div
        v-if="meta?.info"
        style="
          background: #fff;
          border-radius: 12px;
          padding: 32px 40px;
          margin-bottom: 24px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        "
      >
        <div style="font-size: 13px; font-weight: 600; color: #999; margin-bottom: 16px">
          字体信息
        </div>
        <div style="display: grid; grid-template-columns: 80px 1fr; gap: 10px 16px; font-size: 13px">
          <template v-if="meta.info.designer">
            <span style="color: #999">设计师</span>
            <span style="color: #555; display: flex; flex-direction: column; gap: 4px">
              <span v-for="d in splitSemicolon(meta.info.designer)" :key="d">{{ d }}</span>
            </span>
          </template>
          <template v-if="meta.info.manufacturer">
            <span style="color: #999">制造商</span>
            <span style="color: #555">{{ meta.info.manufacturer }}</span>
          </template>
          <template v-if="meta.info.version">
            <span style="color: #999">版本</span>
            <span style="color: #555">{{ meta.info.version }}</span>
          </template>
          <template v-if="meta.info.copyright">
            <span style="color: #999">版权</span>
            <span style="color: #555">{{ meta.info.copyright }}</span>
          </template>
          <template v-if="meta.info.license">
            <span style="color: #999">许可</span>
            <span style="color: #555">{{ meta.info.license }}</span>
          </template>
          <template v-if="meta.info.licenseUrl">
            <span style="color: #999">许可链接</span>
            <a :href="meta.info.licenseUrl" target="_blank" style="color: #1677ff; text-decoration: none">{{ meta.info.licenseUrl }}</a>
          </template>
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
