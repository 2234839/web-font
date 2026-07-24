/**
 * CFF (Compact Font Format) 表子集化器 —— OTF 字体保留 CFF 轮廓的子集化。
 *
 * 背景：fonteditor-core 对 OTF 输入走 otf2ttfobject（CFF 三次贝塞尔 → glyf 二次贝塞尔），
 * 子集化后再以 glyf 输出。但浏览器对 CFF（三次）与 glyf（二次）的光栅化路径不同，
 * 子集后渲染与原始 OTF 存在像素差异（基准 SSIM 0.93~0.97，ink 差数百像素）。
 *
 * 本模块直接对原始 CFF 表做子集化：保留 CID-keyed 结构（charset/FDSelect/CharStrings/
 * FDArray/Private），按 subsetGids 重排顺序并透传 charstring 原始字节。charstring 内的
 * 坐标与 callsubr/callgsubr 调用相对自身，故 Global Subr INDEX 与各 FD 的 Local Subr INDEX
 * 原样透传即可保持引用有效。实测白狐/思源 OTF 子集后浏览器渲染 ink 与原始 OTF 像素级一致
 * （SSIM 可达 ≈1.0）。
 *
 * 仅支持 CID-keyed CFF（Top DICT 含 ROS / FDArray / FDSelect）。非 CID（Type 2 name-keyed）
 * 字体走另一套 charstring 索引结构，当前生产用例不涉及，遇到时返回 null 降级。
 *
 * @reference https://learn.microsoft.com/en-us/typography/opentype/spec/cff
 */

/** CFF INDEX 解析结果。offsets 为 1-based，object i 的字节区间 = [dataStart+offsets[i]-1, dataStart+offsets[i+1]-1) */
interface CffIndex {
  /** INDEX 起始偏移 */
  start: number;
  /** INDEX 内对象数量 */
  count: number;
  /** 偏移量字节宽度（1~4） */
  offSize: number;
  /** (count+1) 个 1-based 偏移量 */
  offsets: number[];
  /** 数据区起始位置（紧接偏移量数组之后） */
  dataStart: number;
  /** INDEX 结束位置（= 最后一个 object 的尾） */
  end: number;
}

/**
 * 解析 CFF INDEX 结构（count + offSize + offsets + data）。
 * @param b CFF 字节
 * @param pos INDEX 起始偏移
 */
function readIndex(b: Uint8Array, pos: number): CffIndex {
  const count = (b[pos] << 8) | b[pos + 1];
  /** count=0 的 INDEX 仅 2 字节 */
  if (count === 0) return { start: pos, count: 0, offSize: 0, offsets: [], dataStart: pos + 2, end: pos + 2 };
  const offSize = b[pos + 2];
  let op = pos + 3;
  const offsets: number[] = new Array(count + 1);
  for (let i = 0; i <= count; i++) {
    let v = 0;
    for (let j = 0; j < offSize; j++) v = (v << 8) | b[op++];
    offsets[i] = v;
  }
  /** offsets 是 1-based：object i 的数据从 dataStart + offsets[i] - 1 开始 */
  const dataStart = op;
  return { start: pos, count, offSize, offsets, dataStart, end: dataStart + offsets[count] - 1 };
}

/** INDEX 轻量头部：只解析 count/offSize/dataStart，不解析 (count+1) 个 offset 数组。
 *  Local Subr INDEX 引用收集只需按 subr 编号读个别 offset（思源 FD12 26550 subr 仅引用十几个），
 *  全量 readIndex 解析 26551 个 offset 占 subsetCFF 一半耗时，按需读消除之。 */
interface IndexHeader {
  /** INDEX 起始偏移 */
  start: number;
  /** INDEX 内对象数量 */
  count: number;
  /** 偏移量字节宽度（1~4） */
  offSize: number;
  /** 偏移量数组起始（紧接 count/offSize 之后） */
  offBase: number;
  /** 数据区起始（紧接偏移量数组之后 = offBase + (count+1)*offSize） */
  dataStart: number;
  /** INDEX 结束位置（= 最后一个 object 的尾） */
  end: number;
}

/** 只读 INDEX 头部（count + offSize + dataStart + end），不解析 offset 数组。
 *  end 需读第 count 个 offset（位于 offBase + count*offSize）。 */
function readIndexHeader(b: Uint8Array, pos: number): IndexHeader {
  const count = (b[pos] << 8) | b[pos + 1];
  /** count=0 的 INDEX 仅 2 字节 */
  if (count === 0) return { start: pos, count: 0, offSize: 0, offBase: pos + 2, dataStart: pos + 2, end: pos + 2 };
  const offSize = b[pos + 2];
  const offBase = pos + 3;
  const dataStart = offBase + (count + 1) * offSize;
  /** 读第 count 个 offset（哨兵，= 总数据长 + 1）算 end */
  let lastOff = 0;
  let op = offBase + count * offSize;
  for (let j = 0; j < offSize; j++) lastOff = (lastOff << 8) | b[op++];
  return { start: pos, count, offSize, offBase, dataStart, end: dataStart + lastOff - 1 };
}

/** 按 object 编号 i 读取 INDEX 的第 i 个 offset（1-based，大端 offSize 字节）。
 *  object i 的数据区间 = [dataStart + offset(i) - 1, dataStart + offset(i+1) - 1)。 */
function readIndexOffset(b: Uint8Array, h: IndexHeader, i: number): number {
  let v = 0;
  let op = h.offBase + i * h.offSize;
  for (let j = 0; j < h.offSize; j++) v = (v << 8) | b[op++];
  return v;
}

/** 只取 INDEX 的字节范围 [start, end)，不解析中间 offset 数组。
 *  Local/Global Subr INDEX 透传时只需整体字节切片，全量解析 count+1 个 offset 是纯浪费
 *  （思源等大字体的 Local Subr 可达数千 subr，readIndex 全量解析占 subsetCFF 主要耗时）。
 *  end = dataStart + offsets[count] - 1，仅读第 count 个 offset（位于 pos+3+count*offSize）即可。 */
function indexByteRange(b: Uint8Array, pos: number): { start: number; end: number } {
  const count = (b[pos] << 8) | b[pos + 1];
  /** count=0 的 INDEX 仅 2 字节 */
  if (count === 0) return { start: pos, end: pos + 2 };
  const offSize = b[pos + 2];
  /** dataStart = pos + 3（count+offSize 头）+ (count+1)*offSize（offset 数组） */
  const dataStart = pos + 3 + (count + 1) * offSize;
  /** 第 count 个 offset 位于 offset 数组末尾（pos+3 + count*offSize），读 offSize 字节大端 */
  let lastOff = 0;
  const lp = pos + 3 + count * offSize;
  for (let j = 0; j < offSize; j++) lastOff = (lastOff << 8) | b[lp + j];
  return { start: pos, end: dataStart + lastOff - 1 };
}

/** CFF Top/Private DICT 解析结果：操作码键 → 操作数数组。双字节操作码 12,n 存为 (12<<8)|n */
type CffDict = Map<number, number[]>;

/**
 * 解析 CFF DICT 字节为操作码键→操作数数组的映射。
 * 操作数编码（CFF 规范 §3.1）：
 *   32~246 → 1 字节小整数 v-139
 *   247~250 → 2 字节 (v-247)*256+b+108
 *   251~254 → 2 字节 -(v-251)*256-b-108
 *   28 → 2 字节 int16
 *   29 → 4 字节 int32
 *   12 → 双字节操作码前缀（下一字节为操作码低位）
 *   其他 <31（非 12）→ 单字节操作码
 * @param b DICT 字节
 * @param start DICT 起始偏移
 * @param end DICT 结束偏移（不含）
 */
