<script setup lang="ts">
/**
 * 开发环境专用字体预览页 —— 展示所有字体的 woff2 / ttf 渲染效果
 *
 * 仅 dev 模式下路由可达，生产构建不包含此页面。
 */
import { ref, onMounted, onUnmounted } from "vue";
import { usePageSeo } from "../useSeo";

usePageSeo({
  title: "DEV 字体预览",
  description: "开发环境专用字体渲染预览",
  path: "/__dev",
  priority: 0,
  changefreq: "never",
});

import type { FontInfo } from "../api";

const PREVIEW_TEXT = `天地无极乾坤借法："":"" 0123456789 ABCDEF`;
const fonts = ref<FontInfo[]>([]);
const loaders = new Map<string, { update: (text: string) => void; dispose: () => void }>();

onMounted(async () => {
  const res = await fetch("/api/fonts");
  const fontList: FontInfo[] = await res.json();
  const usableFonts = fontList.filter((f) => /\.(ttf|otf)$/i.test(f.name));
  fonts.value = usableFonts;

  for (const font of usableFonts) {
    const base = font.name.replace(/\.[^.]+$/, "");
    for (const ot of ["woff2", "ttf"] as const) {
      const family = `DevPreview_${base}_${ot}`;
      const loader = (globalThis as any).WebFont?.loadText({
        fontName: font.name,
        text: PREVIEW_TEXT,
        family,
        outType: ot,
      });
      if (loader) loaders.set(`${font.name}|${ot}`, loader);
    }
  }
});

onUnmounted(() => {
  for (const loader of loaders.values()) loader.dispose();
  loaders.clear();
});

function fontFamily(font: FontInfo, ot: string) {
  const base = font.name.replace(/\.[^.]+$/, "");
  return `"DevPreview_${base}_${ot}", "楷体", KaiTi, STKaiti, serif`;
}
</script>

<template>
  <div style="max-width: 960px; margin: 0 auto; padding: 32px 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; line-height: 1.6">
    <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 4px 0">
      DEV 字体预览
      <span style="font-size: 13px; color: #999; font-weight: 400">所有字体的 woff2 / ttf 渲染效果</span>
    </h1>
    <router-link to="/" style="display: inline-block; margin-bottom: 20px; font-size: 13px; color: #1677ff; text-decoration: none; border: 1px solid #1677ff; border-radius: 6px; padding: 4px 12px">
      ← 返回首页
    </router-link>

    <div v-for="font in fonts" :key="font.name" style="margin-bottom: 12px; padding: 12px 16px; background: #fff; border: 1px solid #e8e8e8; border-radius: 6px">
      <div style="font-size: 13px; color: #999; margin-bottom: 8px; display: flex; justify-content: space-between">
        <span style="font-weight: 500; color: #555">{{ font.name }}</span>
        <span style="color: #bbb">{{ font.dir }}</span>
      </div>
      <div v-for="ot in (['woff2', 'ttf'] as const)" :key="ot" style="margin-bottom: 4px; display: flex; align-items: baseline; gap: 8px">
        <span style="font-size: 11px; color: #bbb; min-width: 40px; flex: none">{{ ot }}</span>
        <div
          :style="{ fontSize: '22px', lineHeight: '1.5', color: '#1a1a1a', minHeight: '36px', fontFamily: fontFamily(font, ot) }"
        >
          {{ PREVIEW_TEXT }}
        </div>
      </div>
    </div>
  </div>
</template>
