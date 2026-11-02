/**
 * 字体聚类 —— 基于锚点字位图（.gidx v3）的字体间相似度聚类。
 *
 * 相似字体归入同簇并选出代表（medoid），搜索时先评簇代表、按分数排序簇、
 * 跳过远簇（剪枝），让高分命中更早到达前端并减少裁剪加载。
 *
 * 聚类结果持久化在 `font/clusters.json`：{ v, fingerprints, clusters }。
 * 指纹 = 全部字体的 `name:mtimeMs` 集合，字体增删/替换自动失效重建。
 *
 * 构建时机：首次 glyph-match 请求触发后台惰性构建（一次一个字体走内存闸门），
 * 构建期间搜索退回目录顺序全量扫，功能无损。
 *
 * 注意：两两相似度为 O(n²)（n=簇前字体数），千级字体库需要换抽样/LSH，
 * 当前百级以内毫秒~秒级可接受。
 */
import { loadGlyphIndex, indexBitmap, glyphIndexPath } from "./glyph_index";
import { glyphSimilarity } from "./glyph_bitmap";
import { findFontPath } from "../shared";
import { stat, readFile, writeFile } from "../interface";

const CLUSTER_VERSION = 1;
const CLUSTER_FILE = "font/clusters.json";
/** 平均相似度达到该阈值才并簇 */
const MERGE_THRESHOLD = 0.72;
/** 共同锚点字少于该数时视为无法比较，相似度记中性值 */
const MIN_COMMON_ANCHORS = 8;
const NEUTRAL_SIM = 0.5;

export interface FontCluster {
  medoid: string;
  members: string[];
}

interface ClusterFile {
  v: number;
  /** 字体指纹集合（`name:mtimeMs`），用于失效判断 */
  fingerprints: string[];
  clusters: FontCluster[];
}

/**
 * 取单个字体的锚点字位图集合；无 .gidx 时返回 null（**不自行解析源字体**：
 * 避免与搜索慢路径的全量解析并发撞容器内存上限，未索引字体由慢路径
 * 内联建好 .gidx 后，指纹不匹配自动触发下一轮聚类重建，自愈）。
 */
async function anchorVector(font: string): Promise<Map<number, Uint8Array> | null> {
  const fontPath = await findFontPath(font);
  if (!fontPath) return null;
  const index = await loadGlyphIndex(fontPath);
  if (!index) return null;
  const vector = new Map<number, Uint8Array>();
  for (const cp of index.offsets.keys()) {
    const bitmap = indexBitmap(index, cp);
    if (bitmap) vector.set(cp, bitmap);
  }
  return vector;
}

/** 两字体的平均锚点相似度 */
function anchorSimilarity(
  a: Map<number, Uint8Array>,
  b: Map<number, Uint8Array>,
): number {
  let sum = 0;
  let common = 0;
  for (const [cp, bitmap] of a) {
    const other = b.get(cp);
    if (!other) continue;
    sum += glyphSimilarity(bitmap, other);
    common++;
  }
  if (common < MIN_COMMON_ANCHORS) return NEUTRAL_SIM;
  return sum / common;
}

/** 贪心凝聚聚类：反复合并平均相似度最高且 ≥ 阈值的簇对 */
function agglomerate(names: string[], sims: Map<string, number>): FontCluster[] {
  let groups = names.map((name) => [name]);
  const pairSim = (ga: string[], gb: string[]) => {
    let sum = 0;
    for (const a of ga) for (const b of gb) sum += sims.get(`${a}\0${b}`) ?? NEUTRAL_SIM;
    return sum / (ga.length * gb.length);
  };
  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let bestSim = MERGE_THRESHOLD;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const sim = pairSim(groups[i]!, groups[j]!);
        if (sim >= bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;
    groups[bestI] = [...groups[bestI]!, ...groups[bestJ]!];
    groups.splice(bestJ, 1);
  }
  /** medoid = 簇内平均相似度最高的成员 */
  return groups.map((members) => {
    let medoid = members[0]!;
    let bestAvg = -1;
    for (const candidate of members) {
      let sum = 0;
      let n = 0;
      for (const other of members) {
        if (other === candidate) continue;
        sum += sims.get(`${candidate}\0${other}`) ?? NEUTRAL_SIM;
        n++;
      }
      const avg = n > 0 ? sum / n : 1;
      if (avg > bestAvg) {
        bestAvg = avg;
        medoid = candidate;
      }
    }
    return { medoid, members };
  });
}

/**
 * 计算当前**已有 .gidx** 的字体指纹（name:mtimeMs）：未索引字体不参与聚类，
 * 其索引建好后指纹变化触发重建，新字体自动汇入。
 */
async function fingerprintsOf(fonts: string[]): Promise<string[]> {
  const parts: string[] = [];
  for (const font of fonts) {
    const fontPath = await findFontPath(font);
    if (!fontPath) continue;
    try {
      const idx = await stat(glyphIndexPath(fontPath));
      if (!idx.isFile()) continue;
      const s = await stat(fontPath);
      if (s.isFile()) parts.push(`${font}:${s.mtimeMs}`);
    } catch {}
  }
  return parts.sort();
}

/** 读取聚类；指纹与当前字体清单不一致（或文件不存在/损坏）返回 null */
export async function loadClusters(fonts: string[]): Promise<FontCluster[] | null> {
  try {
    const bytes = await readFile(CLUSTER_FILE);
    const file = JSON.parse(new TextDecoder().decode(bytes)) as ClusterFile;
    if (file.v !== CLUSTER_VERSION) return null;
    const current = await fingerprintsOf(fonts);
    const saved = [...file.fingerprints].sort();
    if (saved.length !== current.length || saved.some((v, i) => v !== current[i])) return null;
    return file.clusters;
  } catch {
    return null;
  }
}

/* ─── 后台惰性构建：一次构建一份，进程内去重 ─── */

let building = false;
let pendingFonts: string[] | null = null;

/** 请求路径调用：聚类过期时排一次后台重建，不阻塞当前请求 */
export function scheduleClusterBuild(fonts: string[]): void {
  pendingFonts = [...fonts];
  if (building) return;
  building = true;
  void (async () => {
    try {
      for (;;) {
        const list = pendingFonts;
        pendingFonts = null;
        if (!list) return;
        try {
          await buildClusters(list);
          console.log(`[font-cluster] 聚类完成：${list.length} 字体`);
        } catch (err) {
          console.error("[font-cluster] 构建失败:", err instanceof Error ? err.message : err);
        }
      }
    } finally {
      building = false;
    }
  })();
}

/** 全量计算并落盘聚类文件 */
async function buildClusters(fonts: string[]): Promise<void> {
  const vectors = new Map<string, Map<number, Uint8Array>>();
  for (const font of fonts) {
    const vector = await anchorVector(font);
    if (vector) vectors.set(font, vector);
  }
  const names = [...vectors.keys()];
  /** 一个 .gidx 都没有时跳过落盘：此时写出的空聚类无意义，等首批索引建好再试 */
  if (names.length === 0) return;
  const sims = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const sim = anchorSimilarity(vectors.get(names[i]!)!, vectors.get(names[j]!)!);
      sims.set(`${names[i]!}\0${names[j]!}`, sim);
      sims.set(`${names[j]!}\0${names[i]!}`, sim);
    }
  }
  const clusters = agglomerate(names, sims);
  const file: ClusterFile = {
    v: CLUSTER_VERSION,
    fingerprints: await fingerprintsOf(fonts),
    clusters,
  };
  await writeFile(CLUSTER_FILE, new TextEncoder().encode(JSON.stringify(file)));
}