function parseDict(b: Uint8Array, start: number, end: number): CffDict {
  const dict: CffDict = new Map();
  const operands: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = b[p++];
    if (b0 <= 21) {
      /** 操作码 */
      let op = b0;
      if (b0 === 12) op = (12 << 8) | b[p++];
      dict.set(op, operands.splice(0, operands.length));
    } else if (b0 === 28) {
      operands.push(((b[p] << 24) | (b[p + 1] << 16)) >> 16);
      p += 2;
    } else if (b0 === 29) {
      operands.push(((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0);
      p += 4;
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + b[p] + 108);
      p += 1;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - b[p] - 108);
      p += 1;
    }
  }
  return dict;
}

/**
 * 编码一个 DICT 整数操作数为字节数组（CFF 规范 §3.1 整数编码）。
 * @param v 整数值
 */
function encodeDictInt(v: number): number[] {
  if (v >= -107 && v <= 107) return [v + 139];
  if (v >= 108 && v <= 1131) {
    const v0 = v - 108;
    return [247 + (v0 >> 8), v0 & 0xff];
  }
  if (v >= -1131 && v <= -108) {
    const v0 = -v - 108;
    return [251 + (v0 >> 8), v0 & 0xff];
  }
  if (v >= -32768 && v <= 32767) return [28, (v >> 8) & 0xff, v & 0xff];
  return [29, (v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Type 2 charstring 操作码（Adobe Type 2 Charstring Format）。 */
const T2_CALLSUBR = 10;
const T2_RETURN = 11;
const T2_ENDCHAR = 14;
const T2_HSTEM = 1;
const T2_VSTEM = 3;
const T2_HSTEMHM = 18;
const T2_VSTEMHM = 23;
const T2_HINTMASK = 19;
const T2_CNTRMASK = 20;
const T2_CALLGSUBR = 29;

/** 计算 subr INDEX 的 bias（CFF 规范：调用编号 = 实际 subr 索引 + bias）。
 *  nSubrs < 1240 → 107；< 33900 → 1131；否则 32768。 */
function subrBias(nSubrs: number): number {
  if (nSubrs < 1240) return 107;
  if (nSubrs < 33900) return 1131;
  return 32768;
}

/**
 * 扫描单个 Type 2 charstring/subr 字节，收集其引用的 local subr 与 global subr 编号。
 * 采用栈模拟：operand 依次入栈，遇 callsubr(10)/callgsubr(29) 取栈顶为调用编号（减 bias 得实际索引）。
 *
 * hintmask(19)/cntrmask(20) 后跟 ceil(stemCount/8) 字节掩码，必须跳过——否则掩码字节会被
 * 误判为操作码致扫描错位、漏收引用（思源 charstring 大量使用 hint）。
 * stemCount 由 stem 类操作码（hstem/vstem/hstemhm/vstemhm）的栈深度累加（每 stem = 2 operand）。
 *
 * @param b CFF 字节
 * @param start charstring/subr 起始偏移
 * @param end charstring/subr 结束偏移（不含）
 * @param localBias 该 charstring 所属 FD 的 local subr bias
 * @param localCount local subr 总数（越界保护）
 * @param localRefs 输出：收集到的 local subr 实际索引
 * @param gsubrRefs 输出：收集到的 global subr 实际索引
 */
export function collectSubrRefs(
  b: Uint8Array,
  start: number,
  end: number,
  localBias: number,
  localCount: number,
  localRefs: Set<number>,
  gsubrRefs: Set<number>,
): void {
  /**
   * 优化：用 stackLen 计数器 + lastVal 替代 stack: number[]。
   *  仅需栈长度（HSTEM 算 stemCount）与栈顶值（CALLSUBR/CALLGSUBR 取调用编号），
   *  无需完整栈数组。消除每 operand 的 push（含装箱）与 stack.length=0 重置。
   *  lastVal 仅在 stackLen>0 时有效（CALLSUBR 前必有 operand push）。
   */
  let p = start;
  let stackLen = 0;
  let lastVal = NaN;
  let stemCount = 0;
  while (p < end) {
    const b0 = b[p++];
    if (b0 === 255) {
      /** fixed point（坐标），4 字节，不入栈编号判定 */
      lastVal = NaN;
      stackLen++;
      p += 4;
    } else if (b0 === 28) {
      lastVal = ((b[p] << 24) | (b[p + 1] << 16)) >> 16;
      stackLen++;
      p += 2;
    } else if (b0 === 29) {
      lastVal = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0;
      stackLen++;
      p += 4;
    } else if (b0 >= 32 && b0 <= 246) {
      lastVal = b0 - 139;
      stackLen++;
    } else if (b0 >= 247 && b0 <= 250) {
      lastVal = (b0 - 247) * 256 + b[p] + 108;
      stackLen++;
      p += 1;
    } else if (b0 >= 251 && b0 <= 254) {
      lastVal = -(b0 - 251) * 256 - b[p] - 108;
      stackLen++;
      p += 1;
    } else {
      /** 操作码（b0 <= 27，含 12 双字节） */
      if (b0 === 12) {
        p += 1;
        stackLen = 0;
      } else if (b0 === T2_HSTEM || b0 === T2_VSTEM || b0 === T2_HSTEMHM || b0 === T2_VSTEMHM) {
        stemCount += stackLen >> 1;
        stackLen = 0;
      } else if (b0 === T2_HINTMASK || b0 === T2_CNTRMASK) {
        p += (stemCount + 7) >>> 3;
        stackLen = 0;
      } else if (b0 === T2_CALLSUBR) {
        if (Number.isInteger(lastVal)) {
          const sn = lastVal + localBias;
          if (sn >= 0 && sn < localCount) localRefs.add(sn);
        }
        stackLen = 0;
      } else if (b0 === T2_CALLGSUBR) {
        if (Number.isInteger(lastVal)) gsubrRefs.add(lastVal);
        stackLen = 0;
      } else if (b0 === T2_ENDCHAR) {
        break;
      } else {
        /** 其余操作码（运动/曲线等）消费栈 */
        stackLen = 0;
      }
    }
  }
}

/**
 * 重写 Type 2 charstring/subr：把 callsubr/callgsubr 的调用编号 operand 重映射到子集编号。
 * 其余字节原样保留（坐标、操作码、hintmask 掩码等）。
 *
 * 实现：逐字节复制到输出，operand 入栈时记录其在输出的起始位置；遇 callsubr/callgsubr 时
 * 截断输出回栈顶 operand 起始处，写入新编号编码（operand 编码长度可能变化，故必须重建流而非原地改）。
 *
 * @param b CFF 字节
 * @param start charstring 起始偏移
 * @param end charstring 结束偏移
 * @param localBias 原 local subr bias（解析 operand 用）
 * @param localRemap 旧 local subr 索引 → 新索引（-1 表示未保留，不该出现于引用 charstring）
 * @param newLocalCount 新 local subr 总数（算新 bias）
 * @returns 重写后的字节。global subr 不子集化（callgsubr operand 原样保留，bias 不变）。
 */
export function rewriteCharstring(
  b: Uint8Array,
  start: number,
  end: number,
  localBias: number,
  localRemap: Map<number, number>,
  newLocalCount: number,
): Uint8Array {
  const newLocalBias = subrBias(newLocalCount);
  /**
   * 优化：预分配 Uint8Array + 写指针 wp 替代 number[] + push。
   *  原 out: number[] 逐字节 push 有装箱开销，且最终 new Uint8Array(out) 要二次遍历转换。
   *  Uint8Array 直接写字节，wp 模拟 length（CALLSUBR 截断即 wp = stackStart[...]）。
   *  容量上界：(end-start) 是原始字节长度；CALLSUBR 重写时新 operand 编码（1~5 字节）
   *  可能比原 operand（1~5 字节）长，最坏每个 operand 多 4 字节。operand 数 ≤ end-start，
   *  故 (end-start)*2 + 16 是安全上界（远超实际，仅预分配不写入多余字节）。
   */
  const cap = ((end - start) << 1) + 16;
  const out = new Uint8Array(cap);
  let wp = 0;
  /** 栈：记录每个 operand 在输出中的起始 wp（便于截断重写）。值为原始解析值。 */
  const stackStart: number[] = [];
  const stackVal: number[] = [];
  let stemCount = 0;
  let p = start;
  while (p < end) {
    const b0 = b[p++];
    if (b0 === 255) {
      stackStart.push(wp);
      stackVal.push(NaN);
      out[wp] = 255; out[wp + 1] = b[p]; out[wp + 2] = b[p + 1]; out[wp + 3] = b[p + 2]; out[wp + 4] = b[p + 3];
      wp += 5;
      p += 4;
    } else if (b0 === 28) {
      stackStart.push(wp);
      stackVal.push(((b[p] << 24) | (b[p + 1] << 16)) >> 16);
      out[wp] = 28; out[wp + 1] = b[p]; out[wp + 2] = b[p + 1];
      wp += 3;
      p += 2;
    } else if (b0 === 29) {
      stackStart.push(wp);
      stackVal.push(((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0);
      out[wp] = 29; out[wp + 1] = b[p]; out[wp + 2] = b[p + 1]; out[wp + 3] = b[p + 2]; out[wp + 4] = b[p + 3];
      wp += 5;
      p += 4;
    } else if (b0 >= 32 && b0 <= 246) {
      stackStart.push(wp);
      stackVal.push(b0 - 139);
      out[wp++] = b0;
    } else if (b0 >= 247 && b0 <= 250) {
      stackStart.push(wp);
      stackVal.push((b0 - 247) * 256 + b[p] + 108);
      out[wp] = b0; out[wp + 1] = b[p];
      wp += 2;
      p += 1;
    } else if (b0 >= 251 && b0 <= 254) {
      stackStart.push(wp);
      stackVal.push(-(b0 - 251) * 256 - b[p] - 108);
      out[wp] = b0; out[wp + 1] = b[p];
      wp += 2;
      p += 1;
    } else {
      /** 操作码 */
      if (b0 === 12) {
        out[wp] = 12; out[wp + 1] = b[p];
        wp += 2;
        p += 1;
        stackStart.length = 0;
        stackVal.length = 0;
      } else if (b0 === T2_HSTEM || b0 === T2_VSTEM || b0 === T2_HSTEMHM || b0 === T2_VSTEMHM) {
        stemCount += stackVal.length >> 1;
        out[wp++] = b0;
        stackStart.length = 0;
        stackVal.length = 0;
      } else if (b0 === T2_HINTMASK || b0 === T2_CNTRMASK) {
        out[wp++] = b0;
        const maskBytes = (stemCount + 7) >>> 3;
        out.set(b.subarray(p, p + maskBytes), wp);
        wp += maskBytes;
        p += maskBytes;
        stackStart.length = 0;
        stackVal.length = 0;
      } else if (b0 === T2_CALLSUBR) {
        const arg = stackVal[stackVal.length - 1];
        const oldSn = Number.isInteger(arg) ? arg + localBias : -1;
        const newSn = localRemap.get(oldSn);
        if (newSn === undefined) {
          /** subr 未保留（理论上引用 charstring 必命中）——保留原 operand 保底 */
          out[wp++] = T2_CALLSUBR;
        } else {
          /** 截断到栈顶 operand 起始，写入新编号编码（直接写 Uint8Array，不分配临时数组） */
          wp = stackStart[stackStart.length - 1];
          const delta = newSn - newLocalBias;
          if (delta >= -107 && delta <= 107) {
            out[wp++] = delta + 139;
          } else if (delta >= 108 && delta <= 1131) {
            const v0 = delta - 108;
            out[wp] = 247 + (v0 >> 8); out[wp + 1] = v0 & 0xff;
            wp += 2;
          } else if (delta >= -1131 && delta <= -108) {
            const v0 = -delta - 108;
            out[wp] = 251 + (v0 >> 8); out[wp + 1] = v0 & 0xff;
            wp += 2;
          } else if (delta >= -32768 && delta <= 32767) {
            out[wp] = 28; out[wp + 1] = (delta >> 8) & 0xff; out[wp + 2] = delta & 0xff;
            wp += 3;
          } else {
            out[wp] = 29; out[wp + 1] = (delta >>> 24) & 0xff; out[wp + 2] = (delta >> 16) & 0xff; out[wp + 3] = (delta >> 8) & 0xff; out[wp + 4] = delta & 0xff;
            wp += 5;
          }
          out[wp++] = T2_CALLSUBR;
        }
        stackStart.length = 0;
        stackVal.length = 0;
      } else if (b0 === T2_CALLGSUBR) {
        /** global subr 不子集化：operand（调用编号）原样保留，bias 不变 */
        out[wp++] = T2_CALLGSUBR;
        stackStart.length = 0;
        stackVal.length = 0;
      } else if (b0 === T2_ENDCHAR) {
        out[wp++] = b0;
        break;
      } else {
        out[wp++] = b0;
        stackStart.length = 0;
        stackVal.length = 0;
      }
    }
  }
  return out.subarray(0, wp);
}

/**
 * 序列化 CFF INDEX：count + offSize + (count+1)*offSize 偏移量 + 数据拼接。
 * 选最小能容纳最大偏移量的 offSize。偏移量 1-based（首个 offset=1）。
 * @param objects 每个对象的字节切片（Uint8Array 或等价的 {start,len} 引用）
 */
function writeIndex(objects: { bytes: Uint8Array; start: number; len: number }[]): Uint8Array {
  const count = objects.length;
  if (count === 0) return new Uint8Array(2); /** count=0 的空 INDEX */

  /** 累计数据长度，算最大 offset（含末尾哨兵） */
  let totalData = 0;
  for (const o of objects) totalData += o.len;
  const maxOffset = totalData + 1;

  /** 选 offSize：1~4 字节 */
  let offSize = 1;
  if (maxOffset > 0xffff) offSize = 4;
  else if (maxOffset > 0xff) offSize = 2;
  let tmp = maxOffset;
  while (tmp > 0xff && offSize < 4) {
    offSize++;
    tmp >>>= 8;
  }

  const offsetsSize = (count + 1) * offSize;
  const totalSize = 2 + 1 + offsetsSize + totalData;
  const out = new Uint8Array(totalSize);
  out[0] = (count >> 8) & 0xff;
  out[1] = count & 0xff;
  out[2] = offSize;

  /** 写偏移量（1-based，大端 offSize 字节） */
  let op = 3;
  let acc = 1;
  const writeOffset = (v: number) => {
    for (let s = (offSize - 1) * 8; s >= 0; s -= 8) out[op++] = (v >>> s) & 0xff;
  };
  writeOffset(acc);
  for (const o of objects) {
    acc += o.len;
    writeOffset(acc);
  }

  /** 写数据 */
  let dp = 3 + offsetsSize;
  for (const o of objects) {
    out.set(o.bytes.subarray(o.start, o.start + o.len), dp);
    dp += o.len;
  }
  return out;
}

/** CFF 操作码键（单字节直接用值，双字节用 (12<<8)|n） */
const OP_charset = 15;
const OP_charStrings = 17;
const OP_Private = 18;
/** Private DICT 内：Local Subr INDEX 相对 Private 起始的偏移 */
const OP_LocalSubr = 19;
const OP_FDArray = (12 << 8) | 36;
const OP_FDSelect = (12 << 8) | 37;
const OP_ROS = (12 << 8) | 30;

/** CFF FDSelect 格式 3 的单个 range：首 glyph index + FD index */
interface FdSelectRange {
  first: number;
  fd: number;
}

/**
 * 按需查询单个原始 gid 的 FD index（替代全量 parseFDSelect）。
 * 子集只需 newSubsetGids 对应的 FD，全量展开 numGlyphs(思源 65535) 是浪费。
 * 格式 0：format(1) + numGlyphs×uint8，直接按 gid 取字节。
 * 格式 3：format(1) + nRanges(u16) + ranges[first(u16),fd(u8)]×nRanges + sentinel(u16)，
 *  二分找最后一个 first<=gid 的 range（range 覆盖 [first, 下一range.first) ）。
 * @param b CFF 字节
 * @param fdSelectOff FDSelect 表起始偏移
 * @param gid 原始 gid
 */
function lookupFDSelect(b: Uint8Array, fdSelectOff: number, gid: number): number {
  const fmt = b[fdSelectOff];
  if (fmt === 0) return b[fdSelectOff + 1 + gid];
  /** format 3：ranges 起始 = fdSelectOff + 3，每 range 3 字节 */
  const nRanges = (b[fdSelectOff + 1] << 8) | b[fdSelectOff + 2];
  const rangesStart = fdSelectOff + 3;
  /** 二分：找最大 i 使 ranges[i].first <= gid，返回该 range 的 fd */
  let lo = 0;
  let hi = nRanges - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const first = (b[rangesStart + mid * 3] << 8) | b[rangesStart + mid * 3 + 1];
    if (first <= gid) lo = mid;
    else hi = mid - 1;
  }
  return b[rangesStart + lo * 3 + 2];
}

/**
 * 编码 FDSelect：单 FD（所有字形同属一个 FD）用格式 0 最省；多 FD 用格式 3 ranges。
 *  格式 0：format(1) + numGlyphs×uint8
 *  格式 3：format(1) + nRanges(u16) + ranges[first(u16), fd(u8)]×nRanges + sentinel(u16)
 *  多 FD 选格式 3：与原始 CID 字体（思源等）结构一致，规避 OTS 对强制 format 0 的严格校验。
 * @param gidToFd 每个新 gid 的新 FD 编号（顺序，含 gid 0）
 */
function encodeFDSelect(gidToFd: number[]): Uint8Array {
  /** 单 FD：所有字形同一个 FD，用格式 0 */
  let singleFd = gidToFd.length > 0 ? gidToFd[0] : 0;
  let isSingle = gidToFd.length > 0;
  for (const fd of gidToFd) {
    if (fd !== singleFd) { isSingle = false; break; }
  }
  if (isSingle) {
    const out = new Uint8Array(1 + gidToFd.length);
    out[0] = 0;
    for (let i = 0; i < gidToFd.length; i++) out[1 + i] = gidToFd[i];
    return out;
  }
  /** 多 FD：格式 3 ranges。连续相同 FD 的 gid 合并为一个 range。 */
  const ranges: FdSelectRange[] = [];
  let curFirst = 0;
  let curFd = gidToFd[0];
  for (let i = 1; i < gidToFd.length; i++) {
    if (gidToFd[i] !== curFd) {
      ranges.push({ first: curFirst, fd: curFd });
      curFirst = i;
      curFd = gidToFd[i];
    }
  }
  ranges.push({ first: curFirst, fd: curFd });
  const nRanges = ranges.length;
  const out = new Uint8Array(3 + nRanges * 3 + 2);
  out[0] = 3; /** format 3 */
  out[1] = (nRanges >> 8) & 0xff;
  out[2] = nRanges & 0xff;
  let p = 3;
  for (const r of ranges) {
    out[p] = (r.first >> 8) & 0xff;
    out[p + 1] = r.first & 0xff;
    out[p + 2] = r.fd;
    p += 3;
  }
  /** sentinel = numGlyphs（最后一个 range 之后的第一个 gid） */
  const sentinel = gidToFd.length;
  out[p] = (sentinel >> 8) & 0xff;
  out[p + 1] = sentinel & 0xff;
  return out;
}

/**
 * CID CFF 子集化主入口。
 *
 * 重建流程：
 *   1. 解析 Header / Name INDEX / Top DICT INDEX / String INDEX / Global Subr INDEX（这些段透传或仅改 Top DICT offset）
 *   2. 按 subsetGids 重排 charset / FDSelect / CharStrings INDEX
 *   3. 收集命中的 FD，重建 FDArray（透传各 FD 的 DICT + Private）+ 重写 FDSelect 用新 FD 编号
 *   4. patch Top DICT 的 charset / charStrings / FDArray / FDSelect offset 指向新位置
 *
 * @param cffBytes 原始 CFF 表字节
 * @param subsetGids 子集字形原始 gid 顺序（含 0 = .notdef，新 gid = 数组索引）
 * @returns 子集 CFF 字节；非 CID 或不支持的结构返回 null（调用方降级）
 */
export function subsetCFF(cffBytes: Uint8Array, subsetGids: number[]): Uint8Array | null {
  const b = cffBytes;

  /** Header: major(1) minor(1) hdrSize(1) offSize(1) */
  const hdrSize = b[2];
  /** Name INDEX 紧接 Header */
  /** Name INDEX 仅需字节范围（透传 headerName）+ end（Top DICT INDEX 起始），不全量解析 offset */
  const nameRange = indexByteRange(b, hdrSize);
  /** Top DICT INDEX 紧接 Name INDEX */
  const topDictIndex = readIndex(b, nameRange.end);
  if (topDictIndex.count < 1) return null;

  /** Top DICT 数据 */
  const topDictDataStart = topDictIndex.dataStart + topDictIndex.offsets[0] - 1;
  const topDictDataEnd = topDictIndex.dataStart + topDictIndex.offsets[1] - 1;
  const topDict = parseDict(b, topDictDataStart, topDictDataEnd);

  /** 非 CID 字体（无 ROS）走 name-keyed 结构，当前不支持 */
  if (!topDict.has(OP_ROS)) return null;

  /** String INDEX 紧接 Top DICT INDEX；Global Subr INDEX 紧接其后。
   *  两者仅需字节范围透传 + end（下一 INDEX 起始），不全量解析 offset。 */
  const stringRange = indexByteRange(b, topDictIndex.end);
  const globalSubrRange = indexByteRange(b, stringRange.end);

  /** Top DICT 中各结构表的绝对偏移（相对 CFF 起始） */
  const charStringsOff = topDict.get(OP_charStrings)?.[0];
  const charsetOff = topDict.get(OP_charset)?.[0];
  const fdArrayOff = topDict.get(OP_FDArray)?.[0];
  const fdSelectOff = topDict.get(OP_FDSelect)?.[0];
  if (charStringsOff === undefined || charsetOff === undefined || fdArrayOff === undefined || fdSelectOff === undefined) {
    return null;
  }

  /** CharStrings INDEX 头部（count + offSize），不全量解析 65535 个 offset（思源等大字体会浪费 0.4ms）。
   *  子集只需 newSubsetGids 对应的字节区间，按 gid 随机读 offset 即可。 */
  const csCount = (b[charStringsOff] << 8) | b[charStringsOff + 1];
  const csOffSize = b[charStringsOff + 2];
  /** offset 数组起始（紧跟 count+offSize 3 字节）；dataStart = 偏移数组尾 + 1 */
  const csOffArrStart = charStringsOff + 3;
  const csDataStart = csOffArrStart + (csCount + 1) * csOffSize;
  if (subsetGids.length === 0) return null;

  /** .notdef（gid 0）必须保留，且 subsetGids[0] 应为 0 */
  const newSubsetGids = subsetGids[0] === 0 ? subsetGids : [0, ...subsetGids];

  /** 先记录每个子集字形在原 CharStrings 的字节区间 [start, end)，供后续 subr 子集化重写。 */
  const newSubsetNumGlyphs = newSubsetGids.length;
  const charStringRanges: { start: number; end: number }[] = new Array(newSubsetNumGlyphs);
  for (let gi = 0; gi < newSubsetNumGlyphs; gi++) {
    const gid = newSubsetGids[gi];
    /** 读 offset[gid] 与 offset[gid+1]（offSize 字节大端） */
    let o0 = 0;
    let o1 = 0;
    const p0 = csOffArrStart + gid * csOffSize;
    const p1 = csOffArrStart + (gid + 1) * csOffSize;
    for (let j = 0; j < csOffSize; j++) o0 = (o0 << 8) | b[p0 + j];
    for (let j = 0; j < csOffSize; j++) o1 = (o1 << 8) | b[p1 + j];
    charStringRanges[gi] = { start: csDataStart + o0 - 1, end: csDataStart + o1 - 1 };
  }

  /** 重建 charset：CID-keyed 字体的 charset 是 gid→CID 映射。格式 0/1/2，按 newSubsetGids 取 CID。
   *  CID 0 固定留给 .notdef（gid 0），其余按原 charset 顺序。新 charset 用格式 0 最简单：
   *  format(1) + (numGlyphs-1)×CID(u16)（charset 不含 gid 0，它隐式为 CID 0）。
   *  按需查 CID（lookupCharsetCID 遍历 range 查单个 gid），不全量展开 65535 项。 */
  const newCharsetBody: number[] = [];
  for (let i = 1; i < newSubsetNumGlyphs; i++) {
    /** newSubsetGids[i] 是原始 gid，取其原 CID */
    newCharsetBody.push(lookupCharsetCID(b, charsetOff, newSubsetGids[i]));
  }
  const newCharset = encodeCharsetFormat0(newCharsetBody);

  /** FDSelect：按需查每个 subsetGid 的原 FD（lookupFDSelect 二分 range），不全量展开 numGlyphs。
   *  单次遍历同时构建：原FD→新FD 映射（fdRemap/usedFds）+ 每 gid 的原 FD 数组（gidOrigFds），
   *  后者供 newGidToFd 直接复用，避免对 newSubsetGids 第二次 lookupFDSelect 遍历。 */
  const fdRemap = new Map<number, number>();
  const usedFds: number[] = [];
  const gidOrigFds: number[] = new Array(newSubsetNumGlyphs);
  for (let i = 0; i < newSubsetNumGlyphs; i++) {
    const gid = newSubsetGids[i];
    const fd = lookupFDSelect(b, fdSelectOff, gid);
    gidOrigFds[i] = fd;
    if (!fdRemap.has(fd)) {
      fdRemap.set(fd, usedFds.length);
      usedFds.push(fd);
    }
  }

  /** 重建 FDArray：解析各命中 FD 的 DICT，patch 其 Private [len, offset] 指向新 Private 段。
   *  Private 数据本身透传（仅重定位 offset）。若 Private 声明了 Local Subr INDEX（op 19），
   *  必须把该 INDEX 字节一并透传到新 Private 段之后，并 patch op 19 指向新相对偏移——
   *  否则子集 op 19 指向越界/错位，OTS 解析 Local Subr 失败致 "Failed to parse Top DICT Data"。
   *  charstring 的 callsubr 按 subr 编号 + bias 索引，透传 INDEX 内容后调用仍有效。 */
  const fdArrayIndex = readIndex(b, fdArrayOff);
  /** 每个 usedFd 对应的 (FD DICT 原字节, Private 信息) */
  interface PrivInfo {
    /** Private 段在原 CFF 的绝对偏移（-1 表示无 Private） */
    origOff: number;
    /** Private 段长度（仅 DICT 字节，不含 Local Subr INDEX） */
    len: number;
    /** Local Subr INDEX 原始字节（无则 null）。思源等 CID 字体字形通过 callsubr 引用本地 subr */
    localSubr: Uint8Array | null;
    /** Local Subr INDEX 轻量头部（按需读 offset），供引用收集与重建；null 表示无 local subr */
    localSubrIdx: IndexHeader | null;
    /** 原 local subr bias（localSubrIdx.count 决定） */
    localBias: number;
    /** 子集 local subr 旧索引→新索引映射（引用收集后填充）；null 表示无需重映射（无 subr 或全保留） */
    localRemap: Map<number, number> | null;
    /** 子集后 local subr 总数 */
    newLocalCount: number;
    /** 子集 local subr INDEX 字节（重建后；无 subr 为 null）。最终拼入 Private 段 */
    newLocalSubr: Uint8Array | null;
  }
  interface FdInfo { dictBytes: Uint8Array; priv: PrivInfo; }
  /** 原始 Private 段去重：相同 origOff 的 Private 共享同一份（含其 Local Subr） */
  const privSegCache = new Map<number, PrivInfo>();
  /** 每个 unique Private 池（按 privOrigOff）收集的 local subr 引用集（多 FD 共享一池时合并） */
  const privLocalRefs = new Map<number, Set<number>>();
  /** global subr 不子集化，collectSubrRefs 的 gsubrRefs 参数占位（引用不收集） */
  const dummyGsubrRefs = new Set<number>();
  const fdInfos: FdInfo[] = [];
  for (const fd of usedFds) {
    const s = fdArrayIndex.dataStart + fdArrayIndex.offsets[fd] - 1;
    const e = fdArrayIndex.dataStart + fdArrayIndex.offsets[fd + 1] - 1;
    const dictBytes = b.subarray(s, e);
    const fdDict = parseDict(b, s, e);
    const priv = fdDict.get(OP_Private);
    /** 无 Private 的 FD（极罕见）原样透传 */
    if (!priv || priv.length < 2) {
      fdInfos.push({ dictBytes, priv: { origOff: -1, len: 0, localSubr: null, localSubrIdx: null, localBias: 0, localRemap: null, newLocalCount: 0, newLocalSubr: null } });
      continue;
    }
    const privLen = priv[0];
    const privOrigOff = priv[1];
    let info = privSegCache.get(privOrigOff);
    if (!info) {
      /** 解析 Private DICT，查 op 19（Local Subr INDEX 相对 Private 起始的偏移） */
      const privDict = parseDict(b, privOrigOff, privOrigOff + privLen);
      const subrRel = privDict.get(OP_LocalSubr)?.[0];
      let localSubr: Uint8Array | null = null;
      let localSubrIdx: IndexHeader | null = null;
      let localBias = 0;
      if (subrRel !== undefined) {
        /** Local Subr INDEX 紧接 Private DICT 字节之后（绝对偏移 = privOrigOff + subrRel） */
        const subrAbs = privOrigOff + subrRel;
        /** 轻量头部：只读 count/offSize/dataStart，不解析 (count+1) 个 offset。
         *  引用收集/重建只按 subr 编号读个别 offset（思源 26550 subr 仅引用十几个），
         *  全量 readIndex 占 subsetCFF 一半耗时，按需读消除之。 */
        localSubrIdx = readIndexHeader(b, subrAbs);
        localBias = subrBias(localSubrIdx.count);
        localSubr = b.subarray(localSubrIdx.start, localSubrIdx.end);
      }
      info = { origOff: privOrigOff, len: privLen, localSubr, localSubrIdx, localBias, localRemap: null, newLocalCount: localSubrIdx ? localSubrIdx.count : 0, newLocalSubr: localSubr };
      privSegCache.set(privOrigOff, info);
      privLocalRefs.set(privOrigOff, new Set());
    }
    fdInfos.push({ dictBytes, priv: info });
    /** 收集该 FD 所有子集字形的 local subr 引用到其 Private 池的引用集 */
    const refs = privLocalRefs.get(info.origOff)!;
    if (info.localSubrIdx) {
      const idx = info.localSubrIdx;
      for (let i = 0; i < newSubsetNumGlyphs; i++) {
        if (gidOrigFds[i] !== fd) continue;
        const r = charStringRanges[i];
        collectSubrRefs(b, r.start, r.end, info.localBias, idx.count, refs, dummyGsubrRefs);
      }
    }
  }

  /** 递归收敛：被引用的 local subr 可能再引用其他 local subr，迭代至不动点。
   *  （global subr 不子集化，故不收集 gsubr 引用；collectSubrRefs 的 gsubrRefs 占位用 dummyGsubrRefs） */
  if (privLocalRefs.size > 0) {
    let changed = true;
    let guard = 0;
    while (changed && guard < 64) {
      changed = false;
      guard++;
      for (const [privOrigOff, refs] of privLocalRefs) {
        const info = privSegCache.get(privOrigOff)!;
        const idx = info.localSubrIdx;
        if (!idx) continue;
        const before = refs.size;
        for (const sn of [...refs]) {
          /** 按需读 offset（避免全量解析 INDEX） */
          const ss = idx.dataStart + readIndexOffset(b, idx, sn) - 1;
          const se = idx.dataStart + readIndexOffset(b, idx, sn + 1) - 1;
          collectSubrRefs(b, ss, se, info.localBias, idx.count, refs, dummyGsubrRefs);
        }
        if (refs.size > before) changed = true;
      }
    }
  }

  /** 各 Private 池：构建旧→新 local subr 映射 + 重建子集 INDEX。引用为空则保留空 INDEX。 */
  for (const [privOrigOff, refs] of privLocalRefs) {
    const info = privSegCache.get(privOrigOff)!;
    const idx = info.localSubrIdx;
    if (!idx) continue;
    const sortedRefs = [...refs].sort((a, c) => a - c);
    const remap = new Map<number, number>();
    for (let i = 0; i < sortedRefs.length; i++) remap.set(sortedRefs[i], i);
    info.localRemap = remap;
    info.newLocalCount = sortedRefs.length;
    if (sortedRefs.length === 0) {
      /** 无引用：输出空 INDEX（count=0，2 字节），newLocalSubr 占位（下方 patchPrivateDict 后拼入） */
      info.newLocalSubr = new Uint8Array(2);
    } else {
      /** 重建 INDEX：按新顺序写出被引用的 subr 字节。subr 内部 callsubr 也需重映射（递归 patch） */
      const objects: { bytes: Uint8Array; start: number; len: number }[] = [];
      for (const oldSn of sortedRefs) {
        /** 按需读 offset（避免全量解析 INDEX） */
        const ss = idx.dataStart + readIndexOffset(b, idx, oldSn) - 1;
        const se = idx.dataStart + readIndexOffset(b, idx, oldSn + 1) - 1;
        const rewritten = rewriteCharstring(b, ss, se, info.localBias, remap, sortedRefs.length);
        objects.push({ bytes: rewritten, start: 0, len: rewritten.length });
      }
      info.newLocalSubr = writeIndex(objects);
    }
  }

  /** 重建 CharStrings INDEX：按 newSubsetGids 顺序输出 charstring。
   *  所属 FD 有 local subr 子集化时，patch callsubr operand（重映射到新 subr 编号 - 新 bias）；
   *  否则透传原 charstring 字节。global subr 不子集化，callgsubr operand 原样保留。 */
  const newCharStringObjects: { bytes: Uint8Array; start: number; len: number }[] = [];
  for (let gi = 0; gi < newSubsetNumGlyphs; gi++) {
    const r = charStringRanges[gi];
    const origFd = gidOrigFds[gi];
    /** 该 gid 所属原 FD 对应的 Private 信息（经 privSegCache 去重，按 privOrigOff 查） */
    let privInfo: PrivInfo | null = null;
    /** usedFds 顺序与 fdInfos 一致，反查 origFd→privInfo */
    for (let fi = 0; fi < usedFds.length; fi++) {
      if (usedFds[fi] === origFd) { privInfo = fdInfos[fi].priv; break; }
    }
    if (privInfo && privInfo.localRemap) {
      const rewritten = rewriteCharstring(b, r.start, r.end, privInfo.localBias, privInfo.localRemap, privInfo.newLocalCount);
      newCharStringObjects.push({ bytes: rewritten, start: 0, len: rewritten.length });
    } else {
      newCharStringObjects.push({ bytes: b, start: r.start, len: r.end - r.start });
    }
  }
  const newCharStrings = writeIndex(newCharStringObjects);

  /** 新 FDSelect：每个新 gid → 新 FD 编号（复用首次遍历的 gidOrigFds，无需第二次 lookupFDSelect）。
   *  单 FD 用格式 0（最省，1+numGlyphs 字节）；多 FD 用格式 3 ranges（与原始 CID 字体一致，兼容 OTS 严格校验）。 */
  const newGidToFd: number[] = new Array(newSubsetNumGlyphs);
  for (let i = 0; i < newSubsetNumGlyphs; i++) {
    newGidToFd[i] = fdRemap.get(gidOrigFds[i]) ?? 0;
  }
  const newFdSelectBody = encodeFDSelect(newGidToFd);

  /** 组装新 CFF：Header + Name INDEX + Top DICT INDEX + String INDEX + Global Subr INDEX
   *  + charset + charStrings + FDArray + FDSelect + Private 段。
   *  Top DICT 的四个 offset 须 patch 为新位置。 */
  const headerNameBytes = combineBytes([b.subarray(0, hdrSize), b.subarray(nameRange.start, nameRange.end)]);
  const stringSeg = b.subarray(stringRange.start, stringRange.end);
  const globalSubrSeg = b.subarray(globalSubrRange.start, globalSubrRange.end);

  /** Top DICT 原始字节（待 patch offset 后替换） */
  const topDictBytes = b.subarray(topDictDataStart, topDictDataEnd);

  /** 新结构段（FDArray 段依赖 patch，迭代中确定） */
  const charsetSeg = newCharset;
  const charStringsSeg = newCharStrings;
  const fdSelectSeg = newFdSelectBody;

  /** 联合迭代收敛 Top DICT patch + FD DICT patch + Private op19 patch（三者长度互相影响后续偏移）。
   *  结构：headerName + TopDICT INDEX + String INDEX + GlobalSubr INDEX + charset + charStrings
   *  + FDArray INDEX + FDSelect + Private 段（每段 = Private DICT + 其 Local Subr INDEX）。 */
  let topDictLen = topDictDataEnd - topDictDataStart;
  let fdArrayTotalLen = 0;
  /** 去重后的唯一 Private 段（按首次出现顺序），用于计算偏移与最终拼接 */
  const uniquePrivInfos: PrivInfo[] = [];
  const privOrigToUniqueIdx = new Map<number, number>();
  for (const info of fdInfos) {
    if (info.priv.origOff >= 0 && !privOrigToUniqueIdx.has(info.priv.origOff)) {
      privOrigToUniqueIdx.set(info.priv.origOff, uniquePrivInfos.length);
      uniquePrivInfos.push(info.priv);
    }
  }
  /** 各唯一 Private 段 patch 后的 DICT 字节 + op19 新值（迭代收敛，op19 = patchedDICT.length） */
  let patchedPrivSegs: { dict: Uint8Array; subr: Uint8Array | null }[] = [];
  let privSegsTotalLen = 0;
  let patchedTopDict: Uint8Array = topDictBytes;
  let newFdArrayBytes: Uint8Array = new Uint8Array(0);
  for (let iter = 0; iter < 8; iter++) {
    /** 先 patch 各唯一 Private DICT：op19 指向新 DICT 长度（Local Subr 紧跟其后） */
    const curPatchedPriv: { dict: Uint8Array; subr: Uint8Array | null }[] = [];
    for (const pi of uniquePrivInfos) {
      const patchedPriv = patchPrivateDict(b, pi.origOff, pi.len, pi.newLocalSubr !== null);
      curPatchedPriv.push({ dict: patchedPriv, subr: pi.newLocalSubr });
    }
    /** patched 私有段总长（含各自 Local Subr） */
    let curPrivTotal = 0;
    for (const pp of curPatchedPriv) {
      curPrivTotal += pp.dict.length;
      if (pp.subr) curPrivTotal += pp.subr.length;
    }

    /** Top DICT INDEX 总长 = count(2)+offSize(1)+(count+1)*offSize + topDictLen，count=1 */
    const tdOffSize = patchedTopDictOffSize(topDictLen + 1);
    const tdIdxTotalLen = 2 + 1 + 2 * tdOffSize + topDictLen;
    const stringOff = headerNameBytes.length + tdIdxTotalLen;
    const gsubrOff = stringOff + stringSeg.length;
    const charsetOff = gsubrOff + globalSubrSeg.length;
    const charStringsOff = charsetOff + charsetSeg.length;
    const fdArrayOff = charStringsOff + charStringsSeg.length;
    const fdSelectOff = fdArrayOff + fdArrayTotalLen;
    const privateOff = fdSelectOff + fdSelectSeg.length;

    /** 各唯一 Private 段在新 CFF 中的绝对偏移（顺序拼接，起始 privateOff） */
    let pAcc = privateOff;
    const origToNewPrivOff = new Map<number, number>();
    for (const [origOff, uid] of privOrigToUniqueIdx) {
      origToNewPrivOff.set(origOff, pAcc);
      pAcc += curPatchedPriv[uid].dict.length;
      if (curPatchedPriv[uid].subr) pAcc += curPatchedPriv[uid].subr!.length;
    }
    /** patch FD DICT 的 Private [len, offset]：len = patchedDICT 长度（不含 Local Subr），
     *  offset = 新 Private 绝对偏移。CFF 规范 Private len 是 DICT 字节长度，Local Subr 在其外。 */
    const patchedFdObjects: { bytes: Uint8Array; start: number; len: number }[] = [];
    for (const info of fdInfos) {
      if (info.priv.origOff < 0) {
        patchedFdObjects.push({ bytes: info.dictBytes, start: 0, len: info.dictBytes.length });
      } else {
        const uid = privOrigToUniqueIdx.get(info.priv.origOff)!;
        const newPrivOff = origToNewPrivOff.get(info.priv.origOff)!;
        const newPrivLen = curPatchedPriv[uid].dict.length;
        const patched = patchFdDictPrivate(info.dictBytes, newPrivLen, newPrivOff);
        patchedFdObjects.push({ bytes: patched, start: 0, len: patched.length });
      }
    }
    const candidateFdArray = writeIndex(patchedFdObjects);

    /** patch Top DICT */
    const candidateTopDict = replaceDictOffsets(topDictBytes, new Map<number, number>([
      [OP_charset, charsetOff],
      [OP_charStrings, charStringsOff],
      [OP_FDArray, fdArrayOff],
      [OP_FDSelect, fdSelectOff],
    ]));

    /** 收敛判定：topDictLen、fdArrayTotalLen、privSegsTotalLen 三者都不变 */
    const tdConverged = candidateTopDict.length === topDictLen;
    const fdConverged = candidateFdArray.length === fdArrayTotalLen;
    const privConverged = curPrivTotal === privSegsTotalLen;
    patchedTopDict = candidateTopDict;
    newFdArrayBytes = candidateFdArray;
    patchedPrivSegs = curPatchedPriv;
    topDictLen = candidateTopDict.length;
    fdArrayTotalLen = candidateFdArray.length;
    privSegsTotalLen = curPrivTotal;
    if (tdConverged && fdConverged && privConverged) break;
  }

  /** 组装 Top DICT INDEX：count=1 */
  const newTopDictIndex = writeIndex([{ bytes: patchedTopDict, start: 0, len: patchedTopDict.length }]);

  /** 拼接所有 Private 段（每段 = patched DICT + Local Subr INDEX） */
  const privParts: Uint8Array[] = [];
  for (const pp of patchedPrivSegs) {
    privParts.push(pp.dict);
    if (pp.subr) privParts.push(pp.subr);
  }
  const newPrivateSeg = combineBytes(privParts);

  /** 最终拼接：Header+Name + TopDICT INDEX + String INDEX + GlobalSubr INDEX + charset + charStrings
   *  + FDArray INDEX + FDSelect + Private 段 */
  return combineBytes([headerNameBytes, newTopDictIndex, stringSeg, globalSubrSeg, charsetSeg, charStringsSeg, newFdArrayBytes, fdSelectSeg, newPrivateSeg]);
}

/** 计算 Top DICT INDEX 的 offSize（容纳 topDictDataLen+1 的最小字节数，1~4） */
function patchedTopDictOffSize(maxOffset: number): number {
  if (maxOffset > 0xffff) return 4;
  if (maxOffset > 0xff) return 2;
  return 1;
}

/**
 * patch FD DICT 的 Private 操作数 [length, offset]。
 * 扫描 DICT 定位操作码 18（Private），将其前的两个操作数替换为新编码 [privLen, newPrivOff]。
 * 其余操作码字节原样保留。
 * @param dictBytes 原 FD DICT 字节
 * @param privLen Private DICT 字节长度（不含 Local Subr INDEX）
 * @param newPrivOff Private 在新 CFF 中的绝对偏移
 */
function patchFdDictPrivate(dictBytes: Uint8Array, privLen: number, newPrivOff: number): Uint8Array {
  /** 按操作码分段，找到 Private（18）替换其两个操作数 */
  const chunks: Uint8Array[] = [];
  let p = 0;
  let operandStart = 0;
  const len = dictBytes.length;
  while (p < len) {
    const b0 = dictBytes[p++];
    if (b0 <= 21) {
      let op = b0;
      if (b0 === 12) op = (12 << 8) | dictBytes[p++];
      if (op === OP_Private) {
        /** 替换：编码 [privLen, newPrivOff] + 操作码 18 */
        const enc1 = encodeDictInt(privLen);
        const enc2 = encodeDictInt(newPrivOff);
        const combined = new Uint8Array(enc1.length + enc2.length + 1);
        combined.set(enc1, 0);
        combined.set(enc2, enc1.length);
        combined[enc1.length + enc2.length] = 18;
        chunks.push(combined);
      } else {
        /** 保留原操作数 + 操作码 */
        chunks.push(dictBytes.subarray(operandStart, p));
      }
      operandStart = p;
    } else if (b0 === 28) {
      p += 2;
    } else if (b0 === 29) {
      p += 4;
    } else if (b0 >= 247 && b0 <= 254) {
      p += 1;
    }
  }
  return combineBytes(chunks);
}

/**
 * patch Private DICT 的 Local Subr 操作数（op 19），使其指向新 DICT 长度。
 * Local Subr INDEX 紧跟 Private DICT 字节之后，故 op 19 新值 = patched DICT 的最终长度。
 * 由于 op 19 编码长度会随值变化（影响 DICT 总长），用小迭代收敛：先用旧值估长，重 patch 至稳定。
 * 无 Local Subr（hasSubr=false）的 Private 原样返回。
 * @param b 原 CFF 字节
 * @param privOrigOff Private DICT 在原 CFF 的绝对偏移
 * @param privLen Private DICT 字节长度
 * @param hasSubr 是否含 Local Subr INDEX（op 19）
 */
function patchPrivateDict(b: Uint8Array, privOrigOff: number, privLen: number, hasSubr: boolean): Uint8Array {
  /** 无 Local Subr：DICT 原样透传（offset 不需改，Private 内无跨段引用） */
  if (!hasSubr) return b.subarray(privOrigOff, privOrigOff + privLen);
  /** 把 op 19 的操作数替换为 patchedDICT.length。迭代至 op19 编码长度稳定。 */
  let cur = b.subarray(privOrigOff, privOrigOff + privLen);
  for (let iter = 0; iter < 4; iter++) {
    const patched = replaceDictOffsets(cur, new Map<number, number>([[OP_LocalSubr, cur.length]]));
    if (patched.length === cur.length) return patched;
    cur = patched;
  }
  return cur;
}

/** 拼接多个字节切片 */
function combineBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * 按需查询单个原始 gid 的 CID（替代全量 readCharsetCIDs）。
 * 子集只需 newSubsetGids 对应的 CID，全量展开 numGlyphs(思源 65535) 是浪费。
 * gid 0 的 CID 固定为 0（.notdef 不入表）。
 * 格式 0：format(1) + (numGlyphs-1)×CID(u16)，按 gid 直接取（charset 表不含 gid 0）。
 * 格式 1/2：遍历 range 找覆盖 gid 的（range first 是 gid，CID = first 的 CID + (gid - range.first)）。
 *  range 数量远小于 numGlyphs（思源 format2 约 6 千 range vs 65535 gid），遍历省去 65535 项填充。
 * @param b CFF 字节
 * @param charsetOff charset 起始偏移
 * @param gid 原始 gid（>0，gid 0 调用方自行返回 0）
 */
function lookupCharsetCID(b: Uint8Array, charsetOff: number, gid: number): number {
  if (gid === 0) return 0;
  const fmt = b[charsetOff];
  /** 格式 0：format(1) + (numGlyphs-1)×CID(u16) 紧排，gid i(>0) 的 CID 在 (i-1)*2 */
  if (fmt === 0) {
    const o = charsetOff + 1 + (gid - 1) * 2;
    return (b[o] << 8) | b[o + 1];
  }
  /** 格式 1/2：range[ firstCID, nLeft ]，range 依次覆盖连续 gid（从 gid 1 起），
   *  range 内 nLeft+1 个 gid 的 CID = firstCID + 偏移。遍历累积 gid 起点找覆盖 gid 的 range。
   *  range 数远小于 numGlyphs（思源 format2 约 6 千 range vs 65535 gid），省去 65535 项填充。 */
  let p = charsetOff + 1;
  let rangeFirstGid = 1;
  if (fmt === 1) {
    for (;;) {
      const firstCID = (b[p] << 8) | b[p + 1];
      const nLeft = b[p + 2];
      if (gid >= rangeFirstGid && gid <= rangeFirstGid + nLeft) return firstCID + (gid - rangeFirstGid);
      rangeFirstGid += nLeft + 1;
      p += 3;
    }
  }
  /** fmt === 2 */
  for (;;) {
    const firstCID = (b[p] << 8) | b[p + 1];
    const nLeft = (b[p + 2] << 8) | b[p + 3];
    if (gid >= rangeFirstGid && gid <= rangeFirstGid + nLeft) return firstCID + (gid - rangeFirstGid);
    rangeFirstGid += nLeft + 1;
    p += 4;
  }
}

/** 编码 charset 格式 0：format(1) + CIDs.length×CID(u16) */
function encodeCharsetFormat0(cids: number[]): Uint8Array {
  const out = new Uint8Array(1 + cids.length * 2);
  out[0] = 0;
  for (let i = 0; i < cids.length; i++) {
    out[1 + i * 2] = (cids[i] >> 8) & 0xff;
    out[1 + i * 2 + 1] = cids[i] & 0xff;
  }
  return out;
}

/**
 * patch Top DICT 的 charset / charStrings / FDArray / FDSelect offset。
 * 由于 patch 后 DICT 长度变化会改变后续段偏移，采用迭代：先用原 DICT 长度算首版偏移，
 * 编码 patch 后若长度变化则重算。实测整数 offset 长度稳定（多数 3 字节），1~2 轮收敛。
 *
 * @param topDictBytes 原 Top DICT 字节
 * @param newTopDictDataOff 新 Top DICT 数据起始偏移（相对新 CFF）
 * @param origTopDictLen 原 Top DICT 数据长度
 * @param charsetSeg / charStringsSeg / fdArraySeg / fdSelectSeg 各段字节（顺序紧跟 Top DICT INDEX）
 */
/**
 * 替换 DICT 中多个操作码的操作数（offset 值）。
 * 扫描原 DICT，对每个待替换操作码：跳过旧操作数，写入新编码操作数 + 操作码；其余字节原样保留。
 * @param dictBytes 原 DICT 字节
 * @param replacements 操作码键 → 新 offset 值
 */
function replaceDictOffsets(dictBytes: Uint8Array, replacements: Map<number, number>): Uint8Array {
  /**
   * 优化：预分配 Uint8Array + 写指针 wp 替代 chunks: number[][] + Array.from + 二次拼接。
   *  原 chunks 方案每个操作码段分配一个 number[]（含 Array.from 拷贝 + spread 再拷贝），
   *  最后还要两轮遍历拼接。Uint8Array 直接顺序写入，零中间数组。
   *  容量上界：原 DICT 长度 + 每个替换 operand 最大 +4 字节（短编码→长编码）。
   */
  const cap = dictBytes.length + replacements.size * 4 + 16;
  const out = new Uint8Array(cap);
  let wp = 0;
  let p = 0;
  let operandStart = 0;
  const len = dictBytes.length;
  while (p < len) {
    const b0 = dictBytes[p++];
    if (b0 <= 21) {
      let op = b0;
      if (b0 === 12) op = (12 << 8) | dictBytes[p++];
      if (replacements.has(op)) {
        /** 替换：写入新编码操作数 + 操作码（内联 encodeDictInt 避免 number[] 分配） */
        const newVal = replacements.get(op)!;
        if (newVal >= -107 && newVal <= 107) {
          out[wp++] = newVal + 139;
        } else if (newVal >= 108 && newVal <= 1131) {
          const v0 = newVal - 108;
          out[wp] = 247 + (v0 >> 8); out[wp + 1] = v0 & 0xff;
          wp += 2;
        } else if (newVal >= -1131 && newVal <= -108) {
          const v0 = -newVal - 108;
          out[wp] = 251 + (v0 >> 8); out[wp + 1] = v0 & 0xff;
          wp += 2;
        } else if (newVal >= -32768 && newVal <= 32767) {
          out[wp] = 28; out[wp + 1] = (newVal >> 8) & 0xff; out[wp + 2] = newVal & 0xff;
          wp += 3;
        } else {
          out[wp] = 29; out[wp + 1] = (newVal >>> 24) & 0xff; out[wp + 2] = (newVal >> 16) & 0xff; out[wp + 3] = (newVal >> 8) & 0xff; out[wp + 4] = newVal & 0xff;
          wp += 5;
        }
        if (op >= 256) {
          out[wp] = 12; out[wp + 1] = op & 0xff;
          wp += 2;
        } else {
          out[wp++] = op;
        }
      } else {
        /** 保留原操作数 + 操作码（operandStart..p 原样拷贝） */
        out.set(dictBytes.subarray(operandStart, p), wp);
        wp += p - operandStart;
      }
      operandStart = p;
    } else if (b0 === 28) {
      p += 2;
    } else if (b0 === 29) {
      p += 4;
    } else if (b0 === 30) {
      /** BCD 实数：每字节两 nibble，遇 0xf 结束。必须完整跳过，否则 BCD 内 <=21 的字节
       *  会被误判为 operator 致 operator 边界错乱（Top DICT 的 CIDFontVersion 等用 BCD）。 */
      while (p < len) {
        const byte = dictBytes[p++];
        if ((byte >> 4) === 0xf || (byte & 0xf) === 0xf) break;
      }
    } else if (b0 >= 247 && b0 <= 254) {
      p += 1;
    }
    /** 32~246 单字节，无后续 */
  }
  return out.subarray(0, wp);
}
