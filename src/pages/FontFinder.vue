<script setup lang="ts">
/**
 * 截图找字体页面 —— 上传文字截图，在站内字体库中找出最相似的字体
 *
 * 流程：
 *  1. 上传/粘贴文字截图，框选一行文字
 *  2. 自动切分图块，用户逐块填写对应字符，无法确认的块可留空
 *  3. 一次请求提交所有已填写图块，服务端完成全库字形比对
 *  4. 按平均分排序展示，附逐字对比小图
 */
import { ref, computed, useTemplateRef } from "vue";
import { usePageSeo } from "../useSeo";
import { prepareQueryGlyphs, renderSubsetGlyphPreviews } from "../font-finder/matcher";

/** 服务端返回的单字体结果（与 backend/routes/glyph_match.ts 对齐） */
interface ServerFontResult {
  font: string;
  score: number;
  missing: boolean;
  glyphs: Array<{ char: string; score: number; bitmap: string; queryIndex: number }>;
}

/** 归一化 RGBA（0/255 灰度）→ 4096 字符 01 串（笔画=1） */
function rgbaToBitString(rgba: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 64 * 64; i++) s += rgba[i * 4] === 0 ? "1" : "0";
  return s;
}

usePageSeo({
  title: "截图找字体 | 以图搜字体 | 在线字体识别",
  description: "上传文字截图，框选并确认文字，即可在站内字体库中查找字形最相似的字体。",
  path: "/font-finder",
  priority: 0.8,
  changefreq: "weekly",
});

/** 图片文件输入 */
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
/** 图片展示元素（用于计算选区相对坐标） */
const imgEl = useTemplateRef<HTMLImageElement>("imgEl");
/** 选区覆盖层容器 */
const stageEl = useTemplateRef<HTMLDivElement>("stageEl");

/** 原始截图对象 URL */
const imageUrl = ref("");
/** 选区（相对展示尺寸的像素坐标） */
const selection = ref<{ x: number; y: number; w: number; h: number } | null>(null);
/** 选区拖拽进行时状态 */
const dragging = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
/** 是否正在比对 */
const matching = ref(false);
/** 比对进度（已完成字体数） */
const doneCount = ref(0);
/** 总字体数 */
const totalCount = ref(0);
/** 结果列表（按分数降序） */
const results = ref<ServerFontResult[]>([]);
/** 错误信息 */
const errorMsg = ref("");
/** 切分出的字形预览 */
const glyphPreviews = ref<string[]>([]);
/** 每个图块对应的一个字符，空字符串表示不参与识别 */
const glyphChars = ref<string[]>([]);
/** 切分出的归一化字形（非响应式，体积较大） */
let queryMasks: Uint8Array[] = [];

/** 当前步骤：1上传 2框选 3输入 4结果（用于步骤条高亮） */
const step = computed(() => {
  if (!imageUrl.value) return 1;
  if (!selection.value) return 2;
  if (!results.value.length) return 3;
  return 4;
});

/** 识别耗时（ms，结果展示用） */
const elapsedMs = ref(0);

/** 重选图片：清空当前图片与全部状态 */
function resetImage() {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = "";
  selection.value = null;
  dragging.value = null;
  glyphPreviews.value = [];
  glyphChars.value = [];
  queryMasks = [];
  results.value = [];
  errorMsg.value = "";
}

/** 图片显示尺寸（选区坐标换算回原始像素用） */
let displayedWidth = 0;
let displayedHeight = 0;
let naturalWidth = 0;
let naturalHeight = 0;

/** 已填写对应字符的图块下标，顺序与识别请求中的 glyphs 一致 */
const filledGlyphIndices = computed(() => {
  const indices: number[] = [];
  for (const [index, char] of glyphChars.value.entries()) {
    if (char && queryMasks[index]) indices.push(index);
  }
  return indices;
});

/** 是否满足开始识别条件：至少填写一个图块 */
const canMatch = computed(
  () => !!selection.value && filledGlyphIndices.value.length > 0 && !matching.value,
);

/** 选择图片 */
function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) loadImage(file);
  input.value = "";
}

/** 粘贴截图 */
async function onPaste(e: ClipboardEvent) {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (file) loadImage(file);
}

/** 加载图片并重置状态 */
function loadImage(file: File) {
  errorMsg.value = "";
  results.value = [];
  glyphPreviews.value = [];
  glyphChars.value = [];
  queryMasks = [];
  selection.value = null;
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = URL.createObjectURL(file);
}

