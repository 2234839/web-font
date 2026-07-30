<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { pinyin } from "pinyin-pro";
import type { FontInfo } from "./api";
import { t } from "./i18n";

const props = defineProps<{
  fonts: FontInfo[];
  selectedFont: string;
  onFontChange: (font: string) => void;
  supportedOutTypes: ("woff2" | "ttf")[];
  outType: "woff2" | "ttf";
  onOutTypeChange: (v: "woff2" | "ttf") => void;
}>();

// ── 搜索下拉状态 ──
/** 下拉是否展开 */
const dropdownOpen = ref(false);
/** 搜索关键词 */
const query = ref("");
/** 搜索输入框 ref（展开时自动聚焦） */
const searchInputRef = ref<HTMLInputElement | null>(null);
/** 整个字体选择器根元素 ref（用于点击外部关闭检测） */
const selectorRef = ref<HTMLDivElement | null>(null);

/**
 * 过滤后的字体列表
 *
 * 支持空格分隔多关键词（AND 关系），每个关键词同时匹配：
 * 原始文件名（中文/英文）+ 中文部分的拼音（无声调、无空格）
 * 例如搜 "siyuan hei" 能匹配 "思源黑体.ttf"，搜 "令东" 能匹配 "令东齐伋复刻体.ttf"
 */
const filteredFonts = computed(() => {
  const raw = query.value.trim().toLowerCase();
  if (!raw) return props.fonts;
  /** 空格拆分为多个关键词，全部命中才匹配 */
  const keywords = raw.split(/\s+/);
  return props.fonts.filter((f) => {
    const name = f.name.toLowerCase();
    /** 中文转拼音：去掉声调和空格，"思源黑体" → "siyuanheiti" */
    const pinyinStr = pinyin(f.name, { toneType: "none", type: "array", nonZh: "consecutive" }).join("").toLowerCase();
    return keywords.every((kw) => name.includes(kw) || pinyinStr.includes(kw));
  });
});

/** 当前选中的字体对象（用于判断是否临时字体） */
const selectedFontInfo = computed(() => props.fonts.find((f) => f.name === props.selectedFont));

/** 当前选中字体的显示名（无选中时显示占位文字） */
const selectedLabel = computed(() => props.selectedFont || t("pleaseSelect"));

/** 点击触发器：已展开则关闭，未展开则打开 */
function toggleDropdown(e: MouseEvent) {
  /** 展开状态下点击输入框本身不切换（保持打字），只有点击非 input 区域才收起 */
  if (dropdownOpen.value && e.target instanceof HTMLInputElement) return;
  if (dropdownOpen.value) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

/** 打开下拉，清空搜索词并聚焦输入框 */
function openDropdown() {
  dropdownOpen.value = true;
  query.value = "";
  nextTick(() => searchInputRef.value?.focus());
}

/** 关闭下拉 */
function closeDropdown() {
  dropdownOpen.value = false;
}

/** 选中某个字体 */
function selectFont(name: string) {
  props.onFontChange(name);
  closeDropdown();
}

/** 点击外部关闭下拉 */
function handleClickOutside(e: MouseEvent) {
  if (selectorRef.value && !selectorRef.value.contains(e.target as Node)) {
    closeDropdown();
  }
}

/** 字体列表变化时，如果当前选中的字体不在列表中了，清空选择 */
watch(
  () => props.fonts,
  (fonts) => {
    if (props.selectedFont && !fonts.some((f) => f.name === props.selectedFont)) {
      props.onFontChange("");
    }
  },
);

onMounted(() => document.addEventListener("click", handleClickOutside));
onUnmounted(() => document.removeEventListener("click", handleClickOutside));

const outTypeLabels: Record<string, () => string> = {
  woff2: () => t("woff2Label"),
  ttf: () => t("ttfLabel"),
};

const outTypeDescs: Record<string, () => string> = {
  woff2: () => t("woff2Desc"),
  ttf: () => t("ttfDesc"),
};

/** 输出格式 change 事件处理：从 select 取值回调父组件 */
function handleOutTypeChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  if (target) props.onOutTypeChange(target.value as "woff2" | "ttf");
}
</script>

