import { Font } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import type { FontEditor } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import { subsetGPOS } from "./gpos-subset.js";
import { subsetGSUB } from "./gsub-subset.js";
import { collectReachableGsubTargets } from "./gsub-reachable.js";

/** 优化291: TextEncoder 模块级单例 */
const textEncoder = new TextEncoder();

/**
 * 字体裁剪的所有可配置步骤
 * 每个步骤独立导出，方便组合使用和单独测试
 */

/** 从字符串提取 Unicode 码点数组 */
export const textToCodePoints = (text: string) => {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) as number;
    result.push(cp);
    if (cp > 0xFFFF) i++; /** 跳过代理对的低半部分 */
  }
  return result;
};

/**
 * 解析字体并执行 subset（最耗时的步骤）
 *
 * kerning: true —— 读取并保留 GPOS/kern 表。
 *   CJK 字体（如思源黑体）的全角标点连续排列时，浏览器依赖 GPOS 的标点压缩规则
 *   调整字间距。子集化若丢弃 GPOS，连续标点渲染会变宽，与原始字体人眼不一致。
 *   fonteditor-core 的 GPOS 为原始字节透传，按子集字形重映射后保留即可恢复压缩。
 */
export const createSubsetFont = (
  fontBuffer: ArrayBuffer,
  codePoints: number[],
  sourceType: FontEditor.FontType,
) =>
  Font.create(fontBuffer, {
    type: sourceType,
    subset: codePoints,
    kerning: true,
  });

/**
 * 优化字体（去冗余表、清理无用字形）
 * subset 模式下 TTFReader.resolveGlyf 已完成 compound2simple，跳过
 * optimizettf 已设置 _unicodeSorted=true，sortGlyf 会直接返回
 */
export const optimizeFont = (font: ReturnType<typeof Font.create>) => {
  const optimized = font.optimize();
  return optimized;
};

/**
 * GPOS/GSUB 表子集化（按子集字形重映射 glyphId）
 *
 * CJK 字体的全角标点压缩依赖 GPOS 的 SinglePos/PairPos lookup；连字/上下文替换
 * （如 FiraCode 的 => → ⇒）依赖 GSUB 的 ligature/context lookup。子集化后 glyphId 重编号，
 * fonteditor-core 的 GPOS/GSUB 是原始字节透传，需按子集字形重映射 coverage/ClassDef 的 gid。
 *
 * 原gid→新gid 映射直接由 subsetGids 顺序建立：subsetGids[i] 是子集保留的第 i 个原始 gid，
 * optimize 后 glyf 顺序与 subsetGids 一致（fonteditor-core 的 optimize 不重排 glyf），
 * 故新 gid = i。这比 unicode 桥接更可靠，且支持无 unicode 的 glyph（如 GSUB 连字 target）。
 * subsetGPOS 遇到完全不支持的版本会返回 null，此时保留原始 GPOS 字节（不劣于子集化前）。
 *
 * @param subsetOptimized optimize 后的 subset 字体（含按新 gid 顺序的 glyf 与原始 GPOS/GSUB 字节）
 * @param subsetGids 子集字形对应的原始 gid 序列（optimize 前后均保留）
 */
const rewriteLayoutTablesForSubset = (
  subsetOptimized: ReturnType<ReturnType<typeof Font.create>["optimize"]>,
  subsetGids: number[],
): void => {
  const ttf = (subsetOptimized as any).get();

  /** subsetGids[i] = 原始 gid，新 gid = i（optimize 不重排 glyf，顺序一一对应） */
  const origToNew = new Map<number, number>();
  for (let i = 0; i < subsetGids.length; i++) origToNew.set(subsetGids[i], i);

  /** GPOS 子集化 */
  const origGPOS = ttf.GPOS;
  if (origGPOS) {
    const gposBytes = origGPOS instanceof Uint8Array ? origGPOS : new Uint8Array(origGPOS);
    if (gposBytes.byteLength > 0) {
      const rewritten = subsetGPOS(gposBytes, origToNew);
      if (rewritten) ttf.GPOS = rewritten;
      /** rewritten === null 表示含不支持的版本，保留原始 GPOS 字节（安全降级） */
    }
  }

  /** GSUB 子集化（总是返回有效字节，重映射 coverage/ClassDef/替换目标 gid） */
  const origGSUB = ttf.GSUB;
  if (origGSUB) {
    const gsubBytes = origGSUB instanceof Uint8Array ? origGSUB : new Uint8Array(origGSUB);
    if (gsubBytes.byteLength > 0) {
      ttf.GSUB = subsetGSUB(gsubBytes, origToNew);
    }
  }
};

