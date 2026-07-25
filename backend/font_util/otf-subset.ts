/**
 * OTF (OpenType with CFF) 字体子集化器。
 *
 * 背景：fonteditor-core 对 OTF 输入走 otf2ttfobject（CFF 三次 → glyf 二次），其 cmap 解析对
 * 含 idRangeOffset 的 format4 子表有 bug（_lazySegs 模式 graphIdArrayIndexOffset 计算错误），
 * 导致 CID-keyed OTF（白狐教育汉字、思源黑体 OTF）子集化后 cmap 查不到目标字符、gid 错乱，
 * 浏览器渲染与原始字体存在显著差异（SSIM 0.93~0.97）。
 *
 * 本模块完全独立实现 OTF 子集化，不依赖 fonteditor 对 otf 的 Font.create：
 *   1. 解析原始 sfnt 表目录
 *   2. 用原始 cmap（format4 绝对地址版 + format12）查 codepoint → 原始 gid（修正 fonteditor 的 bug）
 *   3. subsetCFF 重建 CFF 表（透传 charstring）
 *   4. 重建 cmap（子集 codepoint → 新 gid，format4）
 *   5. 重建 hmtx/vmtx（按新 gid 顺序取原始 metrics）
 *   6. 重建 maxp（numGlyphs = 子集数）、post（format3 无 glyph 名）、name（保留渲染必需 nameId）
 *   7. head/hhea/vhea/OS/2/VORG 透传（无 gid 依赖，或仅 patch numGlyphs 相关）
 *   8. GSUB/GPOS 子集化（若存在，复用 gsub-subset/gpos-subset）
 *   9. 封装 OTF sfnt（OTTO 签名 + checkSumAdjustment）
 *
 * @reference https://learn.microsoft.com/en-us/typography/opentype/spec/
 */

import { subsetCFF } from "./cff-subset.js";
import { subsetGSUB } from "./gsub-subset.js";
import { subsetGPOS } from "./gpos-subset.js";
import { collectReachableGsubTargets } from "./gsub-reachable.js";

/** sfnt 表目录条目 */
interface SfntTable {
  /** 4 字节 tag 字符串 */
  tag: string;
  /** 原始字节偏移 */
  offset: number;
  /** 原始字节长度 */
  length: number;
}

/** 解析 sfnt 表目录 */
function readSfntTables(dv: DataView): SfntTable[] {
  const numTables = dv.getUint16(4, false);
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    tables.push({ tag, offset: dv.getUint32(off + 8, false), length: dv.getUint32(off + 12, false) });
  }
  return tables;
}

/** 按 tag 查表，返回字节切片偏移/长度 */
function findTable(tables: SfntTable[], tag: string): SfntTable | undefined {
  for (const t of tables) if (t.tag === tag) return t;
  return undefined;
}

/** format4 cmap 二分查找（绝对地址版，修正 idRangeOffset 计算）。
 *  返回原始 gid（0 表示缺失/映射到 .notdef） */
function lookupFormat4(dv: DataView, fmt4Off: number, unicode: number): number {
  const segCountX2 = dv.getUint16(fmt4Off + 6, false);
  const segCount = segCountX2 >>> 1;
  const endCodeBase = fmt4Off + 14;
  const startCodeBase = endCodeBase + segCount * 2 + 2;
  const idDeltaBase = startCodeBase + segCount * 2;
  const idRangeOffsetBase = idDeltaBase + segCount * 2;
  let lo = 0;
  let hi = segCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = dv.getUint16(startCodeBase + mid * 2, false);
    const end = dv.getUint16(endCodeBase + mid * 2, false);
    if (unicode < start) {
      hi = mid - 1;
    } else if (unicode > end) {
      lo = mid + 1;
    } else {
      const idDelta = dv.getInt16(idDeltaBase + mid * 2, false);
      const idRangeOffset = dv.getUint16(idRangeOffsetBase + mid * 2, false);
      if (idRangeOffset === 0) return ((unicode + idDelta) & 0xffff) & 0xffff;
      /** idRangeOffset 是相对「idRangeOffset 字段自身地址」的字节偏移（OpenType 规范） */
      const idRangeOffsetAddr = idRangeOffsetBase + mid * 2;
      const gidAddr = idRangeOffsetAddr + idRangeOffset + (unicode - start) * 2;
      const gid = dv.getUint16(gidAddr, false);
      if (gid === 0) return 0;
      return (gid + idDelta) & 0xffff;
    }
  }
  return 0;
}

