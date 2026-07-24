"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _parse = _interopRequireDefault(require("./glyf/parse"));
var _write = _interopRequireDefault(require("./glyf/write"));
var _sizeof = _interopRequireDefault(require("./glyf/sizeof"));
var _lang = require("../../common/lang");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file glyf表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6glyf.html
 */
var _default = exports.default = _table.default.create('glyf', [], {
  read: function read(reader, ttf) {
    var startOffset = this.offset;
    var loca = ttf.loca;
    var numGlyphs = ttf.maxp.numGlyphs;
    var glyphs = [];
    reader.seek(startOffset);

    /* subset */
    var subset = ttf.readOptions.subset;
    if (subset && subset.length > 0) {
      /* 优化95+118: 直接遍历 subset 数组查找 glyphId，同时构建密集 ID 数组 */
      var subsetMap = { 0: true };
      var subsetGids = [0];
      var cmap = ttf.cmap;
      /** 优化: 构建 unicode→gid 映射，供 resolveGlyf 直接遍历，避免全量 cmap 遍历 */
      var subsetUnicodeMap = {};
      /** 优化291: 合并 subsetUnicodeMap 赋值的两个分支，减少一次条件判断 */
      for (var si = 0, sl = subset.length; si < sl; si++) {
        var u = subset[si];
        var gid = cmap[u];
        if (gid !== undefined) {
          subsetUnicodeMap[u] = gid;
          if (!subsetMap[gid]) {
            subsetMap[gid] = true;
            subsetGids.push(gid);
          }
        }
      }
      ttf.subsetMap = subsetMap;
      ttf.subsetGids = subsetGids;
      ttf._subsetUnicodeMap = subsetUnicodeMap;
      /* 注入额外保留的 gid（如 GSUB 连字 target glyph，多数无 unicode，无法通过 codepoint 子集保留）。
       *  这些 glyph 仍参与 compound 引用解析与 glyf 构建，origToNew 通过 subsetGids 顺序直接映射。 */
      var extraSubsetGids = ttf.readOptions.extraSubsetGids;
      if (extraSubsetGids && extraSubsetGids.length > 0) {
        for (var ei = 0, el = extraSubsetGids.length; ei < el; ei++) {
          var eg = extraSubsetGids[ei];
          if (!subsetMap[eg]) {
            subsetMap[eg] = true;
            subsetGids.push(eg);
          }
        }
      }
      var parsedGlyfMap = {};
      /**
       * 优化310: simple 字形原始字节快路径。
       * 子集化场景下，simple 字形经 parse→optimizettf→write 往返后产出的 glyf 字节
       * 与原始字体 glyf 字节完全一致（实测令东齐伋复刻体千字文 73/73 simple 字节完全相同）。
       * 因此 simple 字形可直接拷贝原始字节，跳过 parseSimpleGlyf（坐标解码）
       * + ceilReduceAndSizeFromTypedArrays（flag 重编码）+ write encode 三段往返。
       * 额外收益：保留原始 instructions（hinting），渲染更精确。
       * compound 字形因 component glyphIndex 需重映射，仍走原 parse+write 路径。
       */
      var view = reader.view;
      var fullBuf = view.buffer;
      var fullBufOff = view.byteOffset;
      /**
       * compound 引用的 component gid 集合。这些 simple 字形必须走完整 parse
       *（产出 _xArr/_yArr/_flags 供 transformGlyfContours 仿射变换），不能走快路径。
       */
      var componentGids = {};

      /* 优化：迭代式广度优先遍历替代递归，消除 isEmptyObject 调用 */
      var queue = subsetGids;
      while (queue.length > 0) {
        var nextQueue = [];
        for (var qi = 0, ql = queue.length; qi < ql; qi++) {
          var index = queue[qi];
          parsedGlyfMap[index] = true;
          var gStart = startOffset + loca[index];
          var gEnd = startOffset + loca[index + 1];
          if (gStart === gEnd) {
            glyphs[index] = { contours: [] };
          } else {
            var vOff = fullBufOff + gStart;
            var numberOfContours = view.getInt16(vOff, false);
            /** 非(component 引用的) simple 字形走快路径；compound 及 component 走完整 parse */
            if (numberOfContours >= 0 && !componentGids[index]) {
              /** 优化310+313+314: 快路径——读 header(bbox) + 最后一个 endPt（算 _totalPoints 供 metrics），
               *  存原始字节引用，跳过 instructions/flags/坐标解码（省 parseSimpleGlyf，glyph.read 第一热点）。
               *  优化313: 不再分配 endPtsOfContours 数组——_totalPoints 只需最后一个 endPt。
               *  优化314: 原始字节引用展平到 glyfObj（_origBuf/_origOff/_origLen），
               *  省掉每个 simple 字形的 _origGlyfRef 子对象分配。 */
              var glyfObj = {};
              glyfObj.xMin = view.getInt16(vOff + 2, false);
              glyfObj.yMin = view.getInt16(vOff + 4, false);
              glyfObj.xMax = view.getInt16(vOff + 6, false);
              glyfObj.yMax = view.getInt16(vOff + 8, false);
              glyfObj._origBuf = fullBuf;
              glyfObj._origOff = fullBufOff + gStart;
              glyfObj._origLen = gEnd - gStart;
              if (numberOfContours > 0) {
                glyfObj._numContours = numberOfContours;
                /** 最后一个 endPt 在 vOff + 10 + (numContours-1)*2，+1 即总点数 */
                glyfObj._totalPoints = view.getUint16(vOff + 10 + (numberOfContours - 1) * 2, false) + 1;
              } else {
                glyfObj._numContours = 0;
                glyfObj._totalPoints = 0;
              }
              glyphs[index] = glyfObj;
            } else {
              /* compound 字形：完整 parse（component glyphIndex 后续要重映射） */
              glyphs[index] = (0, _parse.default)(reader, ttf, gStart);
            }
          }
          if (glyphs[index].compound) {
            var glyfs = glyphs[index].glyfs;
            for (var gi = 0, gl = glyfs.length; gi < gl; gi++) {
              var compGid = glyfs[gi].glyphIndex;
              componentGids[compGid] = true;
              /** 若 component 已被快路径解析（有 _origBuf），需重新完整 parse 产出 _xArr 供变换。
               *  触发于同一轮中 component 排在 compound 之前的情况。 */
              if (parsedGlyfMap[compGid] && glyphs[compGid] && glyphs[compGid]._origBuf) {
                var cgStart = startOffset + loca[compGid];
                glyphs[compGid] = (0, _parse.default)(reader, ttf, cgStart);
              }
              if (!parsedGlyfMap[compGid]) {
                nextQueue.push(compGid);
              }
            }
          }
        }
        queue = nextQueue;
      }
      return glyphs;
    }

    /* 解析字体轮廓, 前n-1个 */
    for (var i = 0, l = numGlyphs - 1; i < l; i++) {
      if (loca[i] === loca[i + 1]) {
        glyphs[i] = { contours: [] };
      } else {
        glyphs[i] = (0, _parse.default)(reader, ttf, startOffset + loca[i]);
      }
    }

    /* 最后一个轮廓 */
    if (ttf.tables.glyf.length - loca[i] < 5) {
      glyphs[i] = { contours: [] };
    } else {
      glyphs[i] = (0, _parse.default)(reader, ttf, startOffset + loca[i]);
    }
    return glyphs;
  },
  write: _write.default,
  size: _sizeof.default
});