/** 序列化为指定格式的二进制数据 */
/** 优化291: 移除 async，消除不必要的微任务调度 */
export const writeFont = (
  font: ReturnType<ReturnType<typeof Font.create>["optimize"]>,
  outType: FontEditor.FontType,
): Uint8Array => {
  /** kerning: true —— 写出时保留 GPOS/kern 表，与 createSubsetFont 的读取保持一致 */
  const result = font.write({ type: outType, kerning: true });
  if (typeof result === "string") {
    return textEncoder.encode(result);
  }
  /** 优化278: Buffer 是 Uint8Array 子类，直接返回避免多余拷贝 */
  if (result instanceof Uint8Array) {
    return result;
  }
  return new Uint8Array(result);
};

/**
 * 完整的字体裁剪流程（当前生产实现）
 * 解析 -> subset -> 优化 -> 序列化
 * 优化293: 移除 async，函数体内无 await，消除不必要的 Promise 包装和微任务调度
 */
export const fontSubset = (
  fontBuffer: ArrayBuffer,
  subString: string,
  option: { sourceType: FontEditor.FontType; outType: FontEditor.FontType },
): Uint8Array => {
  const codePoints = textToCodePoints(subString);

  /** GSUB 连字 target glyph 保留：原始字体含 GSUB 时，先做一次 subset 解析，找出子集 codepoint 经
   *  GSUB 替换链可达的 target glyph（多为无 unicode 的纯连字字形，如 FiraCode 的 greater_equal.liga），
   *  注入 extraSubsetGids 使其被子集保留，否则连字规则 target 失效、连字不渲染。
   *  probe 采用 subset 模式（与正式子集相同的稳定路径），cmap 仅展开子集 codepoint 映射，
   *  GSUB 为原始字节透传。无 GSUB 的字体 reachable 为空，extraSubsetGids 保持 undefined。 */
  let extraSubsetGids: number[] | undefined;
  const probeFont = Font.create(fontBuffer, {
    type: option.sourceType,
    subset: codePoints,
    kerning: true,
  });
  const probeTtf = (probeFont as any).get();
  const origGSUB = probeTtf.GSUB;
  const origCmap = probeTtf.cmap;
  if (origGSUB && origCmap) {
    const gsubBytes = origGSUB instanceof Uint8Array ? origGSUB : new Uint8Array(origGSUB);
    /** seed = 子集 codepoint 经 cmap 映射的原始 gid */
    const seedGids = new Set<number>();
    seedGids.add(0); /** .notdef */
    for (const cp of codePoints) {
      const gid = origCmap[cp];
      if (gid !== undefined) seedGids.add(gid);
    }
    const reachable = collectReachableGsubTargets(gsubBytes, seedGids);
    if (reachable.size > 0) extraSubsetGids = [...reachable];
  }

  const font = Font.create(fontBuffer, {
    type: option.sourceType,
    subset: codePoints,
    kerning: true,
    extraSubsetGids,
  });

  /** subsetGids 在 optimize 前后均保留，记录子集字形的原始 gid 顺序（新 gid = 数组索引）。 */
  const preOptTtf = (font as any).get();
  const subsetGids: number[] = preOptTtf.subsetGids ?? [];

  const optimized = optimizeFont(font);
  /** GPOS/GSUB 表子集化：按子集字形重映射布局表 glyphId，恢复标点压缩与连字/上下文替换 */
  rewriteLayoutTablesForSubset(optimized, subsetGids);
  return writeFont(optimized, option.outType);
};