/** format12 cmap 查找（补充平面 + BMP） */
function lookupFormat12(dv: DataView, fmt12Off: number, unicode: number): number {
  const numGroups = dv.getUint32(fmt12Off + 12, false);
  /** groups 起始 = fmt12Off + 16，每组 12 字节：startCharCode(4) endCharCode(4) startGlyphID(4) */
  let lo = 0;
  let hi = numGroups - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const gOff = fmt12Off + 16 + mid * 12;
    const start = dv.getUint32(gOff, false);
    const end = dv.getUint32(gOff + 4, false);
    if (unicode < start) {
      hi = mid - 1;
    } else if (unicode > end) {
      lo = mid + 1;
    } else {
      const startGlyphID = dv.getUint32(gOff + 8, false);
      return startGlyphID + (unicode - start);
    }
  }
  return 0;
}

/** 选 cmap 子表：format12（p3e10）优先，format4（p3e1）次之。返回各自相对 cmap 起始的偏移（-1 无） */
function selectCmapSubtables(dv: DataView, cmapOff: number): { fmt4Off: number; fmt12Off: number } {
  const numSub = dv.getUint16(cmapOff + 2, false);
  let fmt4Off = -1;
  let fmt12Off = -1;
  for (let i = 0; i < numSub; i++) {
    const r = cmapOff + 4 + i * 8;
    const pid = dv.getUint16(r, false);
    const eid = dv.getUint16(r + 2, false);
    const suboff = cmapOff + dv.getUint32(r + 4, false);
    const fmt = dv.getUint16(suboff, false);
    if (pid === 3 && eid === 10 && fmt === 12 && fmt12Off < 0) fmt12Off = suboff;
    else if (pid === 3 && eid === 1 && fmt === 4 && fmt4Off < 0) fmt4Off = suboff;
    else if (pid === 0 && fmt === 12 && fmt12Off < 0) fmt12Off = suboff;
    else if (pid === 0 && fmt === 4 && fmt4Off < 0) fmt4Off = suboff;
  }
  return { fmt4Off, fmt12Off };
}

/**
 * 从原始 OTF 查子集 codepoint 的原始 gid，构建子集字形集（含 .notdef）。
 * 查找顺序与 readWindowsAllCodes 一致：BMP 先 format4，未命中查 format12；补充平面查 format12。
 * 返回 newSubsetGids（[0, ...去重保留的原始 gid]）与 codepoint→新gid 映射。
 */
function buildSubsetGids(
  dv: DataView,
  cmapOff: number,
  codePoints: number[],
): { subsetGids: number[]; cpToNewGid: Map<number, number> } {
  const { fmt4Off, fmt12Off } = selectCmapSubtables(dv, cmapOff);
  /** origGid 集合（保持插入顺序，新 gid = 数组 index） */
  const subsetGids: number[] = [0];
  /** gid → 新 gid（subsetGids 索引），替代 subsetGids.indexOf(gid) 的 O(n) 线性查找。
   *  原 indexOf 对每个 codepoint 遍历 subsetGids，O(N×M)；全字符集场景退化为 O(N²)。 */
  const gidToNewGid = new Map<number, number>([[0, 0]]);
  const cpToNewGid = new Map<number, number>();
  for (const cp of codePoints) {
    if (cpToNewGid.has(cp)) continue;
    let gid = 0;
    if (cp < 0x10000 && fmt4Off >= 0) gid = lookupFormat4(dv, fmt4Off, cp);
    if (gid === 0 && fmt12Off >= 0) gid = lookupFormat12(dv, fmt12Off, cp);
    if (gid === 0) continue; /** 字体无此字 */
    let newGid = gidToNewGid.get(gid);
    if (newGid === undefined) {
      newGid = subsetGids.length;
      subsetGids.push(gid);
      gidToNewGid.set(gid, newGid);
    }
    cpToNewGid.set(cp, newGid);
  }
  return { subsetGids, cpToNewGid };
}

