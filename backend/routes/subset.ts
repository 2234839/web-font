import { parseUrl, stats, subsetCache, findFontPath, markStatsDirty } from "../shared";
import { markFontUsed } from "../temp_cleaner";
import { withMemoryGate } from "../subset_queue";
import { estimateSubsetMemory, subsetFontFile } from "../font_util/subset_file";
import { subsetQueueTimeoutSeconds } from "../config";

/**
 * 进程启动时戳（模块加载时取一次，进程重启即变化）
 *
 * 用 Date.now() 而非 process.uptime()：后者在 LLRT 运行时不存在（typeof === "undefined"），
 * 调用会抛 TypeError: not a function，导致容器启动即崩溃。
 * Date.now() 在 Node 与 LLRT 中均可用，且模块只加载一次，取到的就是稳定的启动时戳。
 */
/**
 * 构建期由 tsdown define 注入的真实版本号
 *
 * 仅 declare（无运行时定义）—— 生产构建时 tsdown 会把它替换为字面量字符串。
 * 开发态用 `pnpx tsx` 直接跑源码不走构建，此时 PACKAGE_VERSION 未定义，
 * 用 typeof 探测兜底为 "dev"，避免 ReferenceError 崩溃。
 * 开发态缓存失效靠下面的 PROCESS_START_TIME 保障，版本号取何值无所谓。
 */
declare const PACKAGE_VERSION: string;
/** 生产=注入的版本号；开发(tsx 直跑)= "dev" */
const RESOLVED_VERSION = typeof PACKAGE_VERSION !== "undefined" ? PACKAGE_VERSION : "dev";
/** 进程启动时刻，重启进程即变化 —— 用于开发态「重启即重置内存缓存」 */
const PROCESS_START_TIME = Date.now();
/**
 * 子集化版本指纹
 *
 * 纳入 subsetCache 的 key，让旧缓存条目在以下两种场景自动失效，无需手动清缓存：
 *  - 生产：发版 bump package.json 的 version（构建期由 tsdown define 注入），旧缓存自然过期
 *  - 开发：pnpm dev 重启进程时 PROCESS_START_TIME 变化，内存缓存整体重置
 *
 * 杜绝「子集化代码已修但缓存返回旧错误结果」的陷阱。
 */
/** 导出供 glyph-match 复用同一缓存命名空间（版本指纹+进程启动时间） */
export const SUBSET_CACHE_KEY = `${RESOLVED_VERSION}:${PROCESS_START_TIME}`;

/** GET /api?font=...&text=... — 字体裁剪 */
export async function handleFontSubset(req: Request, res: Response) {
  /** 入口时间戳，用于响应头 X-Timing-* 分阶段耗时排查 */
  const t0 = Date.now();
  const url = parseUrl(req);
  const params = new URLSearchParams(url.search);
  const font = params.get("font") || "";
  const text = params.get("text") || "";
  if (text.length === 0) {
    return { req, res };
  }

  const fontPath = await findFontPath(font);
  /** findFontPath 结束时间戳（含可能的 readdir 遍历字体目录） */
  const t1 = Date.now();
  if (!fontPath) {
    return {
      req,
      res: new Response(`Font not found: ${font}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  /** 默认 ttf（兼容性最好） */
  const outTypeParam = params.get("outType") || "";
  const outType = (outTypeParam === "woff2" || outTypeParam === "ttf") ? outTypeParam : "ttf";

  /** 记录字体被使用（临时字体保留机制依赖此时间） */
  markFontUsed(fontPath);

  /** 查询裁剪结果缓存 */
  /** 版本指纹纳入 key：代码变更后旧缓存自动失效 */
  const cacheKey = `${SUBSET_CACHE_KEY}:${fontPath}:${outType}:${text}`;
  stats.subsetRequests++;
  stats.totalChars += text.length;
  markStatsDirty();
  const cached = subsetCache.get(cacheKey);
  if (cached) {
    stats.subsetCacheHits++;
    markStatsDirty();
    const contentTypes: Record<string, string> = { ttf: "font/ttf", woff2: "font/woff2" };
    return {
      req,
      res: new Response(cached.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": contentTypes[outType] || "font/ttf",
          "Cache-Control": "public, max-age=86400",
          "X-Cache": "HIT",
          /** 缓存命中时仅 findFontPath + cache.get 耗时（毫秒） */
          "X-Timing-Total": `${t1 - t0}`,
        },
      }),
    };
  }

  const memoryBytes = await estimateSubsetMemory(fontPath);
  /** 完整字体读取和裁剪都位于共享内存闸门内；缓存命中不占用重任务槽位 */
  const subsetResult = await withMemoryGate(
    () => subsetFontFile(fontPath, text, outType),
    subsetQueueTimeoutSeconds * 1000,
    memoryBytes,
  );

  /** 排队超时，返回 503 让客户端重试 */
  if (subsetResult === null) {
    return {
      req,
      res: new Response("Server busy, please retry", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": "1",
        },
      }),
    };
  }

  const newFont = subsetResult.bytes;
  const t3 = Date.now();

  /** 写入裁剪结果缓存（与找字体共享；ttf 对象一并缓存供评分直接复用） */
  subsetCache.set(cacheKey, { bytes: newFont, ttf: subsetResult.ttf ?? null });

  const contentTypes: Record<string, string> = { ttf: "font/ttf", woff2: "font/woff2" };

  return {
    req,
    res: new Response(newFont as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": contentTypes[outType] || "font/ttf",
        "Cache-Control": "public, max-age=86400",
        "X-Cache": "MISS",
        /** 分阶段耗时（毫秒），供排查服务端处理时间分布 */
        "X-Timing-Find": `${t1 - t0}`,
        "X-Timing-Read": `${subsetResult.readMs}`,
        "X-Timing-Subset": `${subsetResult.subsetMs}`,
        "X-Timing-Total": `${t3 - t0}`,
      },
    }),
  };
}