<template>
  <div style="display: flex; gap: 12px">
    <!-- 可搜索的字体选择器 -->
    <div ref="selectorRef" style="flex: 1; position: relative">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">{{ t('selectFont') }}</label>

      <!-- 触发器 + 搜索输入二合一：关闭时显示选中字体名，展开时变成搜索输入框 -->
      <div
        @click="toggleDropdown"
        style="position: relative; width: 100%; padding: 8px 28px 8px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; box-sizing: border-box; cursor: pointer; background: #fff; min-height: 34px; display: flex; align-items: center; user-select: none"
        :style="{ borderColor: dropdownOpen ? '#4096ff' : '#d9d9d9' }"
      >
        <!-- 展开时：搜索输入框 -->
        <input
          v-if="dropdownOpen"
          ref="searchInputRef"
          v-model="query"
          :placeholder="t('searchFontPlaceholder')"
          @keydown.enter="filteredFonts.length > 0 && selectFont(filteredFonts[0].name)"
          @keydown.esc="closeDropdown"
          style="width: 100%; border: none; outline: none; font-size: 14px; background: transparent; padding: 0; color: #000"
        />
        <!-- 关闭时：显示选中的字体名 -->
        <span v-else :style="{ color: selectedFont ? '#000' : '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }">
          <span style="overflow: hidden; text-overflow: ellipsis">{{ selectedLabel }}</span>
          <span
            v-if="selectedFontInfo?.temporary"
            style="flex-shrink: 0; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #fff7e6; color: #fa8c16; border: 1px solid #ffd591"
          >临时</span>
        </span>
        <!-- 下拉箭头 -->
        <svg style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); transition: transform 0.2s" :style="{ transform: dropdownOpen ? 'translateY(-50%) rotate(180deg)' : 'translateY(-50%)' }" width="12" height="12" viewBox="0 0 12 12">
          <path d="M2 4l4 4 4-4" fill="none" stroke="#999" stroke-width="1.5" stroke-linecap="round" />
        </svg>

        <!-- 下拉面板：相对于触发器定位，top: 100% 精确等于触发器高度 -->
        <div
          v-if="dropdownOpen"
          style="position: absolute; top: calc(100% + 2px); left: 0; right: 0; background: #fff; border: 1px solid #d9d9d9; border-radius: 6px; box-shadow: 0 6px 16px rgba(0,0,0,0.08); z-index: 1000; overflow: hidden"
        >
          <!-- 字体列表（可滚动） -->
          <div style="max-height: 240px; overflow-y: auto">
            <div
              v-if="filteredFonts.length === 0"
              style="padding: 16px; text-align: center; color: #bbb; font-size: 13px"
            >
              {{ t('noFontFound') }}
            </div>
            <div
              v-for="f in filteredFonts"
              :key="f.name"
              @click="selectFont(f.name)"
              @mouseenter="($event.currentTarget as HTMLElement).style.background = '#f5f5f5'"
              @mouseleave="($event.currentTarget as HTMLElement).style.background = f.name === selectedFont ? '#e6f4ff' : '#fff'"
              style="padding: 8px 12px; font-size: 14px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px"
              :style="{ background: f.name === selectedFont ? '#e6f4ff' : '#fff', color: f.name === selectedFont ? '#1677ff' : '#333', fontWeight: f.name === selectedFont ? '500' : 'normal' }"
            >
              <span style="flex: 1; overflow: hidden; text-overflow: ellipsis">{{ f.name }}</span>
              <span
                v-if="f.temporary"
                style="flex-shrink: 0; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #fff7e6; color: #fa8c16; border: 1px solid #ffd591"
              >临时</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 输出格式（保持原生 select 不变） -->
    <div style="width: 160px">
      <label style="display: block; font-size: 13px; color: #555; margin-bottom: 6px">{{ t('outputFormat') }}</label>
      <select
        :value="outType"
        @change="handleOutTypeChange"
        style="width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; box-sizing: border-box; cursor: pointer; appearance: none; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px"
      >
        <option v-for="ot in supportedOutTypes" :key="ot" :value="ot">{{ outTypeLabels[ot]() }}</option>
      </select>
      <p style="font-size: 11px; color: #bbb; margin-top: 4px">{{ outTypeDescs[outType]() }}</p>
    </div>
  </div>
</template>
