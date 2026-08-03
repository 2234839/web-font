<script setup lang="ts">
/**
 * 离线裁剪页面 —— 纯浏览器端字体裁剪，零服务器依赖
 *
 * 核心特点：
 *  - 字体不上传服务器，隐私安全
 *  - 裁剪在本地完成，零带宽消耗
 *  - 实时预览裁剪后字体效果
 *
 * 架构：预览用增量裁剪（通过 WebFont SDK 管理字符去重），
 * 下载用全量裁剪（一次性输出完整子集字体文件）。
 * 裁剪引擎通过动态 import() 懒加载，不进入其他页面的初始 bundle。
 */
import { ref, computed, onUnmounted } from "vue";
/** 文件选择 input 的引用（用于拖放区域点击触发） */
const fileInput = ref<HTMLInputElement | null>(null);
/** 拖放高亮状态 */
const dragActive = ref(false);
import { usePageSeo } from "../useSeo";
import { t, toggleLocale, locale } from "../i18n";

usePageSeo({
  title: "离线字体裁剪 | 纯浏览器端 | 隐私安全",
  description:
    "纯浏览器端字体裁剪工具 — 字体文件不上传服务器，在本地完成裁剪，隐私安全、零带宽消耗。支持 TTF/OTF 输入，实时预览裁剪效果。",
  path: "/offline-subset",
  priority: 0.8,
  changefreq: "weekly",
});

/** 裁剪核心模块的动态 import 类型 */
type SubsetFn = typeof import("../subset-client");

/** 选中的字体文件 */
const fontFile = ref<File | null>(null);
/** 原始字体 ArrayBuffer（读入后缓存，避免重复读取） */
const fontBuffer = ref<ArrayBuffer | null>(null);
/** 字体文件名（用于下载命名和格式推断） */
const fontFileName = ref("");
/** 字体类型 */
const fontType = ref<"ttf" | "otf" | "woff" | "woff2">("ttf");
/** 裁剪文本 */
const text = ref("天地无极，乾坤借法");
/** 全量裁剪后的字体 Blob URL（仅用于下载） */
const subsetUrl = ref("");
/** 全量裁剪后的字体大小（字节） */
const subsetSize = ref(0);
/** 原始字体大小（字节） */
const originalSize = ref(0);
/** 全量裁剪耗时（毫秒） */
const subsetTime = ref(0);
/** 是否正在裁剪 */
const subsetting = ref(false);
/** 是否正在加载裁剪引擎 */
const engineLoading = ref(false);
/** 错误信息 */
const errorMsg = ref("");
/** 裁剪引擎（懒加载后缓存） */
let subsetModule: SubsetFn | null = null;
/** SDK 的 loadText 实例（增量预览管理器） */
let textLoader: { update: (text: string) => void; dispose: () => void } | null = null;
/** 增量预览用的字体 family 名 */
const PREVIEW_FAMILY = "OfflineSubsetFont";

/** 支持的文件类型 */
const ACCEPT = ".ttf,.otf,.woff,.woff2";

/** 选择字体文件 */
async function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await loadFontFile(file);
  input.value = "";
}

/** 拖放字体文件 */
async function onDrop(e: DragEvent) {
  dragActive.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) await loadFontFile(file);
}

/** 载入字体文件的公共逻辑 */
async function loadFontFile(file: File) {
  errorMsg.value = "";
  fontFile.value = file;
  fontFileName.value = file.name;
  originalSize.value = file.size;

  /** 推断字体类型 */
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  fontType.value = (ext as any) || "ttf";

  try {
    fontBuffer.value = await file.arrayBuffer();
  } catch {
    errorMsg.value = "文件读取失败";
    return;
  }

  /** 初始化增量预览 + 全量裁剪 */
  errorMsg.value = "";
  await initIncrementalPreview();
  await doFullSubset();
}

/**
 * 初始化增量预览 —— 注入本地裁剪 provider 到 SDK，创建 loadText 管理器
 *
 * SDK 负责字符去重和 unicode-range CSS 注入，
 * provider 负责对新增字符执行本地裁剪并返回 Blob URL。
 */
