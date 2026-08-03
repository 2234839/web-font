<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { fetchStats, type ServerStats } from "./api";
import { t, locale } from "./i18n";

function formatUptime(seconds: number): string {
  if (locale.value === "en") {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h < 24) return `${h}h ${m}m ${s}s`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h < 24) return `${h}时${m}分${s}秒`;
  const d = Math.floor(h / 24);
  return `${d}天${h % 24}时${m}分`;
}

const data = ref<ServerStats | null>(null);
/** 进度条动画 key —— 每次刷新后递增以重置 CSS animation */
const progressKey = ref(0);
/** 组件根元素 ref（用于 IntersectionObserver 观测） */
const rootRef = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
/** 组件是否在视口内可见 */
let inViewport = false;

/** 轮询周期（毫秒），与进度条 animation-duration 保持一致 */
const POLL_INTERVAL = 10_000;

/** 首次加载数据（不受视口/可见性限制，mount 时立即调用） */
async function initialLoad() {
  const s = await fetchStats().catch(() => null);
  if (s) {
    data.value = s;
    progressKey.value++;
  }
}

async function load() {
  const s = await fetchStats().catch(() => null);
  if (s) {
    data.value = s;
    /** 重启进度条动画 */
    progressKey.value++;
  }
}

function startPolling() {
  if (timer) return;
  load();
  timer = setInterval(load, POLL_INTERVAL);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 评估是否应该轮询：组件在视口内 且 页面标签可见 */
function evaluatePolling() {
  const shouldPoll = inViewport && document.visibilityState === "visible";
  if (shouldPoll) startPolling();
  else stopPolling();
}

function onVisibilityChange() {
  evaluatePolling();
}

/** IntersectionObserver 实例 */
let intersectionObserver: IntersectionObserver | null = null;

onMounted(() => {
  /** 立即首次加载，确保卡片尽快出现 */
  initialLoad();

  /** 监听页面标签可见性 */
  document.addEventListener("visibilitychange", onVisibilityChange);

  /** 监听组件是否进入视口 */
  if (rootRef.value) {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          inViewport = entry.isIntersecting;
        }
        evaluatePolling();
      },
      { rootMargin: "50px" },
    );
    intersectionObserver.observe(rootRef.value);
  }
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  intersectionObserver?.disconnect();
});
</script>

<template>
  <div ref="rootRef">
  <section v-if="data" style="margin-top: 24px; margin-bottom: 28px; padding: 12px 16px; background: #f0f0f0; border-radius: 8px; position: relative; overflow: hidden">
    <div style="font-size: 13px; font-weight: 600; color: #333; margin-bottom: 4px">{{ t('serverStatus') }}</div>
    <div style="display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; color: #555; line-height: 2">
      <span><b style="color: #333">{{ t('uptime') }}</b> {{ formatUptime(data.uptime) }}</span>
      <span><b style="color: #333">{{ t('requests') }}</b> {{ data.totalRequests }} {{ t('times') }}</span>
      <span><b style="color: #333">{{ t('subset') }}</b> {{ data.subsetRequests }} {{ t('times') }}</span>
      <span><b style="color: #333">{{ t('chars') }}</b> {{ data.totalChars }} {{ t('charUnit') }}</span>
      <span><b style="color: #333">上传</b> {{ data.tempUploads ?? 0 }} 次</span>
      <span><b style="color: #333">{{ t('cacheHit') }}</b> {{ data.subsetRequests > 0 ? ((data.subsetCacheHits / data.subsetRequests) * 100).toFixed(1) : '0.0' }}%</span>
    </div>
    <!-- 底部进度条：每轮询周期走一轮，走完触发下次刷新 -->
    <div :key="progressKey" style="position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: #1677ff; transform-origin: left; animation: stats-progress 10s linear" />
  </section>
  </div>
</template>

<style>
@keyframes stats-progress {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
</style>
