/**
 * OpenType 表二进制读写器（大端序）
 *
 * GPOS / GSUB 等 OpenType 表全部使用大端序（big-endian）—— 这是 OpenType 1.9 规范
 * 对 TTF/OTF/woff/woff2 中表内容字节的硬性规定（表内所有整数均为大端）。
 * fonteditor-core 的 reader/writer（vendor/fonteditor-core/lib/ttf/reader.js）虽用参数化
 * 的 littleEndian，但 TTFReader.readBuffer 实例化 Reader 时第 4 参数恒传 false（大端），
 * 佐证 TTF 流一律大端；本模块对表内容直接硬编码大端，与之一致。
 *
 * 这些表的子集化逻辑（按子集字形重映射 coverage/ClassDef/替换目标 gid）需要逐字节
 * 重新序列化，两份子集化器（gpos-subset.ts、gsub-subset.ts）原本各自维护了一份几乎
 * 相同的 Writer/Reader 实现，本模块将其抽为单一来源。
 *
 * Writer 支持「向前引用」：subtable 主体先写、coverage 等偏移量后填，
 * 通过 reserveOffset16 预留槽位、flush 时统一回填。
 */

/**
 * 大端序字节写入器
 *
 * 支持预留 Offset16 槽位并延迟回填，以支持「向前引用」
 * （subtable 主体先写，coverage/PairSet 偏移量后填）。
 */
export class OTWriter {
  private bytes: number[] = [];
  private patches: Array<{ pos: number; base: number; targetGetter: () => number }> = [];

  get length(): number {
    return this.bytes.length;
  }

  /** 回退到指定字节位置，丢弃之后写入的字节与对应的偏移量槽（用于 subtable 重映射失败的保守降级） */
  rollback(pos: number): void {
    this.bytes.length = pos;
    this.patches = this.patches.filter((p) => p.pos < pos);
  }

  writeUint8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  writeUint16(v: number): void {
    this.bytes.push((v >>> 8) & 0xff, v & 0xff);
  }

  /** 在当前末尾写入 int16（大端，支持负数；如 SingleSubst format1 的 deltaGlyphID） */
  writeInt16(v: number): void {
    this.writeInt16At(this.bytes.length, v);
  }

  /** 在指定绝对位置写入 int16（支持负数；同时用于 flush 回填可能为负的偏移量） */
  writeInt16At(pos: number, v: number): void {
    const u16 = v < 0 ? 0x10000 + (v & 0xffff) : v & 0xffff;
    this.bytes[pos] = (u16 >>> 8) & 0xff;
    this.bytes[pos + 1] = u16 & 0xff;
  }

  /** 预留一个 uint16 偏移量槽位，flush 时写入 (targetGetter() - base) */
  reserveOffset16(base: number, targetGetter: () => number): void {
    const pos = this.bytes.length;
    this.bytes.push(0, 0);
    this.patches.push({ pos, base, targetGetter });
  }

