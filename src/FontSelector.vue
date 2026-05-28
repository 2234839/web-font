<script setup lang="ts">
import type { FontInfo } from "./api";
import { t } from "./i18n";

defineProps<{
  fonts: FontInfo[];
  selectedFont: string;
  onFontChange: (font: string) => void;
  supportedOutTypes: ("woff2" | "ttf")[];
  outType: "woff2" | "ttf";
  onOutTypeChange: (v: "woff2" | "ttf") => void;
}>();

const outTypeLabels: Record<string, () => string> = {
  woff2: () => t("woff2Label"),
  ttf: () => t("ttfLabel"),
};

const outTypeDescs: Record<string, () => string> = {
  woff2: () => t("woff2Desc"),
  ttf: () => t("ttfDesc"),
};
</script>

<template>
  <div style="display: flex; gap: 12px">
    <div style="flex: 1">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">{{ t('selectFont') }}</label>
      <select
        :value="selectedFont"
        @change="onFontChange(($event.target).value)"
        style="width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; cursor: pointer; appearance: none; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px"
      >
        <option value="">{{ t('pleaseSelect') }}</option>
        <option v-for="f in fonts" :key="f.name" :value="f.name">{{ f.name }}</option>
      </select>
    </div>
    <div style="width: 160px">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">{{ t('outputFormat') }}</label>
      <select
        :value="outType"
        @change="onOutTypeChange(($event.target).value)"
        style="width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; cursor: pointer; appearance: none; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px"
      >
        <option v-for="ot in supportedOutTypes" :key="ot" :value="ot">{{ outTypeLabels[ot]() }}</option>
      </select>
      <p style="font-size: 11px; color: #bbb; margin-top: 4px">{{ outTypeDescs[outType]() }}</p>
    </div>
  </div>
</template>