async function initIncrementalPreview() {
  if (!fontBuffer.value) return;

  /** 首次使用时懒加载裁剪引擎 */
  if (!subsetModule) {
    engineLoading.value = true;
    subsetModule = await import("../subset-client");
    engineLoading.value = false;
  }

  /** 字体 buffer 的副本（provider 每次裁剪需要独立的 ArrayBuffer） */
  const sourceBuffer = fontBuffer.value;
  const sourceType = fontType.value as any;

  /**
   * 本地裁剪 provider —— SDK 传入新增字符，返回裁剪后的 Blob URL
   * 签名：(fontName, text, outType) -> { url, format }
   *
   * 注意：这里不更新 subsetSize/subsetTime，那些统计信息由 doFullSubset 管理，
   * 始终反映全量裁剪的结果（供下载参考）。
   */
  const localProvider = (_fontName: string, charsText: string, _outType: string) => {
    /** 每次裁剪都从原始 buffer 副出一份（裁剪会消费 buffer） */
    const bufCopy = sourceBuffer.slice(0);
    const result = subsetModule!.subsetFontInBrowser(bufCopy, charsText, sourceType);
    const blob = new Blob([result.buffer as ArrayBuffer], { type: "font/ttf" });
    return Promise.resolve({ url: URL.createObjectURL(blob), format: "truetype" });
  };

  /** 注入 provider 到 SDK */
  (window as any).WebFont.setSubsetProvider(localProvider);

  /** 创建 loadText 管理器，SDK 自动去重字符并增量裁剪 */
  textLoader = (window as any).WebFont.loadText({
    fontName: fontFileName.value,
    text: text.value,
    family: PREVIEW_FAMILY,
    outType: "truetype",
  });
}

/**
 * 全量裁剪 —— 用于下载完整子集字体文件
 */
async function doFullSubset() {
  if (!fontBuffer.value || !text.value) return;
  subsetting.value = true;

  try {
    if (!subsetModule) {
      engineLoading.value = true;
      subsetModule = await import("../subset-client");
      engineLoading.value = false;
    }

    const t0 = performance.now();
    const result = subsetModule.subsetFontInBrowser(
      fontBuffer.value.slice(0),
      text.value,
      fontType.value as any,
    );
    const t1 = performance.now();
    subsetTime.value = Math.round(t1 - t0);

    if (subsetUrl.value) URL.revokeObjectURL(subsetUrl.value);
    const blob = new Blob([result.buffer as ArrayBuffer], { type: "font/ttf" });
    subsetUrl.value = URL.createObjectURL(blob);
    subsetSize.value = result.byteLength;
  } catch (err) {
    errorMsg.value = `裁剪失败：${err instanceof Error ? err.message : String(err)}`;
    console.error("[offline-subset]", err);
  } finally {
    subsetting.value = false;
    engineLoading.value = false;
  }
}

/** 防抖：文本变化时增量更新预览，延迟全量裁剪 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function onTextChange(value: string) {
  text.value = value;
  if (!fontBuffer.value) return;
  /** SDK 增量更新：自动去重新字符，只裁剪新增部分 */
  textLoader?.update(value);
  /** 延迟全量裁剪（供下载用） */
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doFullSubset(), 600);
}

/** 下载裁剪后的字体 */
function downloadSubset() {
  if (!subsetUrl.value || !fontFileName.value) return;
  const a = document.createElement("a");
  a.href = subsetUrl.value;
  const baseName = fontFileName.value.replace(/\.[^.]+$/, "");
  a.download = `${baseName}_subset.ttf`;
  a.click();
}

/** 压缩率百分比 */
const compressionRate = computed(() => {
  if (!originalSize.value || !subsetSize.value) return 0;
  return Math.round((1 - subsetSize.value / originalSize.value) * 100);
});

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** textarea 行数 */
const textareaRows = computed(() => {
  const lines = text.value.split("\n").length;
  return Math.max(2, Math.min(lines, 10));
});

/** 离开页面时清理资源 */
onUnmounted(() => {
  textLoader?.dispose();
  (window as any).WebFont?.setSubsetProvider(null);
  if (subsetUrl.value) URL.revokeObjectURL(subsetUrl.value);
});
</script>

