import { Font } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import type { FontEditor } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import { subsetGPOS } from "./gpos-subset.js";
import { subsetGSUB, buildGidLookup } from "./gsub-subset.js";
import { collectReachableGsubTargets } from "./gsub-reachable.js";
import { probeGsubAndCmap } from "./gsub-probe.js";
import { subsetOTF } from "./otf-subset.js";
import { encodeTTFToWOFF2 } from "../../vendor/fonteditor-core/woff2/woff2-encode.js";

/** 优化291: TextEncoder 模块级单例 */
const textEncoder = new TextEncoder();

/**
 * FreeType CJK autohinter 的 blue zone 锚定字符集
 * 根因：Linux/Android 下 Skia 用 FreeType 自动 hint 渲染 CJK 字体时，blue zone
 * （横/竖笔量化线）由「字体 cmap 覆盖的全部 CJK 字符轮廓」统计得出。子集化后 cmap
 * 只剩几个字，blue zone 计算偏差 → 字形亚像素偏移 → 与完整字体渲染 SSIM 仅 0.987~0.997。
 * 修复：向子集注入 FreeType autofit blue zone 字符表（afblue.dat
 * AF_BLUE_STRING_CJK_TOP/BOTTOM）中的锚定字符。
 */
/**
 * 实测精简锚定集（32 字 = TOP 段前 26 字 + BOTTOM 段末 6 字「还进進過道還」）。
 * 递减实验（EXP_LIMIT/EXP_OFFSET/EXP_TAIL 分段扫描，敏感用例 full vs subset SSIM）结论：
 * - 78 字全集：SSIM 全 1.0000，但 8 字子集体积 ×8.7（75KB）、全量基准 Σmin 耗时 +153%。
 * - TOP 段前 26 + BOTTOM 尾 6 是最小达标组合：敏感用例 SSIM 全部 ≥0.995（gs 验收线），
 *   8 字 woff2 子集 34.8KB（全集 73.5KB）。
 * - 中段（BOTTOM 前 24 字）与 TOP 尾段对 SSIM 无贡献，删除不影响达标。
 * - 数量本身不是关键，字符选择才是（尾部「進過道還」等是霞鹜文楷纯标点用例达标的必要字符）。
 */
/** 实验开关：thin/empty/decim（验证完移除） */
const BLUE_ZONE_ANCHORS_MINIMAL = [
  0x4ED6, 0x4EEC, 0x4F60, 0x4F86, 0x5011, 0x5230, 0x548C, 0x5730,
  0x5BF9, 0x5C0D, 0x5C31, 0x5E2D, 0x6211, 0x65F6, 0x6642, 0x6703,
  0x6765, 0x70BA, 0x80FD, 0x8230, 0x8AAA, 0x8BF4, 0x8FD9, 0x9019,
  0x9F4A, 0x519B,
  0x8FD8, 0x8FDB, 0x9032, 0x904E, 0x9053, 0x9084,
] as const;

/**
 * 判断码点集合是否需要注入 CJK blue zone 锚定字符
 * 仅当子集包含 CJK 统一表意文字时注入（拉丁/符号子集不受 FreeType CJK hinter 影响）
 */
/** 判断是否含 CJK 码点 */
const hasCJK = (codePoints: number[]) =>
  codePoints.some((cp) => cp >= 0x2e80 && cp <= 0x9fff || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff));

/**
 * 向码点数组注入 blue zone 锚定字符（去重；字体中不存在的码点会被子集管线自然忽略）
 */
const injectBlueZoneAnchors = (codePoints: number[]) => {
  if (!hasCJK(codePoints)) return codePoints;
  const set = new Set(codePoints);
  for (const cp of BLUE_ZONE_ANCHORS_MINIMAL) set.add(cp);
  return [...set];
};

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
    /** SSIM 优化：保留 fpgm/cvt/prep/gasp 表，浏览器 rasterizer 的 grid-fitting
     *  行为与完整字体一致，消除小字号/标点类用例的逐像素差异 */
    hinting: true,
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

  /** GPOS/GSUB 的 origToNew 相同，gidLookup 只构造一次共享传入（省一次 maxOrigGid 扫描+fill+Map 遍历） */
  const gidLookup = buildGidLookup(origToNew);

  /** GPOS 子集化 */
  const origGPOS = ttf.GPOS;
  if (origGPOS) {
    const gposBytes = origGPOS instanceof Uint8Array ? origGPOS : new Uint8Array(origGPOS);
    if (gposBytes.byteLength > 0) {
      const rewritten = subsetGPOS(gposBytes, origToNew, gidLookup);
      if (rewritten) ttf.GPOS = rewritten;
      /** rewritten === null 表示含不支持的版本，保留原始 GPOS 字节（安全降级） */
    }
  }

  /** GSUB 子集化（总是返回有效字节，重映射 coverage/ClassDef/替换目标 gid） */
  const origGSUB = ttf.GSUB;
  if (origGSUB) {
    const gsubBytes = origGSUB instanceof Uint8Array ? origGSUB : new Uint8Array(origGSUB);
    if (gsubBytes.byteLength > 0) {
      ttf.GSUB = subsetGSUB(gsubBytes, origToNew, gidLookup);
    }
  }
};

