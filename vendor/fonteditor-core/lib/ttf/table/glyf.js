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
      for (var si = 0, sl = subset.length; si < sl; si++) {
        var gid = cmap[subset[si]];
        if (gid !== undefined && !subsetMap[gid]) {
          subsetMap[gid] = true;
          subsetGids.push(gid);
        }
      }
      ttf.subsetMap = subsetMap;
      ttf.subsetGids = subsetGids;
      var parsedGlyfMap = {};

      /* 优化43: for...in + for 循环替代 Object.keys + forEach */
      var travelsParse = function travels(sMap) {
        var newSubsetMap = {};
        for (var idx in sMap) {
          var index = +idx;
          parsedGlyfMap[index] = true;
          if (loca[index] === loca[index + 1]) {
            glyphs[index] = { contours: [] };
          } else {
            glyphs[index] = (0, _parse.default)(reader, ttf, startOffset + loca[index]);
          }
          if (glyphs[index].compound) {
            var glyfs = glyphs[index].glyfs;
            for (var gi = 0, gl = glyfs.length; gi < gl; gi++) {
              if (!parsedGlyfMap[glyfs[gi].glyphIndex]) {
                newSubsetMap[glyfs[gi].glyphIndex] = true;
              }
            }
          }
        }
        if (!(0, _lang.isEmptyObject)(newSubsetMap)) {
          travels(newSubsetMap);
        }
      };
      travelsParse(subsetMap);
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