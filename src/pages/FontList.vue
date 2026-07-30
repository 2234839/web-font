<script setup lang="ts">
/**
 * 字体列表页 —— 浏览所有可用字体，支持拼音搜索，点击进入详情页
 *
 * SSG 预渲染，首屏 HTML 含静态外壳（标题/搜索框/说明），
 * 字体列表在客户端 hydrate 后从 API 加载。
 * 字体预览使用 LazyTrigger 组件懒加载——只有进入视口的卡片才请求字体子集。
 */
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { pinyin } from "pinyin-pro";
import { useHead } from "@unhead/vue";
import { fetchFonts, fetchFontMeta } from "../api";
import type { FontInfo, FontMeta } from "../api";
import { SITE_NAME } from "../seo";
import LazyTrigger from "../components/LazyTrigger.vue";

useHead({
  title: `所有字体 | ${SITE_NAME}`,
  meta: [
    {
      name: "description",
      content: "浏览所有可用字体，支持拼音搜索。点击字体查看完整预览效果，获取按需裁剪链接。",
    },
  ],
});

const router = useRouter();
const fonts = ref<FontInfo[]>([]);
const loading = ref(true);
/** 搜索关键词 */
const query = ref("");

/** 字体元数据缓存（key = 字体名），卡片进入视口后按需加载 */
const metaMap = ref<Map<string, FontMeta>>(new Map());

/** 预览文字内容（与 loadText 参数一致） */
const PREVIEW_TEXT = "静心茶舍 天地无极 ABCDEF";

/** 排序方式：default | codePoints | name | coverage:<charsetKey> */
const sortBy = ref<string>("default");

/** 从已加载的 meta 中提取可选字符集列表（用第一个有 meta 的字体） */
const charsetOptions = computed(() => {
  for (const m of metaMap.value.values()) {
    return m.coverage.map((c) => ({ key: c.key, name: c.name }));
  }
  return [];
});

/** 取某个字体在指定字符集上的覆盖率（0-100），无数据返回 -1 */
function coverageOf(fontName: string, key: string): number {
  const m = metaMap.value.get(fontName);
  if (!m) return -1;
  return m.coverage.find((c) => c.key === key)?.percent ?? -1;
}

/** 排序后的列表 */
const sortedFonts = computed(() => {
  const list = [...filteredFonts.value];
  const sb = sortBy.value;
  if (sb === "codePoints") {
    return list.sort((a, b) => {
      const ta = metaMap.value.get(a.name)?.totalCodePoints ?? 0;
      const tb = metaMap.value.get(b.name)?.totalCodePoints ?? 0;
      return tb - ta;
    });
  }
  if (sb === "name") {
    return list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }
  if (sb.startsWith("coverage:")) {
    const key = sb.slice("coverage:".length);
    return list.sort((a, b) => coverageOf(b.name, key) - coverageOf(a.name, key));
  }
  return list;
});

/**
 * 过滤后的字体列表 —— 同 FontSelector 的搜索逻辑：
 * 空格分隔多关键词（AND），每个关键词匹配文件名 + 拼音
 */
const filteredFonts = computed(() => {
  const raw = query.value.trim().toLowerCase();
  if (!raw) return fonts.value;
  const keywords = raw.split(/\s+/);
  return fonts.value.filter((f) => {
    const name = f.name.toLowerCase();
    const pinyinStr = pinyin(f.name, { toneType: "none", type: "array", nonZh: "consecutive" }).join("").toLowerCase();
    return keywords.every((kw) => name.includes(kw) || pinyinStr.includes(kw));
  });
});

onMounted(async () => {
  fonts.value = await fetchFonts().catch(() => []);
  loading.value = false;
});

/**
 * LazyTrigger @appear 回调 —— 卡片进入视口时：
 * 1. 按需加载字体预览子集
 * 2. 请求字体元数据（覆盖率），后端有磁盘缓存不重复计算
 */
function onCardAppear(fontName: string) {
  (globalThis as any).WebFont?.loadText?.({
    fontName,
    text: PREVIEW_TEXT,
    family: fontName,
  });
  /** 已加载过则跳过 */
  if (metaMap.value.has(fontName)) return;
  fetchFontMeta(fontName)
    .then((m) => {
      metaMap.value.set(fontName, m);
      /** 触发响应式更新 */
      metaMap.value = new Map(metaMap.value);
    })
    .catch(() => {});
}

