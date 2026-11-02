/**
 * POST /api/glyph-match —— 逐字体裁剪、逐字评分，并以 NDJSON 流式返回。
 *
 * 每个候选字体只经过一次现有裁剪管线；同一份 woff2 同时供前端预览。
 * 不缓存完整字体对象，也不为了生成预览再发起第二轮全库裁剪。
 */
import { Font } from "../../vendor/fonteditor-core/lib/ttf/font";
import { jsonResponse, findFontPath } from "../shared";
import { readdir, stat } from "../interface";
import { fontDirs, subsetQueueTimeoutSeconds, glyphMatchSlowConcurrency } from "../config";
import { getGlyphBitmap, glyphSimilarity, distanceTransform, hasGlyph, type SubsetTtfObject } from "../font_util/glyph_bitmap";
import { estimateSubsetMemory, subsetFontFile } from "../font_util/subset_file";
import { loadGlyphIndex, indexBitmap, writeGlyphIndex, markIndexBuilt } from "../font_util/glyph_index";
import { ANCHOR_CHARS } from "../font_util/common_chars";
import { loadClusters, scheduleClusterBuild, type FontCluster } from "../font_util/font_cluster";
import { withMemoryGate } from "../subset_queue";
/** 单个查询字形 */
interface QueryGlyph {
  char: string;
  bitmap: string;
}

interface ParsedQueryGlyph {
  char: string;
  bitmap: Uint8Array;
  /** 查询位图的距离场，解析后算一次，全库扫描复用（原本每字体重复计算） */
  dt: Float32Array;
  queryIndex: number;
}

/** 候选位图距离场缓存：字体索引位图静态不变，DT 结果可跨请求复用 */
const candidateDtCache = new Map<string, Float32Array>();
/** 上限 4096 条 × 16KB = 64MB，插入序淘汰最旧 */
const CANDIDATE_DT_MAX = 4096;

/** 取候选位图距离场（命中缓存免重算，未命中计算并缓存） */
function candidateDt(font: string, codePoint: number, bitmap: Uint8Array): Float32Array {
  const key = `${font}|${codePoint}`;
  const hit = candidateDtCache.get(key);
  if (hit) return hit;
  const dt = distanceTransform(bitmap);
  if (candidateDtCache.size >= CANDIDATE_DT_MAX) {
    candidateDtCache.delete(candidateDtCache.keys().next().value!);
  }
  candidateDtCache.set(key, dt);
  return dt;
}

/** 流式响应事件 */
type GlyphMatchEvent =
  | { type: "start"; total: number }
  | { type: "font"; font: string; subset: string }
  | { type: "glyph"; font: string; glyph: { char: string; score: number; queryIndex: number } | null; missing: boolean }
  | { type: "fontDone"; font: string }
  | { type: "done" };

/** 01 串 → Uint8Array；非法输入返回 null */
function parseBitmap(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length !== 64 * 64) return null;
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 48 && c !== 49) return null;
    out[i] = c - 48;
  }
  return out;
}

/** 遍历字体目录收集候选字体文件名（含临时上传） */
async function listCandidateFonts(): Promise<string[]> {
  const names: string[] = [];
  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(entry.name)) {
          names.push(entry.name);
        }
      }
    } catch {}
  }
  return names;
}

/**
 * 裁剪管线的内存 ttf 对象中 glyf 已是子集但 cmap 仍是原始 gid 映射，
 * 按字形自带的 unicode 标注重建 codepoint→新 gid 映射。
 * 返回浅拷贝视图（glyf 共享引用），不修改原对象以免影响序列化。
 */
function buildSubsetCmapView(ttf: Record<string, unknown>): SubsetTtfObject {
  const glyf = ttf.glyf as Array<{ unicode?: number | number[] }>;
  const cmap: Record<number, number> = {};
  for (const [index, glyph] of glyf.entries()) {
    if (!glyph.unicode) continue;
    for (const cp of Array.isArray(glyph.unicode) ? glyph.unicode : [glyph.unicode]) {
      if (!(cp in cmap)) cmap[cp] = index;
    }
  }
  return { ...ttf, cmap } as unknown as SubsetTtfObject;
}

/** 依次产出事件；每次只保留下一个候选字体的数据，浏览器背压会自然暂停后续裁剪 */
/**
 * 慢路径（源字体裁剪解析）信号量：单字体解析后的对象图可达上百 MB。
 * 并发度来自配置（GLYPH_MATCH_SLOW_CONCURRENCY）：默认 1 为最保守形态，
 * 内存充裕的部署（如 Node + 大内存容器）可调大提升冷路径吞吐。
 */
