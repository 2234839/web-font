import { jsonResponse, stats, subsetCache, fontBufferCache, markStatsDirty } from "../shared";

/** GET /api/stats — 返回运行时统计 */
export async function handleStats(req: Request, _res: Response) {
  return {
    req,
    res: jsonResponse({
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      totalRequests: stats.totalRequests,
      subsetRequests: stats.subsetRequests,
      subsetCacheHits: stats.subsetCacheHits,
      totalChars: stats.totalChars,
      tempUploads: stats.tempUploads,
      offlineSubsets: stats.offlineSubsets,
      offlineDownloads: stats.offlineDownloads,
      subsetCacheEntries: subsetCache.size,
      fontBufferCacheEntries: fontBufferCache.size,
    }),
  };
}

/** 允许上报的匿名事件类型 —— 白名单校验，防止任意字段注入 */
const OFFLINE_EVENTS = new Set(["offline_subset", "offline_download"]);

/**
 * POST /api/stats/event — 离线裁剪匿名事件上报
 *
 * 离线裁剪完全在浏览器端完成，字体和文字均不经过服务器。
 * 这里只接收事件类型并累计计数，不记录任何内容数据，隐私无损。
 * 请求体：{ event: "offline_subset" | "offline_download" }
 */
export async function handleStatsEvent(req: Request, _res: Response) {
  try {
    /** 服务器把 body 挂在 _bodyBuffer 上（LLRT 下手写 Request 不支持 req.json()） */
    const buf = (req as Request & { _bodyBuffer?: ArrayBuffer })._bodyBuffer;
    if (!buf || buf.byteLength === 0) {
      return { req, res: jsonResponse({ success: false, error: "请求体为空" }, 400) };
    }
    const body = JSON.parse(new TextDecoder().decode(buf)) as { event?: string };
    if (!body || typeof body.event !== "string" || !OFFLINE_EVENTS.has(body.event)) {
      return { req, res: jsonResponse({ success: false, error: "unknown event" }, 400) };
    }
    if (body.event === "offline_subset") stats.offlineSubsets++;
    else stats.offlineDownloads++;
    markStatsDirty();
    return { req, res: jsonResponse({ success: true }) };
  } catch {
    return { req, res: jsonResponse({ success: false, error: "invalid body" }, 400) };
  }
}