/** 重建 cmap 表（format4）：子集 codepoint → 新 gid。
 *  仅含 BMP 字符（format4 上限），补充平面字符需 format12。当前生产用例 otf 字符均为 BMP，
 *  补充平面若出现降级为不含该字（cpToNewGid 不含）。 */
function buildSubsetCmap(cpToNewGid: Map<number, number>): Uint8Array {
  /** 收集 BMP 映射，按 codepoint 排序 */
  const entries: { cp: number; gid: number }[] = [];
  for (const [cp, gid] of cpToNewGid) {
    if (cp < 0x10000 && cp > 0) entries.push({ cp, gid });
  }
  entries.sort((a, b) => a.cp - b.cp);
  /** 构建 format4 segment：连续 codepoint 且 gid 同步递增（delta 模式）合并为一段。
   *  delta = (gid - cp)，同一 delta 的连续 cp 可合并。 */
  interface Seg { start: number; end: number; delta: number; }
  const segs: Seg[] = [];
  for (const e of entries) {
    const last = segs[segs.length - 1];
    /** 与上一段连续（cp 递增 1 且保持同一 delta）则扩展 */
    if (last && e.cp === last.end + 1 && (e.gid - e.cp) === ((last.delta << 16) >> 16)) {
      last.end = e.cp;
    } else {
      segs.push({ start: e.cp, end: e.cp, delta: (e.gid - e.cp) & 0xffff });
    }
  }
  /** 末尾哨兵段 0xFFFF→gid 0（delta=1 使 0xFFFF+1=0 mod 0x10000） */
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segs.length;
  const segCountX2 = segCount * 2;
  const searchRange = (1 << (31 - Math.clz32(segCount))) * 2;
  const entrySelector = 31 - Math.clz32(segCount);
  const rangeShift = segCountX2 - searchRange;

  /** format4 表布局：format(2) length(2) language(2) segCountX2(2) searchRange(2) entrySelector(2) rangeShift(2)
   *  + endCode[segCount] + reservedPad(2) + startCode[segCount] + idDelta[segCount] + idRangeOffset[segCount] */
  const bodySize = 14 + segCount * 8 + 2;
  /** cmap header: version(2) + numSubtables(2) + 子表记录(8) + format4 body */
  const headerSize = 4 + 8;
  const fmt4Length = bodySize;

  const out = new Uint8Array(headerSize + fmt4Length);
  const dv = new DataView(out.buffer);
  /** cmap header */
  dv.setUint16(0, 0, false); /** version */
  dv.setUint16(2, 1, false); /** numSubtables */
  /** 子表记录：pid=3 eid=1 offset=12（相对 cmap 起始） */
  dv.setUint16(4, 3, false);
  dv.setUint16(6, 1, false);
  dv.setUint32(8, 12, false);
  /** format4 body at offset 12 */
  const b = 12;
  dv.setUint16(b, 4, false); /** format */
  dv.setUint16(b + 2, fmt4Length, false); /** length */
  dv.setUint16(b + 4, 0, false); /** language */
  dv.setUint16(b + 6, segCountX2, false);
  dv.setUint16(b + 8, searchRange, false);
  dv.setUint16(b + 10, entrySelector, false);
  dv.setUint16(b + 12, rangeShift, false);
  const endCodeBase = b + 14;
  for (let i = 0; i < segCount; i++) dv.setUint16(endCodeBase + i * 2, segs[i].end, false);
  dv.setUint16(endCodeBase + segCount * 2, 0, false); /** reservedPad */
  const startCodeBase = endCodeBase + segCount * 2 + 2;
  for (let i = 0; i < segCount; i++) dv.setUint16(startCodeBase + i * 2, segs[i].start, false);
  const idDeltaBase = startCodeBase + segCount * 2;
  for (let i = 0; i < segCount; i++) dv.setInt16(idDeltaBase + i * 2, (segs[i].delta << 16) >> 16, false);
  const idRangeOffsetBase = idDeltaBase + segCount * 2;
  for (let i = 0; i < segCount; i++) dv.setUint16(idRangeOffsetBase + i * 2, 0, false);
  return out;
}