const SLOW_PATH_CONCURRENCY = glyphMatchSlowConcurrency;
let slowInFlight = 0;
const slowWaiters: (() => void)[] = [];
/** 占一个慢路径槽位（异步等待直到有空位） */
async function acquireSlowSlot(): Promise<void> {
  if (slowInFlight < SLOW_PATH_CONCURRENCY) {
    slowInFlight++;
    return;
  }
  await new Promise<void>((resolve) => slowWaiters.push(resolve));
  slowInFlight++;
}
/** 释放慢路径槽位并唤醒一个等待者 */
function releaseSlowSlot(): void {
  slowInFlight--;
  slowWaiters.shift()?.();
}

/** 单个字体的评分事件（普通 async 函数，不使用 async generator：LLRT 下嵌套 generator 驱动会非确定性饿死上百秒） */
async function matchFontEvents(
  font: string,
  queryGlyphs: ParsedQueryGlyph[],
): Promise<GlyphMatchEvent[]> {
  const fontPath = await findFontPath(font);
  if (!fontPath) return [];

  /** 快路径：字形索引命中则免读源字体、免裁剪，纯查表评分 */
  const index = await loadGlyphIndex(fontPath);
  const events: GlyphMatchEvent[] = [];
  if (index) {
    let started = false;
    let hasMatch = false;
    for (const query of queryGlyphs) {
      const codePoint = query.char.codePointAt(0)!;
      const candidate = indexBitmap(index, codePoint);
      if (!candidate) {
        if (started) events.push({ type: "glyph", font, glyph: null, missing: true });
        continue;
      }
      if (!started) {
        started = true;
        events.push({ type: "font", font, subset: "" });
      }
      hasMatch = true;
      events.push({
        type: "glyph",
        font,
        glyph: { char: query.char, score: glyphSimilarity(query.bitmap, candidate, query.dt, candidateDt(font, codePoint, candidate)), queryIndex: query.queryIndex },
        missing: false,
      });
    }
    if (started && !hasMatch) events.push({ type: "glyph", font, glyph: null, missing: true });
    if (started) return events;
  }

  /** 慢路径：索引未覆盖查询字（或无索引）时走裁剪管线（事件缓存 + 内存闸门） */
  await acquireSlowSlot();
  try {
    return await slowPathEvents(fontPath, font, index, queryGlyphs);
  } finally {
    releaseSlowSlot();
  }
}

/** 慢路径事件缓存上限：防止长尾查询字组合无限膨胀 */
const EVENTS_CACHE_MAX = 64;
/** fontPath+查询签名 → 评分事件；命中免 subset 免解析（LLRT 下 bytes 重解析会挂起/失败，故直接缓存结果） */
const eventsCache = new Map<string, GlyphMatchEvent[]>();

