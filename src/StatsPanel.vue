<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { fetchStats, type ServerStats } from "./api";

function formatUptime(seconds: number): string {
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
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const s = await fetchStats().catch(() => null);
  if (s) data.value = s;
}

function startPolling() {
  if (timer) return;
  load();
  timer = setInterval(load, 10_000);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") {
    startPolling();
  } else {
    stopPolling();
  }
}

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibilityChange);
  startPolling();
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <section v-if="data" style="margin-top: 24px; margin-bottom: 28px; padding: 12px 16px; background: #f0f0f0; border-radius: 8px">
    <div style="font-size: 13px; font-weight: 600; color: #333; margin-bottom: 4px">服务状态</div>
    <div style="display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; color: #555; line-height: 2">
      <span><b style="color: #333">运行</b> {{ formatUptime(data.uptime) }}</span>
      <span><b style="color: #333">请求</b> {{ data.totalRequests }} 次</span>
      <span><b style="color: #333">裁剪</b> {{ data.subsetRequests }} 次</span>
      <span><b style="color: #333">文字</b> {{ data.totalChars }} 字</span>
      <span><b style="color: #333">缓存命中</b> {{ data.subsetRequests > 0 ? ((data.subsetCacheHits / data.subsetRequests) * 100).toFixed(1) : '0.0' }}%</span>
    </div>
  </section>
</template>
