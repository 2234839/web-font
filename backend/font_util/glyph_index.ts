/**
 * 字形位图索引（v3）—— 只存聚类锚点字（32 字，见 common_chars.ts）的 64x64 位图。
 * 用途：字体间相似度聚类（font_cluster.ts 读锚点位图算距离），不承担搜索评分。
 * 体积：32 字 × 512B = 16KB 原始，zlib 后 ~10KB/字体，可忽略不计。
 *
 * 索引文件 `<字体路径>.gidx`（与字体同目录，随数据卷持久化）：
 *   [magic u32 "GDIX"][headerLen u32][header JSON][位图区 zlib 压缩流]
 * header: { v: 版本, mtime: 源字体 mtimeMs（源文件替换后自动失效）, chars: 码点升序列表 }
 *
 * 构建 = 完整解析源字体并逐锚点字光栅化，内存开销与一次裁剪同量级，
 * 因此统一走 withMemoryGate 串行执行（一次只构建一个字体，不会撑爆容器）。
 */
import { deflateSync, inflateSync } from "zlib";
import { Font } from "../../vendor/fonteditor-core/lib/ttf/font";
import { getGlyphBitmap, type SubsetTtfObject } from "./glyph_bitmap";
import { ANCHOR_CHAR_CODES } from "./common_chars";
import { readFile, writeFile, stat } from "../interface";
import { withMemoryGate } from "../subset_queue";
import { estimateSubsetMemory } from "./subset_file";

const MAGIC = 0x47444958;
const INDEX_VERSION = 3;
/** 单个 64x64 二值位图打包后的字节数 */
const BLOCK_BYTES = 512;
/** 索引覆盖的码点集合（构建时过滤） */
const ANCHOR_CHAR_SET = new Set<number>(ANCHOR_CHAR_CODES);

/** 索引路径：与源字体同目录同名 + .gidx */
export function glyphIndexPath(fontPath: string): string {
  return `${fontPath}.gidx`;
}

/** 已加载的索引：码点 → 位图块序号 */
export interface GlyphIndex {
  offsets: Map<number, number>;
  data: Uint8Array;
}

/** 读取并校验索引；源字体已更新（mtime 变化）或格式不符时返回 null */
export async function loadGlyphIndex(fontPath: string): Promise<GlyphIndex | null> {
  let bytes: Uint8Array;
  let fontMtime: number;
  try {
    const idx = await stat(glyphIndexPath(fontPath));
    const src = await stat(fontPath);
    if (!idx.isFile() || !src.isFile()) return null;
    bytes = await readFile(glyphIndexPath(fontPath));
    fontMtime = src.mtimeMs;
  } catch {
    return null;
  }
  if (bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== MAGIC) return null;
  const headerLen = view.getUint32(4, false);
  if (8 + headerLen > bytes.length) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen))) as {
      v: number;
      mtime: number;
      chars: number[];
    };
    if (header.v !== INDEX_VERSION || header.mtime !== fontMtime) return null;
    const offsets = new Map<number, number>();
    header.chars.forEach((cp, i) => offsets.set(cp, i));
    /** v2 起位图区整体 zlib 压缩，inflate 是一次性的数 ms 级操作 */
    const data = inflateSync(bytes.subarray(8 + headerLen));
    if (data.length !== header.chars.length * BLOCK_BYTES) return null;
    return { offsets, data };
  } catch {
    return null;
  }
}

/** 取索引中某码点的位图（512B 解包为 4096 个 0/1）；缺字返回 null */
export function indexBitmap(index: GlyphIndex, codePoint: number): Uint8Array | null {
  const block = index.offsets.get(codePoint);
  if (block === undefined) return null;
  const out = new Uint8Array(BLOCK_BYTES * 8);
  const base = block * BLOCK_BYTES;
  for (let i = 0; i < BLOCK_BYTES; i++) {
    const b = index.data[base + i]!;
    for (let bit = 0; bit < 8; bit++) out[i * 8 + bit] = (b >> (7 - bit)) & 1;
  }
  return out;
}

/** 64x64 二值位图打包为 512B */
function packBitmap(bitmap: Uint8Array): Uint8Array {
  const out = new Uint8Array(BLOCK_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) b = (b << 1) | (bitmap[i * 8 + bit]! ? 1 : 0);
    out[i] = b;
  }
  return out;
}

