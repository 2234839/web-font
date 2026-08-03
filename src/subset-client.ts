/**
 * 浏览器端字体裁剪入口 —— 纯前端子集化，零服务器依赖
 *
 * 复用后端裁剪核心逻辑（fonteditor-core + GPOS/GSUB/CFF 子集化），
 * 但仅支持 TTF 输出（浏览器无 Node zlib，不支持 WOFF2 编码）。
 *
 * 懒加载：本模块由离线裁剪页面通过动态 import() 按需加载，
 * 不进入首页和其他页面的初始 bundle。
 *
 * 浏览器兼容性：
 *  - fonteditor-core 的 SUPPORT_BUFFER 守卫确保 Node Buffer 路径不会触发
 *  - 所有裁剪子模块（gpos/gsub/cff/otf-subset）均纯 JS，无 Node API
 *  - WOFF2 编码器（依赖 zlib）不在此 import 链中
 */
// fonteditor-core 是 CJS 格式，通过 vite-plugin-commonjs 插件即时转为 ESM
// @ts-ignore — vendor 目录的 JS 无类型声明
import { Font } from "../vendor/fonteditor-core/lib/ttf/font";

/** 字体类型标识（与 fonteditor-core 的 FontType 对齐） */
type FontType = "ttf" | "otf" | "woff" | "woff2";
import { subsetGPOS } from "../backend/font_util/gpos-subset.js";
import { subsetGSUB } from "../backend/font_util/gsub-subset.js";
import { collectReachableGsubTargets } from "../backend/font_util/gsub-reachable.js";
import { probeGsubAndCmap } from "../backend/font_util/gsub-probe.js";
import { subsetOTF } from "../backend/font_util/otf-subset.js";

/** TextEncoder 模块级单例 */
const textEncoder = new TextEncoder();

/** 从字符串提取 Unicode 码点数组 */
const textToCodePoints = (text: string) => {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) as number;
    result.push(cp);
    if (cp > 0xffff) i++;
  }
  return result;
};

/**
 * GPOS/GSUB 表子集化（按子集字形重映射 glyphId）
 *
 * 逻辑与后端 rewriteLayoutTablesForSubset 完全一致，提取为共享函数。
 */
function rewriteLayoutTablesForSubset(
  subsetOptimized: ReturnType<ReturnType<typeof Font.create>["optimize"]>,
  subsetGids: number[],
): void {
  const ttf = (subsetOptimized as any).get();

  const origToNew = new Map<number, number>();
  for (let i = 0; i < subsetGids.length; i++) origToNew.set(subsetGids[i], i);

  const origGPOS = ttf.GPOS;
  if (origGPOS) {
    const gposBytes = origGPOS instanceof Uint8Array ? origGPOS : new Uint8Array(origGPOS);
    if (gposBytes.byteLength > 0) {
      const rewritten = subsetGPOS(gposBytes, origToNew);
      if (rewritten) ttf.GPOS = rewritten;
    }
  }

  const origGSUB = ttf.GSUB;
  if (origGSUB) {
    const gsubBytes = origGSUB instanceof Uint8Array ? origGSUB : new Uint8Array(origGSUB);
    if (gsubBytes.byteLength > 0) {
      ttf.GSUB = subsetGSUB(gsubBytes, origToNew);
    }
  }
}

/**
 * 浏览器端字体裁剪 —— 逻辑与后端 fontSubset 一致，仅去掉 woff2 分支
 *
 * @param fontBuffer 原始字体字节（File.arrayBuffer() 或 fetch 结果）
 * @param subString  要保留的文本
 * @param sourceType 原始字体格式（ttf / otf / woff / woff2）
 * @returns 裁剪后的 TTF Uint8Array
 */
export function subsetFontInBrowser(
  fontBuffer: ArrayBuffer,
  subString: string,
  sourceType: FontType,
): Uint8Array {
  const codePoints = textToCodePoints(subString);

  /** OTF（CFF）输入走独立子集化路径 */
  if (sourceType === "otf") {
    const fontU8 = new Uint8Array(fontBuffer);
    /** outType 固定传 ttf：浏览器端只产出 TTF（otf-subset 内部 ttf 模式返回裸 OTF sfnt） */
    const otfBytes = subsetOTF(fontU8, codePoints, true, "ttf");
    if (otfBytes !== null) {
      return otfBytes;
    }
    /** subsetOTF 不支持时降级到 fonteditor 路径 */
  }

  /** GSUB 连字 target glyph 保留探测 */
  let extraSubsetGids: number[] | undefined;
  const probe = probeGsubAndCmap(fontBuffer, codePoints, sourceType);
  let probedSeedGids: Set<number> | undefined;
  let probedGsubBytes: Uint8Array | undefined;
  let presetCmap: Record<number, number> | undefined;

  if (probe.ok) {
    probedGsubBytes = probe.gsubBytes;
    probedSeedGids = new Set<number>();
    probedSeedGids.add(0);
    presetCmap = {};
    for (const cp of codePoints) {
      const gid = probe.lookup.get(cp);
      if (gid !== undefined) {
        probedSeedGids.add(gid);
        presetCmap[cp] = gid;
      }
    }
  } else if (probe.needsFallback) {
    const probeFont = Font.create(fontBuffer, {
      type: sourceType,
      subset: codePoints,
      kerning: true,
    });
    const probeTtf = (probeFont as any).get();
    const origGSUB = probeTtf.GSUB;
    const origCmap = probeTtf.cmap;
    if (origGSUB && origCmap) {
      probedGsubBytes = origGSUB instanceof Uint8Array ? origGSUB : new Uint8Array(origGSUB);
      probedSeedGids = new Set<number>();
      probedSeedGids.add(0);
      for (const cp of codePoints) {
        const gid = origCmap[cp];
        if (gid !== undefined) probedSeedGids.add(gid);
      }
    }
  }
  if (probedGsubBytes && probedSeedGids) {
    const reachable = collectReachableGsubTargets(probedGsubBytes, probedSeedGids);
    if (reachable.size > 0) extraSubsetGids = [...reachable];
  }

  const font = Font.create(fontBuffer, {
    type: sourceType,
    subset: codePoints,
    kerning: true,
    extraSubsetGids,
    presetCmap,
  });

  const preOptTtf = (font as any).get();
  const subsetGids: number[] = preOptTtf.subsetGids ?? [];

  const optimized = font.optimize();
  rewriteLayoutTablesForSubset(optimized, subsetGids);

  /** 序列化为 TTF（浏览器端不支持 toBuffer，强制 false） */
  const result = optimized.write({ type: "ttf", kerning: true, toBuffer: false });
  if (typeof result === "string") {
    return textEncoder.encode(result);
  }
  if (result instanceof Uint8Array) {
    return result;
  }
  return new Uint8Array(result);
}

/** 根据文件扩展名推断字体类型 */
export function detectFontType(filename: string): FontType {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "otf") return "otf";
  if (ext === "woff") return "woff";
  if (ext === "woff2") return "woff2";
  return "ttf";
}