/** FNV-1a 拼接哈希：查询字集 + 位图指纹，同前端重复搜索可命中缓存 */
function querySignature(queryGlyphs: ParsedQueryGlyph[]): string {
  let h = 0x811c9dc5;
  for (const glyph of queryGlyphs) {
    for (let i = 0; i < glyph.bitmap.length; i++) {
      h ^= glyph.bitmap[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= glyph.char.length;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${queryGlyphs.map((g) => g.char).join("")}|${h.toString(36)}`;
}

/**
 * 慢路径纯函数版：subset → 建索引 → 评分一次算完，返回事件数组。
 * 不在异步生成器体内做重活：LLRT 下生成器上下文与其他 worker 的
 * 穿插执行会触发 native crash（实测独立串行同代码完全正常）。
 * 重复查询直接命中事件缓存，不做 bytes 重解析（Font.create 对部分
 * 字体在 LLRT 下解析挂起/抛错）。
 */
async function slowPathEvents(
  fontPath: string,
  font: string,
  index: Awaited<ReturnType<typeof loadGlyphIndex>>,
  queryGlyphs: ParsedQueryGlyph[],
): Promise<GlyphMatchEvent[]> {
  const queryChars = [...new Set(queryGlyphs.map((glyph) => glyph.char))].join("");
  const cacheKey = `${fontPath}\0${querySignature(queryGlyphs)}`;
  const hit = eventsCache.get(cacheKey);
  if (hit) return hit;
  /** 裁剪文本 = 查询字 + 锚点字（无索引时）：一次 subset 同时拿到评分素材与建 .gidx 素材 */
  const text = index ? queryChars : [...new Set(queryChars + ANCHOR_CHARS)].join("");
  const memoryBytes = await estimateSubsetMemory(fontPath);
  const subset = await withMemoryGate(
    () => subsetFontFile(fontPath, text, "ttf"),
    subsetQueueTimeoutSeconds * 1000,
    memoryBytes,
  );
  if (!subset) throw new Error(`字体裁剪排队超时：${font}`);
  /** 只用裁剪管线返回的内存 ttf 对象；无内存对象的（OTF/CFF）不参与评分 */
  if (!subset.ttf) return [];
  const ttf = buildSubsetCmapView(subset.ttf);
  /** 无索引（冷启动）：用含锚点字的 subset 顺带建 .gidx，免去全量解析（LLRT 下并发全量解析会 native crash） */
  if (!index) {
    const src = await stat(fontPath);
    await writeGlyphIndex(fontPath, ttf, src.mtimeMs);
    markIndexBuilt(fontPath);
  }
  const events: GlyphMatchEvent[] = [];
  let started = false;
  let hasMatch = false;
  for (const query of queryGlyphs) {
    const codePoint = query.char.codePointAt(0)!;
    if (!hasGlyph(ttf, codePoint)) {
      if (started) events.push({ type: "glyph", font, glyph: null, missing: true });
      continue;
    }
    if (!started) {
      started = true;
      events.push({ type: "font", font, subset: "" });
    }
    const candidate = getGlyphBitmap(ttf, codePoint);
    if (!candidate) {
      events.push({ type: "glyph", font, glyph: null, missing: true });
      continue;
    }
    hasMatch = true;
    events.push({
      type: "glyph",
      font,
      glyph: { char: query.char, score: glyphSimilarity(query.bitmap, candidate, query.dt, candidateDt(font, codePoint, candidate)), queryIndex: query.queryIndex },
      missing: false,
    });
  }
  /** 全部缺字的候选不展示，但仍计入完成进度 */
  if (started && !hasMatch) events.push({ type: "glyph", font, glyph: null, missing: true });
  if (eventsCache.size >= EVENTS_CACHE_MAX) {
    /** Map 迭代序即插入序，淘汰最旧项 */
    eventsCache.delete(eventsCache.keys().next().value!);
  }
  eventsCache.set(cacheKey, events);
  return events;
}

/** 簇代表分低于最佳代表分该幅度时，整簇剪掉不扫（近似搜索：换来大幅减少裁剪加载） */
const PRUNE_MARGIN = 0.35;

/**
 * 聚类感知的扫描顺序：先评各簇代表（medoid）得分，簇按分数降序排列，
 * 远簇整体剪枝；未入簇字体（新上传）附在末尾不剪。
 * medoid 评分走 matchFontEvents 慢路径（事件缓存命中后重扫很便宜）。
 */
async function orderFontsByCluster(
  fonts: string[],
  clusters: FontCluster[],
  queryGlyphs: ParsedQueryGlyph[],
): Promise<{ order: string[]; pruned: Set<string> }> {
  const medoidScore = new Map<string, number>();
  for (const cluster of clusters) {
    let sum = 0;
    let n = 0;
    try {
      for (const event of await matchFontEvents(cluster.medoid, queryGlyphs)) {
        if (event.type === "glyph" && event.glyph) {
          sum += event.glyph.score;
          n++;
        }
      }
    } catch (err) {
      console.error(`[glyph-match] medoid ${cluster.medoid} 评分失败:`, err instanceof Error ? err.stack ?? err.message : String(err));
    }
    medoidScore.set(cluster.medoid, n > 0 ? sum / n : 0);
  }
  const sorted = [...clusters].sort(
    (a, b) => (medoidScore.get(b.medoid) ?? 0) - (medoidScore.get(a.medoid) ?? 0),
  );
  const best = sorted[0] ? (medoidScore.get(sorted[0]!.medoid) ?? 0) : 0;
  const order: string[] = [];
  const pruned = new Set<string>();
  for (const cluster of sorted) {
    const score = medoidScore.get(cluster.medoid) ?? 0;
    if (score < best - PRUNE_MARGIN) {
      for (const member of cluster.members) pruned.add(member);
      continue;
    }
    /** medoid 评分阶段已填充事件缓存，扫描阶段重扫走缓存命中，成本远低于首次裁剪 */
    order.push(cluster.medoid, ...cluster.members.filter((m) => m !== cluster.medoid));
  }
  const clustered = new Set(clusters.flatMap((c) => c.members));
  for (const font of fonts) {
    if (!clustered.has(font)) order.push(font);
  }
  return { order, pruned };
}

/**
 * 全库搜索事件收集：串行逐字体处理，一次性返回全部事件。
 * 不用 async generator / worker 池 / ReadableStream：LLRT 0.8/0.9 下这些原语
 * 在高频穿插中会非确定性饿死（单次 next 挂上百秒）甚至 native segfault，
 * 串行普通循环 + 整体返回是最稳的形态。
 */
async function collectMatchEvents(
  fonts: string[],
  pruned: Set<string>,
  queryGlyphs: ParsedQueryGlyph[],
): Promise<GlyphMatchEvent[]> {
  const all: GlyphMatchEvent[] = [{ type: "start", total: fonts.length + pruned.size }];
  for (const font of pruned) {
    all.push({ type: "fontDone", font });
  }
  for (const font of fonts) {
    try {
      all.push(...(await matchFontEvents(font, queryGlyphs)));
    } catch (err) {
      /** 单个字体裁剪/解析失败不拖垮整个搜索，记录后继续下一个 */
      console.error(`[glyph-match] ${font} 处理失败:`, err instanceof Error ? err.stack ?? err.message : String(err), err);
    }
    all.push({ type: "fontDone", font });
  }
  all.push({ type: "done" });
  return all;
}

export async function handleGlyphMatch(req: Request, _res: Response) {
  let body: { glyphs?: QueryGlyph[] };
  try {
    /** 项目 HTTP 服务把请求体放在 _bodyBuffer，不能直接调用 Request.json() */
    const buf = (req as Request & { _bodyBuffer?: ArrayBuffer })._bodyBuffer;
    if (!buf || buf.byteLength === 0) {
      return { req, res: jsonResponse({ error: "request body required" }, 400) };
    }
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return { req, res: jsonResponse({ error: "invalid json" }, 400) };
  }
  const queryGlyphs = (body.glyphs ?? [])
    .map((glyph, queryIndex) => ({
      char: typeof glyph?.char === "string" ? glyph.char : "",
      bitmap: parseBitmap(glyph?.bitmap),
      queryIndex,
    }))
    .filter((glyph): glyph is ParsedQueryGlyph => glyph.char.length > 0 && glyph.bitmap !== null)
    .map((glyph) => ({ ...glyph, dt: distanceTransform(glyph.bitmap) }));

  if (queryGlyphs.length === 0) {
    return { req, res: jsonResponse({ error: "glyphs required (char + 64x64 bitmap)" }, 400) };
  }

  const fonts = await listCandidateFonts();
  /** 聚类可用时按簇序扫描 + 剪枝；不可用退回目录顺序全量扫，并触发后台重建聚类 */
  const clusters = await loadClusters(fonts);
  let scanOrder = fonts;
  let pruned = new Set<string>();
  if (clusters && clusters.length > 1) {
    const t0 = Date.now();
    ({ order: scanOrder, pruned } = await orderFontsByCluster(fonts, clusters, queryGlyphs));
    console.log(`[glyph-match] 聚类排序 ${Date.now() - t0}ms（剪枝 ${pruned.size}）`);
  } else if (!clusters) {
    scheduleClusterBuild(fonts);
  }
  const encoder = new TextEncoder();
  const events = await collectMatchEvents(scanOrder, pruned, queryGlyphs);
  /**
   * 一次性收集全部事件再返回完整 NDJSON body（不流式）。
   * LLRT 的 ReadableStream pull + pipeTo 在高频穿插下存在非确定性
   * 卡死/崩溃（0.8/0.9 均复现），评分本身已亚秒级，牺牲渐进展示换稳定。
   * 前端逐行解析 NDJSON 的逻辑对完整 body 同样兼容。
   */
  const responseBody = encoder.encode(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const res = new Response(null, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "Connection": "close",
    },
  });
  /** 直接挂 body bytes：走 server 层的直接写回通道（含 Content-Length），绕开 LLRT blob 挂起 */
  (res as Response & { _bodyBytes?: Uint8Array })._bodyBytes = responseBody;
  return { req, res };
}