/**
 * 完整解析源字体为内存 ttf 对象（对象图较大，调用方负责内存闸门/串行）。
 * 搜索慢路径复用同一份解析结果评分 + 建索引，避免冷启动时同一字体解析两次。
 */
export async function parseFontTtf(fontPath: string): Promise<SubsetTtfObject | null> {
  const buffer = await readFile(fontPath);
  const sourceType = fontPath.split(".").pop();
  const font = Font.create(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, {
    type: (sourceType === "otf" ? "otf" : "ttf") as never,
    hinting: false,
  });
  return font.get() as unknown as SubsetTtfObject;
}

/**
 * 从已解析的 ttf 对象写出 .gidx（锚点字光栅化 + zlib 压缩落盘）。
 * 返回是否写出了有效索引（无任何锚点字时返回 false）。
 */
export async function writeGlyphIndex(fontPath: string, ttf: SubsetTtfObject, mtimeMs: number): Promise<boolean> {
  const chars: number[] = [];
  const blocks: Uint8Array[] = [];
  for (const cp of Object.keys(ttf.cmap ?? {}).map(Number).sort((a, b) => a - b)) {
    /** 只索引锚点字，控制体积在 ~10KB/字体 */
    if (!ANCHOR_CHAR_SET.has(cp)) continue;
    const bitmap = getGlyphBitmap(ttf, cp);
    if (!bitmap) continue;
    chars.push(cp);
    blocks.push(packBitmap(bitmap));
  }
  if (chars.length === 0) return false;
  const header = new TextEncoder().encode(
    JSON.stringify({ v: INDEX_VERSION, mtime: mtimeMs, chars }),
  );
  const rawRegion = new Uint8Array(blocks.length * BLOCK_BYTES);
  let regionOff = 0;
  for (const block of blocks) {
    rawRegion.set(block, regionOff);
    regionOff += BLOCK_BYTES;
  }
  const compressed = deflateSync(rawRegion, { level: 9 });
  const out = new Uint8Array(8 + header.length + compressed.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, header.length, false);
  out.set(header, 8);
  out.set(compressed, 8 + header.length);
  await writeFile(glyphIndexPath(fontPath), out);
  return true;
}

/** 构建单个字体的字形索引 = 完整解析 + 写出（调用方负责内存闸门） */
export async function buildGlyphIndex(fontPath: string): Promise<boolean> {
  const src = await stat(fontPath);
  if (!src.isFile()) return false;
  const ttf = await parseFontTtf(fontPath);
  if (!ttf) return false;
  return writeGlyphIndex(fontPath, ttf, src.mtimeMs);
}

/** 标记某字体的索引已构建（搜索慢路径内联建好后调用，避免后台队列重复构建） */
export function markIndexBuilt(fontPath: string): void {
  builtOrFailed.add(fontPath);
}

/* ─── 后台增量构建调度：一次一个字体，走内存闸门 ─── */

const builtOrFailed = new Set<string>();
const pendingPaths: string[] = [];
let building = false;

/** 把字体排入后台索引构建队列（去重；失败不重试，等下次进程重启） */
export function scheduleIndexBuild(fontPath: string): void {
  if (builtOrFailed.has(fontPath) || pendingPaths.includes(fontPath)) return;
  pendingPaths.push(fontPath);
  void drainIndexQueue();
}

async function drainIndexQueue(): Promise<void> {
  if (building) return;
  building = true;
  try {
    for (;;) {
      const fontPath = pendingPaths.shift();
      if (!fontPath) return;
      try {
        const est = await estimateSubsetMemory(fontPath);
        const ok = await withMemoryGate(() => buildGlyphIndex(fontPath), 120_000, est);
        if (!ok) throw new Error("排队超时");
        console.log(`[glyph-index] 已构建 ${fontPath.split("/").pop()}`);
      } catch (err) {
        console.error(`[glyph-index] 构建失败 ${fontPath.split("/").pop()}:`, err instanceof Error ? err.message : err);
      } finally {
        builtOrFailed.add(fontPath);
      }
    }
  } finally {
    building = false;
  }
}
