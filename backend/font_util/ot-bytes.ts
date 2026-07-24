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
  /** 优化（Uint8Array 底层缓冲）：原用 number[] + push 累积字节，每个 writeUint8/16 触发
   *  数字装箱与数组扩容；gsub-subset 逐字节 writeUint8 复制 ScriptList/FeatureList 字节块
   *  极慢。改用 Uint8Array 容量缓冲 + size 指针：writeUint8/16 索引写入（无装箱），
   *  writeBytes 用 TypedArray.set 批量复制，toUint8Array 零拷贝 subarray。
   *
   *  优化327: 初始容量 256→2048，并让 writeUint16/writeInt16/reserveOffset16 内联容量检查。
   *  GPOS/GSUB 输出常达数 KB（思源 GPOS 978B、令东 GSUB 数十 KB），256 起步触发多次 2× 扩容
   *  （每次扩容 new Uint8Array + set 全拷贝）。更关键的是 writeUint16 是序列化第一热点
   *  （思源 subsetGPOS 207 次/call 占 ~58%），原实现每次调 private ensure()——V8 对 class
   *  private method 内联不充分，per-call 函数调用开销在百次累计下显著。改为内联容量判断
   *  （够用直接写，不够才调 grow），消除热路径上的函数调用。 */
  private buf: Uint8Array = new Uint8Array(2048);
  private size: number = 0;
  private patches: Array<{ pos: number; base: number; targetGetter: () => number }> = [];

  get length(): number {
    return this.size;
  }

  /** 容量不足时扩容（仅在 write 路径内联判断发现不够时调用） */
  private grow(required: number): void {
    let cap = this.buf.byteLength;
    while (cap < required) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.buf);
    this.buf = grown;
  }

  /** 回退到指定字节位置，丢弃之后写入的字节与对应的偏移量槽（用于 subtable 重映射失败的保守降级）。
   *  patches 按 pos 单调递增追加，故从尾部 pop 掉 pos >= 阈值的项即可，无需全量 filter
   *  （subsetGSUB 每个失败的 subtable 都 rollback，FiraCode 实测 392 次/call，filter 改 pop 后此热点消失）。 */
  rollback(pos: number): void {
    this.size = pos;
    const patches = this.patches;
    while (patches.length > 0 && patches[patches.length - 1].pos >= pos) patches.pop();
  }

  writeUint8(v: number): void {
    const s = this.size;
    if (s + 1 > this.buf.byteLength) this.grow(s + 1);
    this.buf[s] = v & 0xff;
    this.size = s + 1;
  }

  writeUint16(v: number): void {
    const s = this.size;
    if (s + 2 > this.buf.byteLength) this.grow(s + 2);
    this.buf[s] = (v >>> 8) & 0xff;
    this.buf[s + 1] = v & 0xff;
    this.size = s + 2;
  }

  /** 批量写入字节块（TypedArray.set，远快于逐字节 writeUint8 循环） */
  writeBytes(arr: Uint8Array): void {
    const n = arr.byteLength;
    const s = this.size;
    const required = s + n;
    if (required > this.buf.byteLength) this.grow(required);
    this.buf.set(arr, s);
    this.size = required;
  }

  /** 在当前末尾写入 int16（大端，支持负数；如 SingleSubst format1 的 deltaGlyphID）。
   *  原实现依赖 number[] 索引赋值到 length 位置隐式扩展数组，Uint8Array 版需显式 ensure + 推进 size。 */
  writeInt16(v: number): void {
    const s = this.size;
    if (s + 2 > this.buf.byteLength) this.grow(s + 2);
    const u16 = v < 0 ? 0x10000 + (v & 0xffff) : v & 0xffff;
    this.buf[s] = (u16 >>> 8) & 0xff;
    this.buf[s + 1] = u16 & 0xff;
    this.size = s + 2;
  }

  /** 在指定绝对位置写入 int16（支持负数；同时用于 flush 回填可能为负的偏移量）。
   *  pos 必须已在已写入范围内（由 reserveOffset16 的 ensure 保证），仅覆盖不扩展。 */
  writeInt16At(pos: number, v: number): void {
    const u16 = v < 0 ? 0x10000 + (v & 0xffff) : v & 0xffff;
    this.buf[pos] = (u16 >>> 8) & 0xff;
    this.buf[pos + 1] = u16 & 0xff;
  }

  /** 预留一个 uint16 偏移量槽位，flush 时写入 (targetGetter() - base) */
  reserveOffset16(base: number, targetGetter: () => number): void {
    const pos = this.size;
    if (pos + 2 > this.buf.byteLength) this.grow(pos + 2);
    this.size = pos + 2;
    this.patches.push({ pos, base, targetGetter });
  }

  /** flush 所有预留偏移量，必须在所有字节写完后调用 */
  flush(): void {
    for (const p of this.patches) {
      this.writeInt16At(p.pos, p.targetGetter() - p.base);
    }
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.buf.subarray(0, this.size));
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
  /** 原始 DataView，热路径（如 coverage 解析）可直接用 getUint16 绕过 u16 的逐次边界检查 */
  readonly dv: DataView;
  constructor(dv: DataView) {
    this.dv = dv;
  }

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
 * 计算 ScriptList 的连续字节跨度（相对 listAbs 的字节数），用于判断能否整块原样拷贝。
 *
 * ScriptList 不含 glyphId，子表（ScriptTable/LangSys）偏移相对 listAbs 起始。
 * 绝大多数字体（含思源/初夏/令东的 GPOS 与 GSUB）的 ScriptList 子表紧凑排列在
 * [listAbs, listAbs+span) 内、与 FeatureList/LookupList 无物理交错——此时该字节块本身
 * 就是合法 ScriptList，可整块拷贝跳过逐字段重序列化，并保留 fontTools 的 LangSys 去重
 * （serializeScriptList 紧凑重排会丢失去重、输出反而更大，如思源 OTF 538→1066B）。
 *
 * 本函数扫描全部 ScriptTable/LangSys，返回其最大结束偏移作为 span。返回 -1 表示解析异常
 * （errorFlag，调用方降级 serializeScriptList）。注意：span 仅保证「子表结束位置」，
 * 调用方还需校验 span 不越过下一表起始以排除物理交错。
 *
 * @param r 原始字节读取器
 * @param listAbs ScriptList 在原始字节中的绝对偏移
 * @returns ScriptList 字节跨度（≥0），解析异常返回 -1
 */