/** 图片加载完成：记录展示/原始尺寸 */
function onImgLoad() {
  const img = imgEl.value!;
  displayedWidth = img.clientWidth;
  displayedHeight = img.clientHeight;
  naturalWidth = img.naturalWidth;
  naturalHeight = img.naturalHeight;
}

/** 选区拖拽开始 */
function onPointerDown(e: PointerEvent) {
  if (!stageEl.value || !imageUrl.value) return;
  /** 阻止默认行为：图片原生拖拽 ghost、文本选择（触屏长按菜单）都会干扰框选 */
  e.preventDefault();
  const rect = stageEl.value.getBoundingClientRect();
  dragging.value = { x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top };
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
}

/** 选区拖拽移动 */
function onPointerMove(e: PointerEvent) {
  if (!dragging.value || !stageEl.value) return;
  const rect = stageEl.value.getBoundingClientRect();
  dragging.value.x1 = Math.max(0, Math.min(displayedWidth, e.clientX - rect.left));
  dragging.value.y1 = Math.max(0, Math.min(displayedHeight, e.clientY - rect.top));
}

/** 选区拖拽结束：落定选区并切分字形 */
function onPointerUp() {
  if (!dragging.value) return;
  const { x0, y0, x1, y1 } = dragging.value;
  dragging.value = null;
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  /** 最小选区尺寸兜底（避免误点产生空选区） */
  if (w < 8 || h < 8) {
    selection.value = null;
    glyphPreviews.value = [];
    return;
  }
  selection.value = { x, y, w, h };
  segmentSelection();
}

/** 对当前选区切分字形（预览 + 数量校验） */
function segmentSelection() {
  const sel = selection.value;
  const img = imgEl.value;
  if (!sel || !img) return;
  errorMsg.value = "";
  results.value = [];
  /** 展示坐标 → 原始像素坐标 */
  const sx = naturalWidth / displayedWidth;
  const sy = naturalHeight / displayedHeight;
  const cropW = Math.max(1, Math.round(sel.w * sx));
  const cropH = Math.max(1, Math.round(sel.h * sy));
  const canvas = document.createElement("canvas");
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(
    img,
    Math.round(sel.x * sx), Math.round(sel.y * sy), cropW, cropH,
    0, 0, cropW, cropH,
  );
  const { masks, previews } = prepareQueryGlyphs(ctx.getImageData(0, 0, cropW, cropH));
  glyphPreviews.value = previews;
  glyphChars.value = previews.map(() => "");
  queryMasks = masks;
}

/** 修改对应字符后，旧结果不再有效 */
function onGlyphInput() {
  results.value = [];
}

/** 裁剪接口生成的字体预览缓存（同字体同字只渲染一次） */
const glyphPreviewCache = new Map<string, string>();
function serverGlyphPreview(font: string, char: string): string {
  return glyphPreviewCache.get(font + "|" + char) ?? "";
}

/** 结果中的查询序号 → 原始图块预览，留空图块与候选字体缺字均不会造成错位 */
function queryPreview(queryIndex: number): string {
  const sourceIndex = filledGlyphIndices.value[queryIndex];
  return sourceIndex === undefined ? "" : (glyphPreviews.value[sourceIndex] ?? "");
}