/** 重建 hmtx/vmtx：按新 gid 顺序取原始 metrics（advanceWidth + lsb/topSideBearing）。
 *  numberOfHMetrics 设为子集数（所有字形给完整记录）。 */
function buildSubsetMetrics(
  srcDv: DataView,
  metricsOff: number,
  numberOfHMetrics: number,
  subsetGids: number[],
): Uint8Array {
  /** 原始记录：前 numberOfHMetrics 个完整（advance+lsb），其余仅 lsb（advance 复用最后一个） */
  const lastAdv = numberOfHMetrics > 0 ? srcDv.getUint16(metricsOff + (numberOfHMetrics - 1) * 4, false) : 0;
  const out = new Uint8Array(subsetGids.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < subsetGids.length; i++) {
    const gid = subsetGids[i];
    let adv: number;
    let sb: number;
    if (gid < numberOfHMetrics) {
      adv = srcDv.getUint16(metricsOff + gid * 4, false);
      sb = srcDv.getInt16(metricsOff + gid * 4 + 2, false);
    } else {
      adv = lastAdv;
      /** lsb 数组起始 = metricsOff + numberOfHMetrics*4，每项 2 字节 */
      const lsbArrOff = metricsOff + numberOfHMetrics * 4;
      sb = srcDv.getInt16(lsbArrOff + (gid - numberOfHMetrics) * 2, false);
    }
    dv.setUint16(i * 4, adv, false);
    dv.setInt16(i * 4 + 2, sb, false);
  }
  return out;
}

/** 重建 maxp（OTF 版本 0.5：version(4) + numGlyphs(2)） */
function buildSubsetMaxp(subsetCount: number): Uint8Array {
  const out = new Uint8Array(6);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00005000, false); /** version 0.5 */
  dv.setUint16(4, subsetCount, false);
  return out;
}

/** 重建 post（format3：无 glyph 名，最省）。version=3.0 */
function buildSubsetPost(): Uint8Array {
  /** post format3 = version(4)=0x00030000 + italicAngle(4) + underlinePosition(2) + underlineThickness(2)
   *  + isFixedPitch(4) + minMemType42(4) + maxMemType42(4) + minMemType1(4) + maxMemType1(4) = 32 字节 */
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00030000, false);
  return out;
}

/** OS/2 表：透传原始字节，patch usFirstCharIndex/usLastCharIndex 为子集 codepoint 的 min/max。
 *  CID 字体原始 OS/2 这两字段常为占位值（65535/0），OTS 严格校验 usFirst<=usLast 会拒绝，
 *  必须按子集 cmap 的实际 codepoint 范围回填。仅 BMP codepoint 计入（字段是 uint16）。 */
function buildSubsetOS2(srcDv: DataView, off: number, len: number, codePoints: number[]): Uint8Array {
  const out = new Uint8Array(srcDv.buffer, srcDv.byteOffset + off, len).slice();
  const dv = new DataView(out.buffer);
  let minCp = 0xffff;
  let maxCp = 0;
  for (const cp of codePoints) {
    if (cp > 0 && cp < 0x10000) {
      if (cp < minCp) minCp = cp;
      if (cp > maxCp) maxCp = cp;
    }
  }
  if (minCp > maxCp) { minCp = 0; maxCp = 0xffff; }
  dv.setUint16(64, minCp, false);
  dv.setUint16(66, maxCp, false);
  return out;
}

