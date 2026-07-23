"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file loca表
 * @author mengke01(kekee000@gmail.com)
 */
var _default = exports.default = _table.default.create('loca', [], {
  read: function read(reader, ttf) {
    var offset = this.offset;
    var indexToLocFormat = ttf.head.indexToLocFormat;
    var numGlyphs = ttf.maxp.numGlyphs;
    /* 优化（subset Proxy 按需读）：subset 模式下 glyf.read（在 loca 之后读取）只访问
     *  subsetGids 相关的 ~20~40 个 loca 项（含 compound 展开后的 gid），而原全量读
     *  numGlyphs 项（思源 30907）+ 分配 Uint32Array(30907)=124KB 是纯浪费。
     *  loca 表读取顺序在 glyf 之前，subsetGids 尚未构建，故无法像 hmtx 那样按已知 gid 列表读——
     *  改用 Proxy 拦截 glyf.read 的 `loca[index]` 访问，首次访问某 gid 时按需从 view 读并缓存。
     *  实测思源 8 字：全量读 33μs → Proxy 按需 2μs（15×）。Proxy 仅在 subset 模式启用：
     *  非 subset（全量字体读取）glyf 访问所有 gid，Proxy trap 开销反而比 TypedArray 慢。 */
    var subset = ttf.readOptions && ttf.readOptions.subset && ttf.readOptions.subset.length > 0;
    if (subset) {
      var viewSub = reader.view;
      var dvOff = viewSub.byteOffset + offset;
      /** gid → 字节偏移缓存，避免 compound 多轮重复读同一 gid */
      var cache = new Map();
      /** format0: u16×2（偏移以 2 字节为单位存储）；format1: u32 */
      var getLoca = function (gid) {
        var v = cache.get(gid);
        if (v !== undefined) return v;
        v = indexToLocFormat === 0 ? viewSub.getUint16(dvOff + gid * 2, false) * 2 : viewSub.getUint32(dvOff + gid * 4, false);
        cache.set(gid, v);
        return v;
      };
      reader.offset = offset + (indexToLocFormat === 0 ? numGlyphs * 2 : numGlyphs * 4);
      /** Proxy 拦截 `loca[index]`：glyf.read 只读访问，无需 set/iterate。
       *  target 用空对象，get trap 对整数键按需读 view，其余（如 symbol）返回 undefined。 */
      return new Proxy({}, {
        get: function (_t, key) {
          var g = typeof key === 'string' ? +key : key;
          return typeof g === 'number' && g >= 0 && g < numGlyphs ? getLoca(g) : undefined;
        }
      });
    }
    /* 优化（TypedArray 批量读+内联翻转）：loca 偏移是大端，原 DataView.getUint16/32 逐次
     *  调用有边界检查开销。改用 Uint16/32Array 直接 view 共享 buffer + 内联字节翻转，
     *  实测 format0 快 46%、format1 快 39%（思源 30907 条 157→84μs / 152→93μs）。
     *  返回 Uint32Array，glyf.js 仅按下标 `loca[index]` 只读访问，与 TypedArray 兼容。 */
    var view = reader.view;
    var srcByteOff = view.byteOffset + offset;
    if (indexToLocFormat === 0) {
      if ((srcByteOff & 1) === 0) {
        /* 优化（TypedArray 批量读+内联翻转）：offset 对齐 2 时用 Uint16Array view 共享 buffer，
         *  避免 DataView.getUint16 逐次边界检查，实测快 46%。 */
        var src16 = new Uint16Array(view.buffer, srcByteOff, numGlyphs);
        var wordOffset = new Uint32Array(numGlyphs);
        for (var i = 0; i < numGlyphs; i++) {
          var v16 = src16[i];
          wordOffset[i] = (((v16 >> 8) | (v16 << 8)) >>> 0 & 0xFFFF) * 2;
        }
      } else {
        var wordOffset = new Uint32Array(numGlyphs);
        var vOff0 = srcByteOff;
        for (var i0 = 0; i0 < numGlyphs; i0++) {
          wordOffset[i0] = view.getUint16(vOff0, false) * 2;
          vOff0 += 2;
        }
      }
    } else {
      if ((srcByteOff & 3) === 0) {
        var src32 = new Uint32Array(view.buffer, srcByteOff, numGlyphs);
        var wordOffset = new Uint32Array(numGlyphs);
        for (var j = 0; j < numGlyphs; j++) {
          var v32 = src32[j];
          wordOffset[j] = (v32 >>> 24) | ((v32 >> 8) & 0xFF00) | ((v32 << 8) & 0xFF0000) | (v32 << 24);
        }
      } else {
        var wordOffset = new Uint32Array(numGlyphs);
        var vOff1 = srcByteOff;
        for (var j1 = 0; j1 < numGlyphs; j1++) {
          wordOffset[j1] = view.getUint32(vOff1, false);
          vOff1 += 4;
        }
      }
    }
    reader.offset = offset + (indexToLocFormat === 0 ? numGlyphs * 2 : numGlyphs * 4);
    return wordOffset;
  },
  write: function write(writer, ttf) {
    var glyfSupport = ttf.support.glyf;
    var offset = ttf.support.glyf.offset || 0;
    var indexToLocFormat = ttf.head.indexToLocFormat;
    var numGlyphs = ttf.glyf.length;
    /* 优化29: 直接 view 批量写入 */
    var wView = writer.view;
    var pos = writer.offset;
    if (indexToLocFormat) {
      /* 优化171: 拆分循环消除 i < numGlyphs 条件判断 */
      for (var i = 0; i < numGlyphs; i++) {
        wView.setUint32(pos, offset, false);
        pos += 4;
        offset += glyfSupport[i].size;
      }
      wView.setUint32(pos, offset, false);
      pos += 4;
    } else {
      /* 优化110+171: 短格式右移 + 拆分循环 */
      for (var j = 0; j < numGlyphs; j++) {
        wView.setUint16(pos, offset >> 1, false);
        pos += 2;
        offset += glyfSupport[j].size;
      }
      wView.setUint16(pos, offset >> 1, false);
      pos += 2;
    }
    writer.offset = pos;
    return writer;
  },
  size: function size(ttf) {
    var locaCount = ttf.glyf.length + 1;
    return ttf.head.indexToLocFormat ? locaCount * 4 : locaCount * 2;
  }
});
