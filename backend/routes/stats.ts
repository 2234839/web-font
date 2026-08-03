import { jsonResponse, stats, subsetCache, fontBufferCache } from "../shared";

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
      subsetCacheEntries: subsetCache.size,
      fontBufferCacheEntries: fontBufferCache.size,
    }),
  };
}