/** 序列化为指定格式的二进制数据 */
/** 优化291: 移除 async，消除不必要的微任务调度 */
export const writeFont = (
  font: ReturnType<ReturnType<typeof Font.create>["optimize"]>,
  outType: FontEditor.FontType,
): Uint8Array => {
  /** kerning: true —— 写出时保留 GPOS/kern 表，与 createSubsetFont 的读取保持一致
   *  hinting: true —— 写出 fpgm/cvt/prep/gasp，浏览器 grid-fitting 与完整字体一致 */
  const result = font.write({ type: outType, kerning: true, hinting: true });
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
  /** 自适应锚定注入：仅小子集（<32 个唯一码点）需要 blue zone 校准。大子集
   *  自身字符已提供足够的 blue zone 统计样本（千字文段 SSIM 本就 1.0），注入
   *  32 锚定字反而推高体积与浏览器加载耗时。阈值实测：<32 全部敏感用例达标，
   *  ≥32 注入收益消失、纯剩体积代价。 */
  /** 以去重后的唯一码点数为阈值依据（"天天天天" 重复 8 字符仍是 2 字小子集） */
  const uniqueCodePoints = [...new Set(textToCodePoints(subString))];
  const codePoints = uniqueCodePoints.length < 32
    ? injectBlueZoneAnchors(uniqueCodePoints)
    : uniqueCodePoints;

  /** OTF（CFF）输入走独立 OTF 子集化：fonteditor-core 对含 idRangeOffset 的 CID cmap 解析有 bug，
   *  会产出 gid 错乱的子集（SSIM 0.93~0.97）。subsetOTF 直接重建 CFF/cmap/hmtx，透传 charstring，
   *  浏览器渲染与原始 OTF 像素级一致（SSIM ≈1.0）。outType=woff2 用 woff2 编码包裹 OTF 字节
   *  （WOFF2 编码器对无 glyf/loca 的 CFF 表按普通表 brotli 压缩，合法）。outType=otf/ttf 均返回裸 OTF。
   *  GSUB/GPOS（思源有）按子集 gid 重映射，保留标点压缩与连字。 */
  if (option.sourceType === "otf") {
    const fontU8 = new Uint8Array(fontBuffer);
    const otfBytes = subsetOTF(fontU8, codePoints, true, option.outType);
    if (otfBytes !== null) {
      if (option.outType === "woff2") {
        return encodeTTFToWOFF2(otfBytes);
      }
      return otfBytes;
    }
    /** subsetOTF 不支持（非 CID CFF 等）降级到原 fonteditor 路径 */
  }

  /** GSUB 连字 target glyph 保留：原始字体含 GSUB 时，先做一次 probe，找出子集 codepoint 经
   *  GSUB 替换链可达的 target glyph（多为无 unicode 的纯连字字形，如 FiraCode 的 greater_equal.liga），
   *  注入 extraSubsetGids 使其被子集保留，否则连字规则 target 失效、连字不渲染。
   *
   *  优化（轻量 probe）：直接从字体字节解析表目录提取 GSUB 字节 + cmap 的 codepoint→gid 查找，
   *  跳过 Font.create 的 glyf 轮廓解析（probe 只需 GSUB/cmap，不需要轮廓）。CJK 字体两次 Font.create
   *  原占总耗时 36%~63%，省掉 probe 那次显著加速。无 GSUB 的 ttf / 所有 otf（fonteditor probe 本就
   *  origGSUB=undefined）直接判无 reachable，连 probe Font.create 也跳过。仅当字体有 GSUB 但 cmap 无
   *  format4/12 subtable（极罕见）时回退到 Font.create probe。 */
  let extraSubsetGids: number[] | undefined;
  const probe = probeGsubAndCmap(fontBuffer, codePoints, option.sourceType);
  let probedSeedGids: Set<number> | undefined;
  let probedGsubBytes: Uint8Array | undefined;
  /** probe.lookup（codepoint→gid，仅 format4/12 查到）与 Font.create 内 readWindowsAllCodes 的 subset
   *  路径产出等价（subset 模式 format0/14 不解析）。转为普通对象注入 readOptions.presetCmap，供
   *  readWindowsAllCodes 直接复用，消除 subset 字符的 format4/12 二分查找重复计算。仅 probe.ok 时可用。 */
  let presetCmap: Record<number, number> | undefined;
  if (probe.ok) {
    probedGsubBytes = probe.gsubBytes;
    probedSeedGids = new Set<number>();
    probedSeedGids.add(0); /** .notdef */
    presetCmap = {};
    for (const cp of codePoints) {
      const gid = probe.lookup.get(cp);
      if (gid !== undefined) {
        probedSeedGids.add(gid);
        presetCmap[cp] = gid;
      }
    }
  } else if (probe.needsFallback) {
    /** 有 GSUB 但 cmap 无 format4/12，回退 Font.create probe（与原路径一致） */
    const probeFont = Font.create(fontBuffer, {
      type: option.sourceType,
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
    type: option.sourceType,
    subset: codePoints,
    kerning: true,
    extraSubsetGids,
    /** SSIM 优化：保留 hinting（fpgm/cvt/prep/gasp），与完整字体渲染一致 */
    hinting: true,
    /** presetCmap 复用 probe 结果，跳过 readWindowsAllCodes 的 format4/12 二分查找（优化315） */
    presetCmap,
  });

  /** subsetGids 在 optimize 前后均保留，记录子集字形的原始 gid 顺序（新 gid = 数组索引）。 */
  const preOptTtf = (font as any).get();
  const subsetGids: number[] = preOptTtf.subsetGids ?? [];

  const optimized = optimizeFont(font);
  /** GPOS/GSUB 表子集化：按子集字形重映射布局表 glyphId，恢复标点压缩与连字/上下文替换 */
  rewriteLayoutTablesForSubset(optimized, subsetGids);
  return writeFont(optimized, option.outType);
};