/** 开始识别：一次请求，只提交已填写字符的图块 */
async function startMatch() {
  if (!canMatch.value) return;
  matching.value = true;
  errorMsg.value = "";
  results.value = [];
  doneCount.value = 0;
  const t0 = performance.now();
  try {
    const res = await fetch("/api/glyph-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        glyphs: filledGlyphIndices.value.map((sourceIndex) => ({
          char: glyphChars.value[sourceIndex]!,
          bitmap: rgbaToBitString(queryMasks[sourceIndex]!),
        })),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { results?: ServerFontResult[]; error?: string };
    if (data.error) throw new Error(data.error);
    const matchedResults = data.results ?? [];
    /** 每个字体只裁剪一次，同次裁剪包含该结果需要展示的全部字符 */
    await Promise.all(matchedResults.map(async (result) => {
      const previews = await renderSubsetGlyphPreviews(result.font, result.glyphs.map((g) => g.char));
      for (const [char, preview] of previews) {
        glyphPreviewCache.set(result.font + "|" + char, preview);
      }
    }));
    results.value = matchedResults;
    totalCount.value = results.value.length;
    doneCount.value = results.value.length;
    elapsedMs.value = Math.round(performance.now() - t0);
  } catch (err) {
    errorMsg.value = `识别失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    matching.value = false;
  }
}

/** 分数展示为百分比 */
const pct = (s: number) => `${(s * 100).toFixed(1)}%`;

/** 分数对应颜色 */
const scoreColor = (s: number) => (s > 0.9 ? "#16a34a" : s > 0.8 ? "#d97706" : "#999");
</script>

<template>
  <div style="max-width: 960px; margin: 0 auto; padding: 24px 16px 64px" @paste="onPaste">
    <h1 style="font-size: 26px; margin: 0 0 8px">截图找字体</h1>
    <p style="color: #666; margin: 0 0 20px; font-size: 14px">
      上传含文字的截图，与站内字体库比对，找出最相似的字体。
    </p>

    <!-- 步骤指示器 -->
    <div style="display: flex; gap: 6px; margin-bottom: 20px; font-size: 13px; flex-wrap: wrap">
      <span v-for="(label, i) in ['1 上传截图', '2 框选文字', '3 输入文字并识别']" :key="i" :style="{ padding: '5px 12px', borderRadius: '999px', fontWeight: step >= i + 1 && step <= i + 2 ? 600 : 400, color: step === i + 1 ? '#fff' : step > i + 1 ? '#16a34a' : '#999', background: step === i + 1 ? '#1677ff' : 'transparent', border: `1px solid ${step === i + 1 ? '#1677ff' : step > i + 1 ? '#16a34a' : '#ddd'}` }">
        {{ step > i + 1 ? '✓ ' : '' }}{{ label }}
      </span>
      <span style="margin-left: auto; align-self: center">
        <button v-if="imageUrl && !matching" style="padding: 4px 12px; border: 1px solid #d9d9d9; border-radius: 6px; background: #fff; font-size: 13px; cursor: pointer" @click="resetImage">重新开始</button>
      </span>
    </div>

    <!-- ─── 第 1+2 步：图片与框选 ─── -->
    <div v-if="!imageUrl" style="border: 2px dashed #bbb; border-radius: 12px; padding: 56px 16px; text-align: center; cursor: pointer; transition: border-color .15s" @click="fileInput?.click()">
      <div style="font-size: 34px">🖼️</div>
      <div style="color: #555; font-size: 16px; margin-top: 10px; font-weight: 500">点击选择图片，或直接 Ctrl+V 粘贴截图</div>
      <div style="color: #aaa; font-size: 13px; margin-top: 6px">支持 png / jpg / webp</div>
    </div>

    <div v-else>
      <div style="font-size: 15px; font-weight: 600; margin-bottom: 8px; color: #333">
        {{ selection ? '2️⃣ 框选文字 ✅ — 可重新拖拽调整选区' : '2️⃣ 框选文字 —— 请在图中拖拽框选一行文字' }}
      </div>
      <div
        ref="stageEl"
        style="position: relative; display: inline-block; max-width: 100%; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; cursor: crosshair; user-select: none; touch-action: none"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @dragstart.prevent
      >
        <img ref="imgEl" :src="imageUrl" draggable="false" style="display: block; max-width: 100%; -webkit-user-drag: none" @load="onImgLoad" />
        <div
          v-if="selection"
          :style="{ position: 'absolute', left: selection.x + 'px', top: selection.y + 'px', width: selection.w + 'px', height: selection.h + 'px', border: '2px solid #1677ff', background: 'rgba(22,119,255,0.12)', pointerEvents: 'none' }"
        />
        <div
          v-if="dragging"
          :style="{ position: 'absolute', left: Math.min(dragging.x0, dragging.x1) + 'px', top: Math.min(dragging.y0, dragging.y1) + 'px', width: Math.abs(dragging.x1 - dragging.x0) + 'px', height: Math.abs(dragging.y1 - dragging.y0) + 'px', border: '2px dashed #1677ff', pointerEvents: 'none' }"
        />
      </div>
    </div>

    <input ref="fileInput" type="file" accept="image/*" style="display: none" @change="onFileSelect" />

    <!-- ─── 第 3 步：逐块确认文字并识别（框选后始终显示） ─── -->
    <div v-if="selection" style="margin-top: 20px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px 20px; background: #fafafa">
      <div style="font-size: 15px; font-weight: 600; margin-bottom: 10px; color: #333">3️⃣ 确认每个图块对应的文字</div>

      <div v-if="glyphPreviews.length" style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; margin-bottom: 14px">
        <div v-for="(p, i) in glyphPreviews" :key="i" style="width: 52px; text-align: center">
          <img :src="p" style="width: 52px; height: 52px; image-rendering: pixelated; border: 1px solid #ddd; border-radius: 6px; background: #fff; box-sizing: border-box" />
          <input
            v-model.trim="glyphChars[i]"
            maxlength="1"
            placeholder="字"
            :aria-label="`第 ${i + 1} 个图块对应的文字`"
            style="width: 52px; height: 34px; margin-top: 6px; padding: 4px; border: 1.5px solid #d9d9d9; border-radius: 6px; font-size: 16px; text-align: center; outline: none; box-sizing: border-box; background: #fff"
            @input="onGlyphInput"
          />
        </div>
      </div>
      <div v-else style="color: #d97706; font-size: 13px; margin-bottom: 14px">
        ⚠️ 未从选区中切分出图块，请调整选区后重试
      </div>

      <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: space-between">
        <span style="color: #777; font-size: 13px; line-height: 1.6">
          每个图块填写一个字；无法确认或粘连在一起的图块可留空，至少填写一个字。
        </span>
        <button
          :disabled="!canMatch"
          style="padding: 11px 28px; border: none; border-radius: 8px; background: #1677ff; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; white-space: nowrap"
          :style="{ opacity: canMatch ? 1 : 0.45, cursor: canMatch ? 'pointer' : 'not-allowed' }"
          @click="startMatch"
        >
          开始识别
        </button>
      </div>
      <div v-if="filledGlyphIndices.length" style="color: #1677ff; font-size: 13px; margin-top: 8px">
        已填写 {{ filledGlyphIndices.length }} 个字，留空的图块不会参与识别。
      </div>

      <!-- 识别中进度 -->
      <div v-if="matching" style="margin-top: 14px; padding: 12px 16px; border: 1px solid #91caff; background: #e6f4ff; border-radius: 8px; font-size: 14px; color: #0958d9; display: flex; align-items: center; gap: 10px">
        <span style="display: inline-block; width: 16px; height: 16px; border: 2px solid #1677ff; border-top-color: transparent; border-radius: 50%; animation: ff-spin 0.8s linear infinite"></span>
        正在与站内字体库比对，请稍候…
      </div>
    </div>

    <div v-if="errorMsg" style="margin-top: 12px; padding: 10px 14px; border: 1px solid #fca5a5; background: #fef2f2; border-radius: 8px; color: #dc2626; font-size: 13px">{{ errorMsg }}</div>

    <!-- ─── 第 4 步：结果 ─── -->
    <div v-if="results.length" style="margin-top: 28px">
      <h2 style="font-size: 17px; margin: 0 0 12px">识别结果 <span style="font-weight: 400; color: #999; font-size: 13px">共比对 {{ results.length }} 个字体 · 耗时 {{ elapsedMs }}ms · 左图=截图 右图=该字体渲染</span></h2>
      <div
        v-for="r in results"
        :key="r.font"
        style="border: 1px solid #eee; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap"
      >
        <div style="min-width: 200px; flex: 1">
          <div style="font-size: 15px; font-weight: 600">{{ r.font }}</div>
          <div v-if="r.missing" style="font-size: 12px; color: #d97706">该字体缺少部分目标字符</div>
          <div style="margin-top: 6px; height: 8px; background: #f0f0f0; border-radius: 4px; overflow: hidden">
            <div :style="{ width: pct(r.score), height: '100%', background: scoreColor(r.score) }" />
          </div>
        </div>
        <div :style="{ fontSize: '20px', fontWeight: 700, color: scoreColor(r.score) }">{{ pct(r.score) }}</div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap">
          <div v-for="g in r.glyphs" :key="g.queryIndex" style="text-align: center">
            <div style="display: flex; gap: 2px">
              <img :src="queryPreview(g.queryIndex)" style="width: 34px; height: 34px; image-rendering: pixelated; border: 1px solid #eee; border-radius: 4px" title="截图" />
              <img :src="serverGlyphPreview(r.font, g.char)" style="width: 34px; height: 34px; image-rendering: pixelated; border: 1px solid #eee; border-radius: 4px" title="该字体渲染" />
            </div>
            <div style="font-size: 10px; color: #999; margin-top: 2px">{{ g.char }} {{ pct(g.score) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/** 识别中加载图标旋转动画（scoped 会隔离 keyframes，用全局 style） */
@keyframes ff-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