/** name 表：保留渲染必需 nameId（1/2/4/6/16/17），从原表拷贝对应记录。
 *  若原表无这些 nameId，写一个最小合法 name 表。 */
function buildSubsetName(srcDv: DataView, nameOff: number): Uint8Array {
  const count = srcDv.getUint16(nameOff + 2, false);
  const stringOff = nameOff + srcDv.getUint16(nameOff + 4, false);
  /** 保留的 nameId 白名单（与 ttf 子集化 [[name-subset-whitelist]] 一致） */
  const KEEP = new Set([1, 2, 4, 6, 16, 17]);
  /** 收集保留记录（优先 p3e1，回退任意） */
  const records: { platformID: number; encodingID: number; languageID: number; nameID: number; bytes: Uint8Array }[] = [];
  const seenNameId = new Set<number>();
  /** 先扫 p3e1（Windows UTF-16），再补其他 platform */
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const platformID = srcDv.getUint16(r, false);
      const encodingID = srcDv.getUint16(r + 2, false);
      const languageID = srcDv.getUint16(r + 4, false);
      const nameID = srcDv.getUint16(r + 6, false);
      if (!KEEP.has(nameID)) continue;
      const isWin = platformID === 3 && encodingID === 1;
      if (pass === 0 && !isWin) continue;
      if (pass === 1 && seenNameId.has(nameID)) continue;
      if (pass === 0 && seenNameId.has(nameID)) continue;
      const length = srcDv.getUint16(r + 8, false);
      const offset = srcDv.getUint16(r + 10, false);
      records.push({ platformID, encodingID, languageID, nameID, bytes: new Uint8Array(srcDv.buffer, srcDv.byteOffset + stringOff + offset, length) });
      seenNameId.add(nameID);
    }
  }
  /** 重建 name 表 */
  const headerSize = 6 + records.length * 12;
  let stringSize = 0;
  for (const rec of records) stringSize += rec.bytes.length;
  const out = new Uint8Array(headerSize + stringSize);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, false); /** format */
  dv.setUint16(2, records.length, false);
  dv.setUint16(4, headerSize, false); /** stringOffset */
  let strAcc = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const r = 6 + i * 12;
    dv.setUint16(r, rec.platformID, false);
    dv.setUint16(r + 2, rec.encodingID, false);
    dv.setUint16(r + 4, rec.languageID, false);
    dv.setUint16(r + 6, rec.nameID, false);
    dv.setUint16(r + 8, rec.bytes.length, false);
    dv.setUint16(r + 10, strAcc, false);
    out.set(rec.bytes, headerSize + strAcc);
    strAcc += rec.bytes.length;
  }
  return out;
}

/** head 表：patch numGlyphs 相关字段不需要（head 无 numGlyphs），但需清 checkSumAdjustment（封装时统一算）。
 *  透传原始 head 字节即可，checkSumAdjustment 在 sfnt 封装时回填。 */
function passthroughHead(srcDv: DataView, off: number, len: number): Uint8Array {
  const out = new Uint8Array(srcDv.buffer, srcDv.byteOffset + off, len).slice();
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 0, false); /** checkSumAdjustment = 0，封装时回填 */
  return out;
}

/** 计算表 4 字节对齐后的 checksum（OpenType 规范：表长度按 4 字节边界补齐算 sum）。
 *  DataView.getUint32 批量读大端 uint32（V8 对 DataView 有专门内联，[[dataview-getuint32-fastest]]
 *  验证其快于 Uint32Array+swap 与逐字节位拼装），尾部 1~3 字节补 0 单独处理。 */
