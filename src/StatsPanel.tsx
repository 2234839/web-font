import { createSignal, onMount, onCleanup } from "solid-js";
import { fetchStats, type ServerStats } from "./api";

/** 将秒数格式化为可读时长 */
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

export default function StatsPanel() {
  const [data, setData] = createSignal<ServerStats | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  const load = async () => {
    const s = await fetchStats().catch(() => null);
    if (s) setData(s);
  };

  const startPolling = () => {
    if (timer) return;
    load();
    timer = setInterval(load, 10_000);
  };

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      startPolling();
    } else {
      stopPolling();
    }
  };

  onMount(() => {
    document.addEventListener("visibilitychange", onVisibilityChange);
    startPolling();
  });

  onCleanup(() => {
    stopPolling();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  const s = data();
  if (!s) return null;

  const hitRate = s.subsetRequests > 0 ? ((s.subsetCacheHits / s.subsetRequests) * 100).toFixed(1) : "0.0";

  return (
    <section style={{ "font-size": "12px", color: "#999", "line-height": "1.8", "margin-top": "24px" }}>
      <div style={{ display: "flex", gap: "16px", "flex-wrap": "wrap" }}>
        <span>运行 {formatUptime(s.uptime)}</span>
        <span>请求 {s.totalRequests} 次</span>
        <span>裁剪 {s.subsetRequests} 次</span>
        <span>文字 {s.totalChars} 字</span>
        <span>缓存命中 {hitRate}%</span>
      </div>
    </section>
  );
}
