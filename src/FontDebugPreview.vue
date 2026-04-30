<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import type { FontInfo } from "./api";

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
  <section style="margin-bottom: 28px; padding: 16px; border: 2px dashed #e6a700; border-radius: 8px; background: #fffdf5">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px">
      <span style="font-size: 13px; font-weight: 600; color: #e6a700">DEV 字体调试预览</span>
      <span style="font-size: 11px; color: #aaa">所有字体的 woff2 / ttf 渲染效果</span>
    </div>
    <div v-for="font in fonts" :key="font.name" style="margin-bottom: 12px; padding: 8px 12px; background: #fff; border: 1px solid #e8e8e8; border-radius: 6px">
      <div style="font-size: 11px; color: #999; margin-bottom: 6px; display: flex; justify-content: space-between">
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
  </section>
</template>
