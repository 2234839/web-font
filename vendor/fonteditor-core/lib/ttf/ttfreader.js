"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _directory = _interopRequireDefault(require("./table/directory"));
var _support = _interopRequireDefault(require("./table/support"));
var _reader = _interopRequireDefault(require("./reader"));
var _postName = _interopRequireDefault(require("./enum/postName"));
var _error = _interopRequireDefault(require("./error"));
var _compound2simpleglyf = _interopRequireDefault(require("./util/compound2simpleglyf"));
var _post = require("./table/post");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/** 优化291: 表名列表提升为模块级常量，避免每次 readBuffer 创建新数组 */
var TTF_TABLE_NAMES = ['head', 'maxp', 'loca', 'cmap', 'glyf', 'name', 'hhea', 'hmtx', 'post', 'OS/2', 'fpgm', 'cvt', 'prep', 'gasp', 'GPOS', 'GSUB', 'kern', 'kerx'];
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
/**
 * @file ttf读取器
 * @author mengke01(kekee000@gmail.com)
 */
var TTFReader = exports.default = /*#__PURE__*/function () {
  function TTFReader() {
    var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    options.subset = options.subset || [];
    options.hinting = options.hinting || false;
    options.kerning = options.kerning || false;
    options.compound2simple = options.compound2simple || false;
    this.options = options;
  }

  return _createClass(TTFReader, [{
    key: "readBuffer",
    value: function readBuffer(buffer) {
      var reader = new _reader.default(buffer, 0, buffer.byteLength, false);
      var ttf = {};

      /* 优化27: 头部直接 view 读取 */
      var view = reader.view;
      var vOffset = view.byteOffset;
      ttf.version = view.getInt32(vOffset, false) / 65536.0;
      if (ttf.version !== 0x1) {
        _error.default.raise(10101);
      }
      ttf.numTables = view.getUint16(vOffset + 4, false);
      if (ttf.numTables <= 0 || ttf.numTables > 100) {
        _error.default.raise(10101);
      }
      ttf.searchRange = view.getUint16(vOffset + 6, false);
      ttf.entrySelector = view.getUint16(vOffset + 8, false);
      ttf.rangeShift = view.getUint16(vOffset + 10, false);
      reader.offset = 12;

      ttf.tables = new _directory.default(reader.offset).read(reader, ttf);
      if (!ttf.tables.glyf || !ttf.tables.head || !ttf.tables.cmap || !ttf.tables.hmtx) {
        _error.default.raise(10204);
      }
      ttf.readOptions = this.options;

      /* 优化8+37+62+240: 跳过不必要的表，缓存 TableClass 实例，预构建表名列表替代 for...in */
      var hinting = this.options.hinting;
      var kerning = this.options.kerning;
      var supportTables = _support.default;
      var tableInstances = {};
      var ttfTableNames = TTF_TABLE_NAMES;
      for (var ti = 0, tl = ttfTableNames.length; ti < tl; ti++) {
        var tableName = ttfTableNames[ti];
        if (ttf.tables[tableName]) {
          /* 优化8: hinting=false 时跳过 fpgm/cvt/prep/gasp */
          if (!hinting && (tableName === 'fpgm' || tableName === 'cvt' || tableName === 'prep' || tableName === 'gasp')) {
            continue;
          }
          /* 优化8: hinting=false && kerning=false 时跳过 GPOS/GSUB/kern/kerx */
          if (!hinting && !kerning && (tableName === 'GPOS' || tableName === 'GSUB' || tableName === 'kern' || tableName === 'kerx')) {
            continue;
          }
          var offset = ttf.tables[tableName].offset;
          /* 优化37: 缓存 TableClass 实例 */
          if (!tableInstances[tableName]) {
            tableInstances[tableName] = new supportTables[tableName](offset);
          } else {
            tableInstances[tableName].offset = offset;
          }
          ttf[tableName] = tableInstances[tableName].read(reader, ttf);
        }
      }
      if (!ttf.glyf) {
        _error.default.raise(10201);
      }
      reader.dispose();
      return ttf;
    }
  }, {
    key: "resolveGlyf",
    value: function resolveGlyf(ttf) {
      var codes = ttf.cmap;
      var glyf = ttf.glyf;
      var subsetMap = ttf.readOptions.subset ? ttf.subsetMap : null;
      var subsetGids = ttf.readOptions.subset ? ttf.subsetGids : null;

      /* 优化: subset 模式下只遍历 subsetUnicodeMap（O(S)），避免全量 codes 遍历（O(U)） */
      if (ttf._subsetUnicodeMap) {
        var sum = ttf._subsetUnicodeMap;
        /** 优化: for...in 替代 Object.keys，消除临时数组分配 */
        for (var uStr in sum) {
          var u = +uStr;
          var i = sum[u];
          if (!glyf[i].unicode) {
            glyf[i].unicode = [u];
          } else {
            glyf[i].unicode.push(u);
          }
        }
        ttf._subsetUnicodeMap = null;
      } else {
        for (var c in codes) {
          var i = codes[c];
          var code = +c;
          if (!glyf[i].unicode) {
            glyf[i].unicode = [code];
          } else {
            glyf[i].unicode.push(code);
          }
        }
      }

      /* 优化13+82+118: advanceWidth 遍历优化，使用密集数组 */
      var hmtx = ttf.hmtx;
      if (subsetGids) {
        for (var gi = 0, gl = subsetGids.length; gi < gl; gi++) {
          var idxNum = subsetGids[gi];
          var hIdx = idxNum * 2;
          glyf[idxNum].advanceWidth = hmtx[hIdx];
          glyf[idxNum].leftSideBearing = hmtx[hIdx + 1];
        }
      } else {
        for (var hi = 0, hl = hmtx.length / 2; hi < hl; hi++) {
          var hIdx2 = hi * 2;
          glyf[hi].advanceWidth = hmtx[hIdx2];
          glyf[hi].leftSideBearing = hmtx[hIdx2 + 1];
        }
      }

      /* post 表 glyf name */
      if (ttf.post && 2 === ttf.post.format) {
        var nameIndex = ttf.post.nameIndex;
        var names = ttf.post.names;
        var pascalBytes = ttf.post._pascalStringBytes;
        var pascalOffsets = ttf.post._pascalStringOffsets;
        /* 优化87: subset 模式下按需从 view 读取 nameIndex */
        var niView = ttf.post._nameIndexView;
        var niViewOffset = ttf.post._nameIndexViewOffset;

        if (subsetGids) {
          for (var niIdx = 0, nl2 = subsetGids.length; niIdx < nl2; niIdx++) {
            var niNum = subsetGids[niIdx];
            var nIdx = niView ? niView.getUint16(niViewOffset + niNum * 2, false) : (nameIndex && nameIndex[niNum]);
            if (nIdx === undefined || nIdx === null) continue;
            if (nIdx <= 257) {
              glyf[niNum].name = _postName.default[nIdx];
            } else if (names) {
              glyf[niNum].name = names[nIdx - 258] || '';
            } else if (pascalBytes) {
              var off = pascalOffsets ? pascalOffsets[nIdx - 258] : null;
              if (off === null) {
                /* 按需计算 pascal string 偏移量 */
                var pOff = 0;
                for (var pk = 0; pk < nIdx - 258; pk++) {
                  pOff += 1 + (pascalBytes[pOff] || 0);
                }
                off = pOff;
              }
              glyf[niNum].name = off !== undefined ? _post.getPascalStringAt(pascalBytes, off) : '';
            }
          }
        } else if (nameIndex) {
          for (var ni2 = 0, nl = nameIndex.length; ni2 < nl; ni2++) {
            var nIdx2 = nameIndex[ni2];
            if (nIdx2 <= 257) {
              glyf[ni2].name = _postName.default[nIdx2];
            } else if (names) {
              glyf[ni2].name = names[nIdx2 - 258] || '';
            } else if (pascalBytes && pascalOffsets) {
              var off2 = pascalOffsets[nIdx2 - 258];
              glyf[ni2].name = off2 !== undefined ? _post.getPascalStringAt(pascalBytes, off2) : '';
            }
          }
        }
      }

      /* 优化259: subset 模式下合并 compound→simple 转换与 subGlyf 构建，消除二次遍历 */
      if (subsetGids) {
        var subGlyf = new Array(subsetGids.length);
        for (var si = 0, sl = subsetGids.length; si < sl; si++) {
          var siNum = subsetGids[si];
          if (glyf[siNum].compound) {
            (0, _compound2simpleglyf.default)(siNum, ttf, true);
          }
          subGlyf[si] = glyf[siNum];
        }
        ttf.glyf = subGlyf;
        ttf.maxp.maxComponentElements = 0;
        ttf.maxp.maxComponentDepth = 0;
      }
    }
  }, {
    key: "cleanTables",
    value: function cleanTables(ttf) {
      /** 优化245: delete → null 赋值，避免 V8 隐藏类转换 */
      ttf.readOptions = null;
      ttf.tables = null;
      ttf.hmtx = null;
      ttf.loca = null;
      if (ttf.post) {
        ttf.post.nameIndex = null;
        ttf.post.names = null;
        ttf.post._pascalStringBytes = null;
        ttf.post._pascalStringOffsets = null;
      }
      ttf.subsetMap = null;

      if (!this.options.hinting) {
        /** 优化245: delete → null 赋值，避免 V8 隐藏类转换 */
        ttf.fpgm = null;
        ttf.cvt = null;
        ttf.prep = null;
        var glyfs = ttf.glyf;
        for (var i = 0, l = glyfs.length; i < l; i++) {
          glyfs[i].instructions = null;
        }
      }
      if (!this.options.hinting && !this.options.kerning) {
        ttf.GPOS = null;
        ttf.GSUB = null;
        ttf.kern = null;
        ttf.kerx = null;
      }

      if (this.options.compound2simple && ttf.maxp.maxComponentElements) {
        var glyfs2 = ttf.glyf;
        for (var j = 0, jl = glyfs2.length; j < jl; j++) {
          if (glyfs2[j].compound) {
            (0, _compound2simpleglyf.default)(j, ttf, true);
          }
        }
        ttf.maxp.maxComponentElements = 0;
        ttf.maxp.maxComponentDepth = 0;
      }
    }
  }, {
    key: "read",
    value: function read(buffer) {
      this.ttf = this.readBuffer(buffer);
      this.resolveGlyf(this.ttf);
      this.cleanTables(this.ttf);
      return this.ttf;
    }
  }, {
    key: "dispose",
    value: function dispose() {
      /** 优化262: delete → null 赋值，避免 V8 隐藏类转换 */
      this.ttf = null;
      this.options = null;
    }
  }]);
}();