export function scriptListSpan(r: OTReader, listAbs: number): number {
  r.clearError();
  const scriptCount = r.u16(listAbs);
  /** span = listAbs 起，覆盖 ScriptRecord 数组 + 所有 ScriptTable 及其 LangSys 的结束位置 */
  let span = 2 + scriptCount * 6;
  for (let i = 0; i < scriptCount; i++) {
    /** ScriptRecord 偏移相对 listAbs */
    const scriptRel = r.u16(listAbs + 2 + i * 6 + 4);
    const scriptAbs = listAbs + scriptRel;
    const defaultLangSysOff = r.u16(scriptAbs);
    const langSysCount = r.u16(scriptAbs + 2);
    /** ScriptTable 头：defaultLangSysOff(2) + langSysCount(2) + LangSysRecord[langSysCount](6) */
    span = Math.max(span, scriptRel + 4 + langSysCount * 6);
    /** defaultLangSys 表：lookupOrder(2)+reqFeatureIdx(2)+featureIdxCount(2)+indices */
    if (defaultLangSysOff !== 0) {
      const dlAbs = scriptAbs + defaultLangSysOff;
      const dlRel = scriptRel + defaultLangSysOff;
      const fic = r.u16(dlAbs + 4);
      span = Math.max(span, dlRel + 6 + fic * 2);
    }
    /** 各 LangSys 表 */
    for (let li = 0; li < langSysCount; li++) {
      const lsRel = r.u16(scriptAbs + 4 + li * 6 + 4);
      const lsAbs = scriptAbs + lsRel;
      const fic = r.u16(lsAbs + 4);
      span = Math.max(span, scriptRel + lsRel + 6 + fic * 2);
    }
  }
  return r.errorFlag ? -1 : span;
}

/**
 * 计算 FeatureList 的连续字节跨度（相对 listAbs 的字节数），用于判断能否整块原样拷贝。
 *
 * FeatureList 不含 glyphId，FeatureTable 偏移相对 listAbs。fontTools 常对内容相同的
 * FeatureTable 去重（多个 FeatureRecord 指向同一 FeatureTable，如初夏 GPOS 296 个 feature
 * 共享 1 个 FeatureTable）。serializeFeatureList 逐 feature 重写会丢失去重（296 份独立拷贝，
 * 1840→3728B）。若 FeatureTable 紧凑排列在 [listAbs, listAbs+span) 内无交错，整块拷贝
 * 既跳过逐字段序列化、又保留去重。
 *
 * @returns FeatureList 字节跨度（≥0），解析异常返回 -1
 */
export function featureListSpan(r: OTReader, listAbs: number): number {
  r.clearError();
  const featureCount = r.u16(listAbs);
  let span = 2 + featureCount * 6;
  for (let i = 0; i < featureCount; i++) {
    /** FeatureRecord 偏移相对 listAbs */
    const ftRel = r.u16(listAbs + 2 + i * 6 + 4);
    const ftAbs = listAbs + ftRel;
    const lookupIndexCount = r.u16(ftAbs + 2);
    /** FeatureTable: featureParamsOff(2) + lookupIndexCount(2) + indices */
    span = Math.max(span, ftRel + 4 + lookupIndexCount * 2);
  }
  return r.errorFlag ? -1 : span;
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
