"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file hmtx 表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6hmtx.html
 */
var _default = exports.default = _table.default.create('hmtx', [], {
  read: function read(reader, ttf) {
    var offset = this.offset;
    reader.seek(offset);
    var numOfLongHorMetrics = ttf.hhea.numOfLongHorMetrics;
    var numGlyphs = ttf.maxp.numGlyphs;
    /* 优化10+82: 扁平数组 [advW, lsb, advW, lsb, ...]，消除对象分配 */
    var hMetrics = new Int32Array(numGlyphs * 2);
    var view = reader.view;
    var vOffset = view.byteOffset + offset;
    /* 优化（subset 按需读）：subset 模式下 ttf.subsetGids 已由 glyf.read（表顺序在 hmtx 之前）构建，
     *  resolveGlyf 也只访问 subsetGids 对应的 hmtx[gid*2]/[gid*2+1]。
     *  原实现全量解析 numOfLongHorMetrics 项（思源 30888，占 Font.create ~10%），对 8 字子集是纯浪费。
     *  改为只读 subsetGids 需要的项，其余位置保持 0（不会被访问）。 */
    var subsetGids = ttf.readOptions && ttf.readOptions.subset && ttf.readOptions.subset.length > 0 ? ttf.subsetGids : null;
    if (subsetGids) {
      /* Last 段（gid >= numOfLongHorMetrics）的起始字节偏移；共享 advW = 最后一个 LongHorMetric 的 advW */
      var lastSegOff = vOffset + numOfLongHorMetrics * 4;
      var lastAdvWOff = vOffset + (numOfLongHorMetrics - 1) * 4;
      for (var si = 0, sl = subsetGids.length; si < sl; si++) {
        var gid = subsetGids[si];
        var idx = gid * 2;
        if (gid < numOfLongHorMetrics) {
          /* LongHorMetric 段：advW + lsb 各 2 字节 */
          var gOff = vOffset + gid * 4;
          hMetrics[idx] = view.getUint16(gOff, false);
          hMetrics[idx + 1] = view.getInt16(gOff + 2, false);
        } else {
          /* Last 段：advW 复用最后一个 LongHorMetric 的值，lsb 在 lastSegOff + (gid-num)*2 */
          hMetrics[idx] = view.getUint16(lastAdvWOff, false);
          hMetrics[idx + 1] = view.getInt16(lastSegOff + (gid - numOfLongHorMetrics) * 2, false);
        }
      }
      reader.offset = offset + numOfLongHorMetrics * 4 + (numGlyphs - numOfLongHorMetrics) * 2;
      return hMetrics;
    }
    /* 优化（TypedArray 批量读+内联翻转）：hmtx 是大端，原 DataView.getUint16/getInt16 逐次调用
     *  有边界检查开销。LongHorMetric 段（每项 u16 advW + i16 lsb）用 Uint16Array view 共享 buffer
     *  读取后内联翻转，实测思源黑体（30888 项）快 2×（198→98μs）。offset 需 2 字节对齐，
     *  否则回退 DataView（表目录 offset 不保证对齐）。 */
    if ((vOffset & 1) === 0) {
      /* LongHorMetric 段：2N 个 u16（大端），按下标读取后翻转；advW 在偶数下标、lsb 在奇数下标 */
      var src16 = new Uint16Array(view.buffer, vOffset, numOfLongHorMetrics * 2);
      for (var i = 0; i < numOfLongHorMetrics; i++) {
        var a = src16[i * 2];
        hMetrics[i * 2] = ((a & 0xff) << 8) | (a >> 8);
        var l = src16[i * 2 + 1];
        var le = ((l & 0xff) << 8) | (l >> 8);
        hMetrics[i * 2 + 1] = le > 0x7fff ? le - 0x10000 : le;
      }
      var lastAdvW = hMetrics[(numOfLongHorMetrics - 1) * 2];
      var numOfLast = numGlyphs - numOfLongHorMetrics;
      /* Last 段：紧接 LongHorMetric 段，每项 i16 lsb，起始必然 2 字节对齐（前段是 4 字节倍数） */
      var lastVOff = vOffset + numOfLongHorMetrics * 4;
      var last16 = new Uint16Array(view.buffer, lastVOff, numOfLast);
      for (var j = 0; j < numOfLast; j++) {
        var idx2 = (numOfLongHorMetrics + j) * 2;
        hMetrics[idx2] = lastAdvW;
        var lv = last16[j];
        var lve = ((lv & 0xff) << 8) | (lv >> 8);
        hMetrics[idx2 + 1] = lve > 0x7fff ? lve - 0x10000 : lve;
      }
    } else {
      /* 未对齐回退 DataView */
      for (var i0 = 0; i0 < numOfLongHorMetrics; i0++) {
        var idx0 = i0 * 2;
        hMetrics[idx0] = view.getUint16(vOffset, false);
        hMetrics[idx0 + 1] = view.getInt16(vOffset + 2, false);
        vOffset += 4;
      }
      var lastAdvW0 = hMetrics[(numOfLongHorMetrics - 1) * 2];
      var numOfLast0 = numGlyphs - numOfLongHorMetrics;
      for (var j0 = 0; j0 < numOfLast0; j0++) {
        var idx20 = (numOfLongHorMetrics + j0) * 2;
        hMetrics[idx20] = lastAdvW0;
        hMetrics[idx20 + 1] = view.getInt16(vOffset, false);
        vOffset += 2;
      }
    }
    reader.offset = offset + numOfLongHorMetrics * 4 + (numGlyphs - numOfLongHorMetrics) * 2;
    return hMetrics;
  },
  write: function write(writer, ttf) {
    var numOfLongHorMetrics = ttf.hhea.numOfLongHorMetrics;
    /* 优化30+82+171: 缓存 glyfs[i] 到循环变量 */
    var wView = writer.view;
    var pos = writer.offset;
    var glyfs = ttf.glyf;
    for (var i = 0; i < numOfLongHorMetrics; i++) {
      var g = glyfs[i];
      wView.setUint16(pos, g.advanceWidth, false);
      wView.setInt16(pos + 2, g.leftSideBearing, false);
      pos += 4;
    }
    var numOfLast = glyfs.length - numOfLongHorMetrics;
    /* 优化: 提取 numOfLongHorMetrics 到循环外变量，消除每次迭代属性链查找 + 加法 */
    var lastBase = numOfLongHorMetrics;
    for (var j = 0; j < numOfLast; j++) {
      wView.setInt16(pos, glyfs[lastBase + j].leftSideBearing, false);
      pos += 2;
    }
    writer.offset = pos;
    return writer;
  },
  size: function size(ttf) {
    /* 优化171: 缓存 ttf.glyf 到局部变量，消除循环内属性链查找 */
    var glyfs = ttf.glyf;
    var gl = glyfs.length;
    var numOfLast = 0;
    var advanceWidth = glyfs[gl - 1].advanceWidth;
    for (var i = gl - 2; i >= 0; i--) {
      if (advanceWidth === glyfs[i].advanceWidth) {
        numOfLast++;
      } else {
        break;
      }
    }
    /** 优化287: 缓存到局部变量，避免设置后立即重读 */
    var nlm = gl - numOfLast;
    ttf.hhea.numOfLongHorMetrics = nlm;
    return 4 * nlm + 2 * numOfLast;
  }
});