function calcTableChecksum(bytes: Uint8Array): number {
  const n = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n);
  const fullQuads = n >>> 2;
  let sum = 0;
  for (let i = 0; i < fullQuads; i++) sum = (sum + dv.getUint32(i * 4, false)) >>> 0;
  /** 尾部 1~3 字节（n 非 4 倍数时），按规范右侧补 0 到 4 字节参与累加 */
  const tail = n & 3;
  if (tail) {
    const base = fullQuads * 4;
    let last = 0;
    for (let j = 0; j < tail; j++) last = (last << 8) | bytes[base + j];
    last = (last << ((4 - tail) * 8)) >>> 0;
    sum = (sum + last) >>> 0;
  }
  return sum >>> 0;
}

/**
 * 封装 OTF sfnt（OTTO 签名）：表目录 + 各表数据（4 字节对齐）+ head.checkSumAdjustment 回填。
 * @param tables 有序 (tag → bytes) 列表（按 tag 升序排，便于浏览器二分）
 */
function assembleSfnt(tables: { tag: string; bytes: Uint8Array }[]): Uint8Array {
  /** 按 tag 升序（sfnt 规范要求，浏览器按 tag 二分查找表） */
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = tables.length;
  const entrySelector = numTables > 0 ? 31 - Math.clz32(numTables) : 0;
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;

  /** 目录区 = 12（sfnt 头）+ numTables*16（表记录） */
  const dirSize = 12 + numTables * 16;
  /** 各表 4 字节对齐后的总数据长度 */
  const paddedLens = tables.map((t) => (t.bytes.length + 3) & ~3);
  let dataTotal = 0;
  for (const pl of paddedLens) dataTotal += pl;

  const out = new Uint8Array(dirSize + dataTotal);
  const dv = new DataView(out.buffer);

  /** sfnt 头：OTTO 签名 */
  out[0] = 0x4f; out[1] = 0x54; out[2] = 0x54; out[3] = 0x4f;
  dv.setUint16(4, numTables, false);
  dv.setUint16(6, searchRange, false);
  dv.setUint16(8, entrySelector, false);
  dv.setUint16(10, rangeShift, false);

  /** 表记录 + 数据；各表 checksum 同时累加进 wholeSum（数据段 sum 等于表 checksum） */
  let dataOff = dirSize;
  const headIdx = tables.findIndex((t) => t.tag === "head");
  /** wholeSum = Σ 各表数据段 checksum。head.checkSumAdjustment 此刻为 0（passthroughHead 已清零），目录区稍后补算 */
  let tablesDataSum = 0;
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    out[r] = tables[i].tag.charCodeAt(0);
    out[r + 1] = tables[i].tag.charCodeAt(1);
    out[r + 2] = tables[i].tag.charCodeAt(2);
    out[r + 3] = tables[i].tag.charCodeAt(3);
    const checksum = calcTableChecksum(tables[i].bytes);
    tablesDataSum = (tablesDataSum + checksum) >>> 0;
    dv.setUint32(r + 4, checksum, false);
    dv.setUint32(r + 8, dataOff, false);
    dv.setUint32(r + 12, tables[i].bytes.length, false);
    out.set(tables[i].bytes, dataOff);
    dataOff += paddedLens[i];
  }

  /** head.checkSumAdjustment = 0xB1B0AFBA - 全文件 sum。
   *  全文件 sum = 目录区 sum + Σ 各表数据段 checksum。
   *  数据段 sum 已在写表时累加（=各表 checksum），目录区仅 dirSize 字节（sfnt 头+表记录），单独遍历即可，
   *  避免对数百 KB 的 CFF 等大表做第二次整段遍历。 */
  if (headIdx >= 0) {
    const headRecOff = 12 + headIdx * 16;
    const headDataOff = dv.getUint32(headRecOff + 8, false);
    let dirSum = 0;
    for (let i = 0; i < dirSize; i += 4) {
      dirSum = (dirSum + ((out[i] << 24) | (out[i + 1] << 16) | (out[i + 2] << 8) | out[i + 3])) >>> 0;
    }
    const wholeSum = (dirSum + tablesDataSum) >>> 0;
    const adjustment = (0xb1b0afba - wholeSum) >>> 0;
    dv.setUint32(headDataOff + 8, adjustment, false);
  }
  return out;
}

