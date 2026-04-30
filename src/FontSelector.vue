<script setup lang="ts">
import type { FontInfo } from "./api";

const outTypeLabels = {
  woff2: "WOFF2 体积更小",
  ttf: "TTF 速度更快",
};

const outTypeDescs = {
  woff2: "约压缩 50%，适合生产",
  ttf: "无编码开销，适合开发",
};

defineProps<{
  fonts: FontInfo[];
  selectedFont: string;
  onFontChange: (font: string) => void;
  supportedOutTypes: ("woff2" | "ttf")[];
  outType: "woff2" | "ttf";
  onOutTypeChange: (v: "woff2" | "ttf") => void;
}>();
</script>

<template>
  <div style="display: flex; gap: 12px">
    <div style="flex: 1">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">选择字体</label>
      <select
        :value="selectedFont"
        @change="onFontChange(($event.target).value)"
        style="width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; cursor: pointer; appearance: none; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px"
      >
        <option value="">-- 请选择 --</option>
        <option v-for="f in fonts" :key="f.name" :value="f.name">{{ f.name }}</option>
      </select>
    </div>
    <div style="width: 160px">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">输出格式</label>
      <select
        :value="outType"
        @change="onOutTypeChange(($event.target).value)"
        style="width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; cursor: pointer; appearance: none; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px"
      >
        <option v-for="t in supportedOutTypes" :key="t" :value="t">{{ outTypeLabels[t] }}</option>
      </select>
      <p style="font-size: 11px; color: #bbb; margin-top: 4px">{{ outTypeDescs[outType] }}</p>
    </div>
  </div>
</template>
