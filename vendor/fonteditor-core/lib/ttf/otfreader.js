"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _directory = _interopRequireDefault(require("./table/directory"));
var _supportOtf = _interopRequireDefault(require("./table/support-otf"));
var _reader = _interopRequireDefault(require("./reader"));
var _error = _interopRequireDefault(require("./error"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); } /**
 * @file otf字体读取
 * @author mengke01(kekee000@gmail.com)
 */
var OTFReader = exports.default = /*#__PURE__*/function () {
  /**
   * OTF读取函数
   *
   * @param {Object} options 写入参数
   * @constructor
   */
  function OTFReader() {
    var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    _classCallCheck(this, OTFReader);
    options.subset = options.subset || [];
    this.options = options;
  }

  /**
   * 初始化
   *
   * @param {ArrayBuffer} buffer buffer对象
   * @return {Object} ttf对象
   */
  return _createClass(OTFReader, [{
    key: "readBuffer",
    value: function readBuffer(buffer) {
      var __t0 = process.hrtime.bigint();
      var reader = new _reader.default(buffer, 0, buffer.byteLength, false);
      var font = {};

      // version
      font.version = reader.readString(0, 4);
      if (font.version !== 'OTTO') {
        _error.default.raise(10301);
      }

      // num tables
      font.numTables = reader.readUint16();
      if (font.numTables <= 0 || font.numTables > 100) {
        _error.default.raise(10302);
      }

      // searchRange
      font.searchRange = reader.readUint16();

      // entrySelector
      font.entrySelector = reader.readUint16();

      // rangeShift
      font.rangeShift = reader.readUint16();
      font.tables = new _directory.default(reader.offset).read(reader, font);
      if (!font.tables.head || !font.tables.cmap || !font.tables.CFF) {
        _error.default.raise(10302);
      }
      font.readOptions = this.options;

      /** 优化232: 预构建表名列表，替代 for...in 遍历 */
      var otfTableNames = ['head', 'maxp', 'cmap', 'name', 'hhea', 'hmtx', 'post', 'OS/2', 'CFF', 'GPOS', 'kern'];
      var otfSupport = _supportOtf.default;
      for (var ti = 0, tl = otfTableNames.length; ti < tl; ti++) {
        var tableName = otfTableNames[ti];
        if (font.tables[tableName]) {
          var offset = font.tables[tableName].offset;
          font[tableName] = new otfSupport[tableName](offset).read(reader, font);
        }
      }
      if (!font.CFF.glyf) {
        _error.default.raise(10303);
      }
      reader.dispose();
      var __t1 = process.hrtime.bigint();
      console.error('OTFREADER.readBuffer: ' + Number(__t1 - __t0) / 1e6 + 'ms');
      return font;
    }

    /**
     * 关联glyf相关的信息
     *
     * @param {Object} font font对象
     */
  }, {
    key: "resolveGlyf",
    value: function resolveGlyf(font) {
      var __t0 = process.hrtime.bigint();
      var codes = font.cmap;
      var glyf = font.CFF.glyf;
      var subsetMap = font.readOptions.subset ? font.subsetMap : null;
      /**
       * 优化298: subset 模式下只遍历 subset unicode 列表（O(S)），避免全 cmap 遍历（O(U)）
       * 思源等大 CID 字体 cmap 有数万映射，原 Object.keys + 全量循环开销显著
       */
      if (subsetMap && font.readOptions.subset && font.readOptions.subset.length > 0) {
        var subsetList = font.readOptions.subset;
        for (var si = 0, sl = subsetList.length; si < sl; si++) {
          var cp = subsetList[si];
          var gid = codes[cp];
          if (gid === undefined) continue;
          if (!subsetMap[gid]) continue;
          if (!glyf[gid].unicode) glyf[gid].unicode = [];
          glyf[gid].unicode.push(cp);
        }
      } else {
        /** 优化290: subsetMap 检查提到循环外，消除每次迭代的分支判断 */
        var cmapKeys = Object.keys(codes);
        if (subsetMap) {
          for (var ki = 0, kl = cmapKeys.length; ki < kl; ki++) {
            var c = cmapKeys[ki];
            var i = codes[c];
            if (!subsetMap[i]) continue;
            if (!glyf[i].unicode) glyf[i].unicode = [];
            glyf[i].unicode.push(+c);
          }
        } else {
          for (var ki2 = 0, kl2 = cmapKeys.length; ki2 < kl2; ki2++) {
            var c2 = cmapKeys[ki2];
            var i2 = codes[c2];
            if (!glyf[i2].unicode) glyf[i2].unicode = [];
            glyf[i2].unicode.push(+c2);
          }
        }
      }

      /* leftSideBearing / advanceWidth —— 兼容扁平 Int32Array 和对象数组 */
      var hmtxData = font.hmtx;
      var isFlat = hmtxData instanceof Int32Array;
      var hLen = isFlat ? hmtxData.length / 2 : hmtxData.length;
      /**
       * 优化298: subset 模式下遍历 subsetGids（O(S)），避免全 hmtx 遍历（O(U)）
       */
      if (subsetMap && font.subsetGids) {
        var sGids = font.subsetGids;
        if (isFlat) {
          for (var gi = 0, gl = sGids.length; gi < gl; gi++) {
            var gid2 = sGids[gi];
            glyf[gid2].advanceWidth = hmtxData[gid2 * 2] || 0;
            glyf[gid2].leftSideBearing = hmtxData[gid2 * 2 + 1];
          }
        } else {
          for (var gi2 = 0, gl2 = sGids.length; gi2 < gl2; gi2++) {
            var gid3 = sGids[gi2];
            glyf[gid3].advanceWidth = hmtxData[gid3].advanceWidth || 0;
            glyf[gid3].leftSideBearing = hmtxData[gid3].leftSideBearing;
          }
        }
      } else if (subsetMap) {
        if (isFlat) {
          for (var hi = 0, j = 0; hi < hLen; hi++, j += 2) {
            if (!subsetMap[hi]) continue;
            glyf[hi].advanceWidth = hmtxData[j] || 0;
            glyf[hi].leftSideBearing = hmtxData[j + 1];
          }
        } else {
          for (var hi = 0; hi < hLen; hi++) {
            if (!subsetMap[hi]) continue;
            glyf[hi].advanceWidth = hmtxData[hi].advanceWidth || 0;
            glyf[hi].leftSideBearing = hmtxData[hi].leftSideBearing;
          }
        }
      } else {
        if (isFlat) {
          for (var hi = 0, j = 0; hi < hLen; hi++, j += 2) {
            glyf[hi].advanceWidth = hmtxData[j] || 0;
            glyf[hi].leftSideBearing = hmtxData[j + 1];
          }
        } else {
          for (var hi = 0; hi < hLen; hi++) {
            glyf[hi].advanceWidth = hmtxData[hi].advanceWidth || 0;
            glyf[hi].leftSideBearing = hmtxData[hi].leftSideBearing;
          }
        }
      }

      // 设置了subsetMap之后需要选取subset中的字形
      /* 优化167: 密集数组替代 for...in，消除字符串键转换 */
      if (subsetMap) {
        var subsetGids = font.subsetGids;
        var subGlyf;
        if (subsetGids) {
          subGlyf = new Array(subsetGids.length);
          for (var si = 0, sl = subsetGids.length; si < sl; si++) {
            subGlyf[si] = glyf[subsetGids[si]];
          }
        } else {
          subGlyf = [];
          var subsetKeys = Object.keys(subsetMap);
          for (var si = 0, sl = subsetKeys.length; si < sl; si++) {
            subGlyf.push(glyf[+subsetKeys[si]]);
          }
        }
        glyf = subGlyf;
      }
      font.glyf = glyf;
      var __t1 = process.hrtime.bigint();
      console.error('OTFREADER.resolveGlyf: ' + Number(__t1 - __t0) / 1e6 + 'ms');
    }

    /**
     * 清除非必须的表
     *
     * @param {Object} font font对象
     */
  }, {
    key: "cleanTables",
    value: function cleanTables(font) {
      /** 优化245: delete → null 赋值，避免 V8 隐藏类转换 */
      font.readOptions = null;
      font.tables = null;
      font.hmtx = null;
      font.post.glyphNameIndex = null;
      font.post.names = null;
      font.subsetMap = null;

      // 清除无用的表
      var cff = font.CFF;
      cff.glyf = null;
      cff.charset = null;
      cff.encoding = null;
      cff.gsubrs = null;
      cff.gsubrsBias = null;
      cff.subrs = null;
      cff.subrsBias = null;
    }

    /**
     * 获取解析后的ttf文档
     *
     * @param {ArrayBuffer} buffer buffer对象
     *
     * @return {Object} ttf文档
     */
  }, {
    key: "read",
    value: function read(buffer) {
      this.font = this.readBuffer(buffer);
      this.resolveGlyf(this.font);
      this.cleanTables(this.font);
      return this.font;
    }

    /**
     * 注销
     */
  }, {
    key: "dispose",
    value: function dispose() {
      /** 优化262: delete → null 赋值，避免 V8 隐藏类转换 */
      this.font = null;
      this.options = null;
    }
  }]);
}();