/** 点击字体卡片 → 跳转详情页 */
function goToDetail(name: string) {
  router.push(`/fonts/${encodeURIComponent(name)}`);
}
</script>

<template>
  <div style="min-height: 100vh; background: #fafafa">
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
        @click="router.push('/')"
      >
        ← 首页
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

    <!-- 标题 + 搜索 -->
    <div style="max-width: 960px; margin: 0 auto; padding: 40px 24px 24px">
      <h1 style="font-size: 28px; font-weight: 700; color: #2c2c2c; margin: 0 0 8px">所有字体</h1>
      <p style="font-size: 14px; color: #999; margin: 0 0 24px">
        共 {{ loading ? "..." : fonts.length }} 个字体 · 点击查看完整预览
      </p>

      <!-- 搜索 + 排序 -->
      <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 0">
        <input
          v-model="query"
          type="text"
          placeholder="搜索字体（支持拼音）..."
          style="
            flex: 1;
            min-width: 200px;
            max-width: 480px;
            padding: 10px 16px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
            box-sizing: border-box;
          "
        />
        <select
          v-model="sortBy"
          style="
            padding: 10px 16px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
            background: white;
            cursor: pointer;
            white-space: nowrap;
          "
        >
          <option value="default">默认排序</option>
          <option value="codePoints">字符量 ↓</option>
          <option value="name">名称 A→Z</option>
          <option
            v-for="cs in charsetOptions"
            :key="cs.key"
            :value="`coverage:${cs.key}`"
          >{{ cs.name.replace(/（.+）/, '') }} 覆盖率 ↓</option>
        </select>
      </div>
    </div>

    <!-- 字体卡片网格 -->
    <div style="max-width: 960px; margin: 0 auto; padding: 0 24px 80px">
      <div v-if="loading" style="text-align: center; padding: 60px; color: #999">加载中...</div>

      <div
        v-else-if="sortedFonts.length === 0"
        style="text-align: center; padding: 60px; color: #999"
      >
        未找到匹配的字体
      </div>

      <div
        v-else
        data-font-grid
        style="
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 16px;
        "
      >
        <LazyTrigger
          v-for="font in sortedFonts"
          :key="font.name"
          @appear="onCardAppear(font.name)"
        >
          <div
            :data-font="font.name"
            @click="goToDetail(font.name)"
            style="
              background: #fff;
              border-radius: 12px;
              padding: 24px;
              cursor: pointer;
              transition: box-shadow 0.2s, transform 0.1s;
              border: 1px solid transparent;
            "
            onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,0.08)';this.style.borderColor='#1677ff'"
            onmouseout="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.04)';this.style.borderColor='transparent'"
          >
          <!-- 字体名 -->
          <div style="font-size: 15px; font-weight: 600; color: #333; margin-bottom: 12px">
            {{ font.name }}
            <span
              v-if="font.temporary"
              style="
                font-size: 11px;
                color: #e8a030;
                background: #fff8e8;
                padding: 2px 6px;
                border-radius: 4px;
                margin-left: 6px;
              "
              >临时</span
            >
          </div>

          <!-- 字体预览 -->
          <div
            :style="{
              fontFamily: `'${font.name}', serif`,
              fontSize: '32px',
              color: '#2c2c2c',
              lineHeight: 1.4,
              marginBottom: '8px',
            }"
          >
            静心茶舍
          </div>
          <div
            :style="{
              fontFamily: `'${font.name}', monospace`,
              fontSize: '13px',
              color: '#999',
            }"
          >
            天地无极 ABCDEF
          </div>

          <!-- 覆盖率标签 -->
          <div v-if="metaMap.get(font.name)" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px">
            <span
              v-for="c in (metaMap.get(font.name)?.coverage ?? []).filter(c => c.percent < 100)"
              :key="c.name"
              :style="{
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '4px',
                color: c.percent >= 50 ? '#1677ff' : '#ff4d4f',
                background: c.percent >= 50 ? '#e6f4ff' : '#fff2f0',
              }"
            >{{ c.name.replace(/（.+）/, '') }} {{ c.percent }}%</span>
          </div>
          </div>
        </LazyTrigger>
      </div>
    </div>
  </div>
</template>