<template>
  <div style="max-width: 720px; margin: 0 auto; padding: 48px 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; line-height: 1.6">
    <!-- 标题栏 -->
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 24px">
      <div>
        <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 4px 0">离线字体裁剪</h1>
        <p style="font-size: 13px; color: #999; margin: 0">字体不上传服务器，纯浏览器端完成裁剪</p>
      </div>
      <div style="display: flex; gap: 8px; align-items: center">
        <button @click="toggleLocale" style="font-size: 13px; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 12px; cursor: pointer; background: #fff; color: #333">
          {{ locale === 'zh' ? 'EN' : '中' }}
        </button>
        <router-link to="/" style="font-size: 13px; color: #1677ff; text-decoration: none; border: 1px solid #1677ff; border-radius: 6px; padding: 4px 12px">
          ← {{ t('back') }}
        </router-link>
      </div>
    </div>

    <!-- 隐私安全提示 -->
    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 13px; color: #0369a1">
      🔒 <strong>隐私安全</strong>：字体文件和裁剪文本全程留在浏览器，不上传任何服务器。裁剪在你的设备上本地完成。
    </div>

    <!-- 文件选择 -->
    <div style="margin-bottom: 20px">
      <label style="display: block; font-size: 14px; font-weight: 500; margin-bottom: 8px">选择字体文件</label>
      <label style="display: inline-flex; align-items: center; padding: 8px 24px; font-size: 14px; border: 1px solid #1677ff; border-radius: 6px; cursor: pointer; background: #1677ff; color: #fff; font-weight: 500; transition: background 0.2s">
        {{ fontFile ? '重新选择' : '选择字体' }}
        <input type="file" :accept="ACCEPT" style="display: none" @change="onFileSelect" />
      </label>
      <span v-if="fontFile" style="font-size: 13px; color: #666; margin-left: 12px">
        {{ fontFileName }}（{{ formatSize(originalSize) }}）
      </span>
    </div>

    <!-- 文本输入 -->
    <div v-if="fontFile" style="margin-bottom: 20px">
      <label style="display: block; font-size: 14px; font-weight: 500; margin-bottom: 8px">{{ t('inputLabel') }}</label>
      <textarea
        :value="text"
        @input="onTextChange(($event.target as HTMLTextAreaElement).value)"
        :rows="textareaRows"
        :placeholder="t('inputPlaceholder')"
        :style="{ width: '100%', padding: '12px', fontSize: '28px', border: '1px solid #d9d9d9', borderRadius: '8px', outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: textLoader ? PREVIEW_FAMILY + ', sans-serif' : 'inherit', lineHeight: '1.8' }"
      />
    </div>

    <!-- 裁剪状态 -->
    <div v-if="fontFile" style="margin-bottom: 20px">
      <!-- 加载引擎中 -->
      <div v-if="engineLoading" style="padding: 16px; text-align: center; color: #999; font-size: 13px">
        正在加载裁剪引擎（首次约 200KB，后续走浏览器缓存）...
      </div>

      <!-- 裁剪中 -->
      <div v-else-if="subsetting" style="padding: 16px; text-align: center; color: #999; font-size: 13px">
        裁剪中...
      </div>

      <!-- 错误 -->
      <div v-else-if="errorMsg" style="padding: 12px 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; font-size: 13px; color: #b91c1c">
        {{ errorMsg }}
      </div>

      <!-- 裁剪结果 -->
      <div v-else-if="subsetUrl" style="padding: 16px; border: 1px solid #e8e8e8; border-radius: 8px">
        <!-- 统计信息 -->
        <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; font-size: 13px; color: #666">
          <div>
            <span style="color: #999">裁剪后：</span>
            <strong style="color: #1677ff">{{ formatSize(subsetSize) }}</strong>
            <span v-if="compressionRate > 0" style="color: #16a34a; margin-left: 4px">↓ {{ compressionRate }}%</span>
          </div>
          <div v-if="subsetTime > 0">
            <span style="color: #999">耗时：</span>
            <strong>{{ subsetTime }}ms</strong>
          </div>
        </div>

        <!-- 下载按钮 -->
        <button
          @click="downloadSubset"
          style="padding: 8px 24px; font-size: 14px; border: none; border-radius: 6px; cursor: pointer; background: #16a34a; color: #fff; font-weight: 500; display: inline-flex; align-items: center; gap: 6px"
        >
          ⬇ 下载裁剪字体（{{ formatSize(subsetSize) }}）
        </button>
      </div>
    </div>

    <!-- 拖放区域（支持点击选择和拖拽放入） -->
    <div
      v-if="!fontFile"
      @click="fileInput?.click()"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="onDrop"
      :style="{
        padding: '48px 16px',
        textAlign: 'center',
        color: dragActive ? '#1677ff' : '#999',
        fontSize: '14px',
        border: '2px dashed ' + (dragActive ? '#1677ff' : '#e0e0e0'),
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'border-color 0.2s, color 0.2s, background 0.2s',
        background: dragActive ? '#f0f9ff' : 'transparent',
      }"
    >
      <div style="margin-bottom: 8px; font-size: 32px">📁</div>
      <div style="font-weight: 500; margin-bottom: 4px">{{ dragActive ? '松开以载入字体' : '点击或拖拽字体文件到此处' }}</div>
      <span style="font-size: 12px">支持 .ttf / .otf / .woff / .woff2 格式，输出 TTF</span>
    </div>
    <input
      ref="fileInput"
      type="file"
      :accept="ACCEPT"
      style="display: none"
      @change="onFileSelect"
    />
  </div>
</template>