/**
 * OTF 子集化主入口。
 * @param fontBuffer 原始 OTF 字节
 * @param codePoints 子集字符码点
 * @param keepGSUB 是否子集化 GSUB/GPOS（连字/标点压缩需要）
 * @returns 子集 OTF 字节；非 CFF 字体或不支持返回 null
 */
export function subsetOTF(fontBuffer: Uint8Array, codePoints: number[], keepGSUB: boolean): Uint8Array | null {
  const dv = new DataView(fontBuffer.buffer, fontBuffer.byteOffset, fontBuffer.byteLength);
  const tables = readSfntTables(dv);

  const cff = findTable(tables, "CFF ");
  const cmap = findTable(tables, "cmap");
  const hmtx = findTable(tables, "hmtx");
  const hhea = findTable(tables, "hhea");
  const head = findTable(tables, "head");
  const maxp = findTable(tables, "maxp");
  if (!cff || !cmap || !hmtx || !hhea || !head || !maxp) return null;

  /** 子集字形集 + codepoint→新gid */
  const { subsetGids, cpToNewGid } = buildSubsetGids(dv, cmap.offset, codePoints);

  /** keepGSUB 时提前解析 GSUB/GPOS 表（供 reachable 收集与后续布局表子集化共用，
   *  避免两次 findTable 线性扫描 + 两次字节切片）。 */
  const gsub = keepGSUB ? findTable(tables, "GSUB") : undefined;
  const gpos = keepGSUB ? findTable(tables, "GPOS") : undefined;

  /** GSUB 替换链 target 字形保留（locl/calt/liga 等）。
   *  思源黑体等 CID 字体含 locl feature：浏览器按系统 locale（中文）渲染时，GSUB 把基础字形
   *  替换为地区变体字形（如"天"gid A → CN 变体 gid A+1）。若子集 subsetGids 不含这些 target，
   *  子集 GSUB 重映射后 target gid 指向不存在/错误字形，渲染出错误变体（实测思源 9 字 ink 差 75，
   *  SSIM 0.9530，逐字定位"天玄宇法海"多 ink、"宙"少 ink，正是 locl 变体丢失）。
   *  复用 ttf 路径同款 collectReachableGsubTargets 收集 seed 经 GSUB 可达的 target gid，合并进 subsetGids。
   *  仅字体含 GSUB 时收集；无 GSUB（纯汉字无连字/变体）跳过，零开销。 */
  if (gsub) {
    const gsubBytes = new Uint8Array(dv.buffer, dv.byteOffset + gsub.offset, gsub.length);
    /** seed = 当前 subsetGids（已含 .notdef + 各 codepoint 的 gid） */
    const seed = new Set<number>(subsetGids);
    const reachable = collectReachableGsubTargets(gsubBytes, seed);
    if (reachable.size > 0) {
      /** 合并去重：新 gid 顺序追加在现有 subsetGids 之后（不破坏 cpToNewGid 已建立的映射） */
      for (const gid of reachable) {
        if (gid > 0 && !seed.has(gid)) {
          seed.add(gid);
          subsetGids.push(gid);
        }
      }
    }
  }

  /** 子集 CFF */
  const cffBytes = new Uint8Array(fontBuffer.buffer, fontBuffer.byteOffset + cff.offset, cff.length);
  const newCFF = subsetCFF(cffBytes, subsetGids);
  if (!newCFF) return null;

  /** 子集 cmap */
  const newCmap = buildSubsetCmap(cpToNewGid);

  /** numberOfHMetrics（hhea +34）*/
  const numberOfHMetrics = dv.getUint16(hhea.offset + 34, false);

  /** 子集 hmtx */
  const newHmtx = buildSubsetMetrics(dv, hmtx.offset, numberOfHMetrics, subsetGids);

  /** 组装各表 */
  const outTables: { tag: string; bytes: Uint8Array }[] = [];
  outTables.push({ tag: "CFF ", bytes: newCFF });
  outTables.push({ tag: "cmap", bytes: newCmap });
  outTables.push({ tag: "hmtx", bytes: newHmtx });
  outTables.push({ tag: "maxp", bytes: buildSubsetMaxp(subsetGids.length) });
  outTables.push({ tag: "post", bytes: buildSubsetPost() });

  /** head 透传（patch checkSumAdjustment 占位） */
  outTables.push({ tag: "head", bytes: passthroughHead(dv, head.offset, head.length) });
  /** hhea 透传 + patch numberOfHMetrics = subsetGids.length */
  {
    const hheaBytes = new Uint8Array(dv.buffer, dv.byteOffset + hhea.offset, hhea.length).slice();
    const hheaDv = new DataView(hheaBytes.buffer);
    hheaDv.setUint16(34, subsetGids.length, false);
    outTables.push({ tag: "hhea", bytes: hheaBytes });
  }
  /** OS/2 透传 + patch usFirstCharIndex/usLastCharIndex */
  const os2 = findTable(tables, "OS/2");
  if (os2) outTables.push({ tag: "OS/2", bytes: buildSubsetOS2(dv, os2.offset, os2.length, codePoints) });
  /** name 子集 */
  const name = findTable(tables, "name");
  if (name) outTables.push({ tag: "name", bytes: buildSubsetName(dv, name.offset) });

  /** vhea/vmtx 透传 + 重建（垂直排版 metrics，CJK 需要） */
  const vhea = findTable(tables, "vhea");
  const vmtx = findTable(tables, "vmtx");
  if (vhea && vmtx) {
    const numOfLongVerMetrics = dv.getUint16(vhea.offset + 34, false);
    const newVmtx = buildSubsetMetrics(dv, vmtx.offset, numOfLongVerMetrics, subsetGids);
    outTables.push({ tag: "vmtx", bytes: newVmtx });
    const vheaBytes = new Uint8Array(dv.buffer, dv.byteOffset + vhea.offset, vhea.length).slice();
    const vheaDv = new DataView(vheaBytes.buffer);
    vheaDv.setUint16(34, subsetGids.length, false);
    outTables.push({ tag: "vhea", bytes: vheaBytes });
  }

  /** GSUB/GPOS 子集化（若 keepGSUB 且存在）：复用 ttf 路径同款 gsub-subset/gpos-subset，
   *  按 subsetGids 建立原gid→新gid 映射重写布局表 glyphId。OTF 与 TTF 的 GSUB/GPOS 表结构完全相同
   *  （都是 OpenType 布局表，差异仅在 glyf vs CFF），故字节级子集化器可直接复用。
   *  不能直接透传原始字节：子集化后 gid 已重排，原始 coverage 引用的旧 gid 会指向错误字形，
   *  致 shaping 引擎把字符替换成 .notdef/错字（实测思源 otf 透传 GSUB 致 SSIM 0.623，洪/法等字变空白）。
   *  keepGSUB=false 时丢弃，纯汉字无标点/连字的场景安全。 */
  if (keepGSUB) {
    /** origToNew：subsetGids[新gid] = 原gid，反转得 原gid→新gid */
    const origToNew = new Map<number, number>();
    for (let newGid = 0; newGid < subsetGids.length; newGid++) origToNew.set(subsetGids[newGid], newGid);
    if (gsub) {
      const gsubBytes = new Uint8Array(dv.buffer, dv.byteOffset + gsub.offset, gsub.length);
      outTables.push({ tag: "GSUB", bytes: subsetGSUB(gsubBytes, origToNew) });
    }
    if (gpos) {
      const gposBytes = new Uint8Array(dv.buffer, dv.byteOffset + gpos.offset, gpos.length);
      /** subsetGPOS 可能对不支持的版本返回 null，此时丢弃该表（无 GPOS 仅丢失 kerning） */
      const newGpos = subsetGPOS(gposBytes, origToNew);
      if (newGpos) outTables.push({ tag: "GPOS", bytes: newGpos });
    }
  }

  return assembleSfnt(outTables);
}