  /** flush 所有预留偏移量，必须在所有字节写完后调用 */
  flush(): void {
    for (const p of this.patches) {
      this.writeInt16At(p.pos, p.targetGetter() - p.base);
    }
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/**
 * 大端序字节读取器
 *
 * 越界读取不会抛出异常，而是设置 errorFlag 并返回 0。
 * 调用方据此将该 subtable 降级为原样拷贝，避免解析损坏/异常的表时崩溃
 * （如 FiraCode 某些 ChainedContext type6 格式 2 的 classSetCount 远大于实际类数）。
 */
export class OTReader {
  errorFlag = false;
  constructor(private dv: DataView) {}

  u16(off: number): number {
    if (off < 0 || off + 2 > this.dv.byteLength) {
      this.errorFlag = true;
      return 0;
    }
    return this.dv.getUint16(off, false);
  }

  i16(off: number): number {
    if (off < 0 || off + 2 > this.dv.byteLength) {
      this.errorFlag = true;
      return 0;
    }
    return this.dv.getInt16(off, false);
  }

  u32(off: number): number {
    if (off < 0 || off + 4 > this.dv.byteLength) {
      this.errorFlag = true;
      return 0;
    }
    return this.dv.getUint32(off, false);
  }

  /** 清除 errorFlag（开始解析新 subtable 前调用） */
  clearError(): void {
    this.errorFlag = false;
  }
}

/**
 * 重新序列化 ScriptList（GPOS/GSUB 通用，结构完全相同）
 *
 * ScriptList 不含 glyphId，但子表（ScriptTable/LangSys）偏移相对 ScriptList 起始，
 * 原始字体中 ScriptList 与 FeatureList/LookupList 的子表可能【物理交错】
 * （如霞鹜文楷 GSUB：ScriptList 跨越 FeatureList 起始位置），不能按连续字节块原样拷贝。
 * 本函数遍历所有子表，按遍历顺序紧凑重排并回填相对偏移，保证输出为合法连续块。
 *
 * @param r 原始字节读取器
 * @param listAbs ScriptList 在原始字节中的绝对偏移
 * @returns 重序列化后的 ScriptList 字节；解析异常（errorFlag）返回 null
 */
export function serializeScriptList(r: OTReader, listAbs: number): Uint8Array | null {
  r.clearError();
  const w = new OTWriter();
  const scriptCount = r.u16(listAbs);
  w.writeUint16(scriptCount);
  /** 预留 ScriptRecord 数组槽位（tag4 + offset2），记录每个 script 的新偏移 */
  const scriptNewOffs: number[] = new Array(scriptCount);
  for (let i = 0; i < scriptCount; i++) {
    const recAbs = listAbs + 2 + i * 6;
    /** tag 4 字节原样拷贝 */
    w.writeUint8(r.u16(recAbs) >>> 8);
    w.writeUint8(r.u16(recAbs) & 0xff);
    w.writeUint8(r.u16(recAbs + 2) >>> 8);
    w.writeUint8(r.u16(recAbs + 2) & 0xff);
    w.reserveOffset16(0, ((idx) => () => scriptNewOffs[idx])(i));
  }

  /** 逐 ScriptTable 序列化 */
  for (let i = 0; i < scriptCount; i++) {
    scriptNewOffs[i] = w.length;
    const scriptOldOff = listAbs + r.u16(listAbs + 2 + i * 6 + 4);
    const defaultLangSysOff = r.u16(scriptOldOff);
    const langSysCount = r.u16(scriptOldOff + 2);
    /** 收集该 ScriptTable 的 LangSys 表，紧凑排布 */
    const langSysNewOffs: number[] = new Array(langSysCount);
    /** 先写 ScriptTable 头 */
    const stStart = w.length;
    /** defaultLangSysOffset 槽（相对 ScriptTable 起始） */
    const defaultSlotHolder: number[] = [0];
    w.reserveOffset16(stStart, () => defaultSlotHolder[0]);
    w.writeUint16(langSysCount);
    for (let li = 0; li < langSysCount; li++) {
      const lr = scriptOldOff + 4 + li * 6;
      w.writeUint8(r.u16(lr) >>> 8);
      w.writeUint8(r.u16(lr) & 0xff);
      w.writeUint8(r.u16(lr + 2) >>> 8);
      w.writeUint8(r.u16(lr + 2) & 0xff);
      w.reserveOffset16(stStart, ((idx) => () => langSysNewOffs[idx])(li));
    }
    /** defaultLangSys 表 */
    if (defaultLangSysOff !== 0) {
      defaultSlotHolder[0] = w.length;
      copyLangSys(w, r, scriptOldOff + defaultLangSysOff);
    }
    /** 各 LangSys 表 */
    for (let li = 0; li < langSysCount; li++) {
      const lr = scriptOldOff + 4 + li * 6;
      const lsOldOff = scriptOldOff + r.u16(lr + 4);
      langSysNewOffs[li] = w.length;
      copyLangSys(w, r, lsOldOff);
    }
  }
  if (r.errorFlag) return null;
  w.flush();
  return w.toUint8Array();
}

/** 拷贝一个 LangSys 表（lookupOrderOffset + requiredFeatureIndex + featureIndexCount + featureIndices）
 *  lookupOrderOffset 规范已废弃恒为 0，直接写 0（避免指向无效重排后位置）。 */
function copyLangSys(w: OTWriter, r: OTReader, absOff: number): void {
  w.writeUint16(0);
  w.writeUint16(r.u16(absOff + 2));
  const fic = r.u16(absOff + 4);
  w.writeUint16(fic);
  for (let fi = 0; fi < fic; fi++) w.writeUint16(r.u16(absOff + 6 + fi * 2));
}

/**
 * 重新序列化 FeatureList（GPOS/GSUB 通用）
 *
 * 同 serializeScriptList 的理由：FeatureTable 偏移相对 FeatureList 起始，
 * 子表可能与其他块物理交错，需遍历重排。FeatureTable 的 featureParamsOffset
 * 通常为 0；非 0 时原样保留相对偏移（FeatureParams 不含 gid，不重映射）。
 *
 * @returns 重序列化后的 FeatureList 字节；解析异常返回 null
 */
export function serializeFeatureList(r: OTReader, listAbs: number): Uint8Array | null {
  r.clearError();
  const w = new OTWriter();
  const featureCount = r.u16(listAbs);
  w.writeUint16(featureCount);
  const featureNewOffs: number[] = new Array(featureCount);
  for (let i = 0; i < featureCount; i++) {
    const recAbs = listAbs + 2 + i * 6;
    w.writeUint8(r.u16(recAbs) >>> 8);
    w.writeUint8(r.u16(recAbs) & 0xff);
    w.writeUint8(r.u16(recAbs + 2) >>> 8);
    w.writeUint8(r.u16(recAbs + 2) & 0xff);
    w.reserveOffset16(0, ((idx) => () => featureNewOffs[idx])(i));
  }

  for (let i = 0; i < featureCount; i++) {
    featureNewOffs[i] = w.length;
    const ftOldOff = listAbs + r.u16(listAbs + 2 + i * 6 + 4);
    const featureParamsOff = r.u16(ftOldOff);
    const lookupIndexCount = r.u16(ftOldOff + 2);
    /** featureParamsOffset 原样保留（非 0 时相对 FeatureTable，其内容不含 gid） */
    w.writeUint16(featureParamsOff);
    w.writeUint16(lookupIndexCount);
    for (let li = 0; li < lookupIndexCount; li++) w.writeUint16(r.u16(ftOldOff + 4 + li * 2));
  }
  if (r.errorFlag) return null;
  w.flush();
  return w.toUint8Array();
}
