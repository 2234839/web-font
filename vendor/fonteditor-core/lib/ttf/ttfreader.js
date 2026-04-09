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

      /* 优化8+37+62: 跳过不必要的表，缓存 TableClass 实例，for...in 替代 Object.keys */
      var hinting = this.options.hinting;
      var kerning = this.options.kerning;
      var supportTables = _support.default;
      var tableInstances = {};
      for (var tableName in supportTables) {
        if (ttf.tables[tableName]) {
          /* 优化8: hinting=false 时跳过 fpgm/cvt/prep/gasp */
          if (!hinting && (tableName === 'fpgm' || tableName === 'cvt' || tableName === 'prep' || tableName === 'gasp')) {
            continue;
          }
          /* 优化8: hinting=false && kerning=false 时跳过 GPOS/kern/kerx */
          if (!hinting && !kerning && (tableName === 'GPOS' || tableName === 'kern' || tableName === 'kerx')) {
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

      /* 优化13+24+62: unicode 遍历，subset 模式只遍历 subsetMap */
      for (var c in codes) {
        var i = codes[c];
        if (subsetMap && !subsetMap[i]) {
          continue;
        }
        if (!glyf[i].unicode) {
          glyf[i].unicode = [];
        }
        glyf[i].unicode.push(+c);
      }

      /* 优化13: advanceWidth 遍历优化 */
      var hmtx = ttf.hmtx;
      if (subsetMap) {
        for (var idx in subsetMap) {
          var idxNum = +idx;
          glyf[idxNum].advanceWidth = hmtx[idxNum].advanceWidth;
          glyf[idxNum].leftSideBearing = hmtx[idxNum].leftSideBearing;
        }
      } else {
        for (var hi = 0, hl = hmtx.length; hi < hl; hi++) {
          glyf[hi].advanceWidth = hmtx[hi].advanceWidth;
          glyf[hi].leftSideBearing = hmtx[hi].leftSideBearing;
        }
      }

      /* post 表 glyf name */
      if (ttf.post && 2 === ttf.post.format) {
        var nameIndex = ttf.post.nameIndex;
        var names = ttf.post.names;
        var pascalBytes = ttf.post._pascalStringBytes;
        var pascalOffsets = ttf.post._pascalStringOffsets;
        for (var ni = 0, nl = nameIndex.length; ni < nl; ni++) {
          if (subsetMap && !subsetMap[ni]) {
            continue;
          }
          var nIdx = nameIndex[ni];
          if (nIdx <= 257) {
            glyf[ni].name = _postName.default[nIdx];
          } else if (names) {
            glyf[ni].name = names[nIdx - 258] || '';
          } else if (pascalBytes && pascalOffsets) {
            var off = pascalOffsets[nIdx - 258];
            glyf[ni].name = off !== undefined ? _post.getPascalStringAt(pascalBytes, off) : '';
          }
        }
      }

      /* 优化13+44+62: subset 模式下直接只遍历 subsetMap */
      if (subsetMap) {
        var subGlyf = [];
        for (var si in subsetMap) {
          var siNum = +si;
          if (glyf[siNum].compound) {
            (0, _compound2simpleglyf.default)(siNum, ttf, true);
          }
          subGlyf.push(glyf[siNum]);
        }
        ttf.glyf = subGlyf;
        ttf.maxp.maxComponentElements = 0;
        ttf.maxp.maxComponentDepth = 0;
      }
    }
  }, {
    key: "cleanTables",
    value: function cleanTables(ttf) {
      delete ttf.readOptions;
      delete ttf.tables;
      delete ttf.hmtx;
      delete ttf.loca;
      if (ttf.post) {
        delete ttf.post.nameIndex;
        delete ttf.post.names;
        delete ttf.post._pascalStringBytes;
        delete ttf.post._pascalStringOffsets;
      }
      delete ttf.subsetMap;

      if (!this.options.hinting) {
        delete ttf.fpgm;
        delete ttf.cvt;
        delete ttf.prep;
        /* 优化55: forEach → for 循环 */
        var glyfs = ttf.glyf;
        for (var i = 0, l = glyfs.length; i < l; i++) {
          delete glyfs[i].instructions;
        }
      }
      if (!this.options.hinting && !this.options.kerning) {
        delete ttf.GPOS;
        delete ttf.kern;
        delete ttf.kerx;
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
      delete this.ttf;
      delete this.options;
    }
  }]);
}();
