"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _writer = _interopRequireDefault(require("./writer"));
var _directory = _interopRequireDefault(require("./table/directory"));
var _support = _interopRequireDefault(require("./table/support"));
var _checkSum = _interopRequireDefault(require("./util/checkSum"));
var _error = _interopRequireDefault(require("./error"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
/**
 * @file ttf写入器
 * @author mengke01(kekee000@gmail.com)
 */
var SUPPORT_TABLES = ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
var TTFWriter = exports.default = /*#__PURE__*/function () {
  function TTFWriter() {
    var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    this.options = {
      writeZeroContoursGlyfData: options.writeZeroContoursGlyfData || false,
      hinting: options.hinting || false,
      kerning: options.kerning || false,
      support: options.support
    };
  }

  /**
   * 优化4+46: resolveTTF 中 unicode 排序修正 + forEach → for 循环
   */
  return _createClass(TTFWriter, [{
    key: "resolveTTF",
    value: function resolveTTF(ttf) {
      ttf.version = ttf.version || 0x1;
      ttf.numTables = ttf.writeOptions.tables.length;
      ttf.entrySelector = Math.floor(Math.log(ttf.numTables) / Math.LN2);
      ttf.searchRange = Math.pow(2, ttf.entrySelector) * 16;
      ttf.rangeShift = ttf.numTables * 16 - ttf.searchRange;

      ttf.head.checkSumAdjustment = 0;
      ttf.head.magickNumber = 0x5F0F3CF5;
      if (typeof ttf.head.created === 'string') {
        ttf.head.created = /^\d+$/.test(ttf.head.created) ? +ttf.head.created : Date.parse(ttf.head.created);
      }
      if (typeof ttf.head.modified === 'string') {
        ttf.head.modified = /^\d+$/.test(ttf.head.modified) ? +ttf.head.modified : Date.parse(ttf.head.modified);
      }
      if (!ttf.head.created) {
        ttf.head.created = Date.now();
      }
      if (!ttf.head.modified) {
        ttf.head.modified = ttf.head.created;
      }
      var checkUnicodeRepeat = {};

      /* 优化4+46: 数字排序 + for 循环 */
      var glyfs = ttf.glyf;
      for (var index = 0, gl = glyfs.length; index < gl; index++) {
        var glyf = glyfs[index];
        if (glyf.unicode) {
          glyf.unicode.sort(function (a, b) { return a - b; });
          var unicode = glyf.unicode;
          for (var ui = 0, ul = unicode.length; ui < ul; ui++) {
            var u = unicode[ui];
            if (checkUnicodeRepeat[u]) {
              _error.default.raise({ number: 10200, data: index }, index);
            } else {
              checkUnicodeRepeat[u] = true;
            }
          }
        }
      }
    }
  }, {
    key: "dump",
    value: function dump(ttf) {
      ttf.support = Object.assign({}, this.options.support);
      var ttfSize = 12 + ttf.numTables * 16;
      var ttfHeadOffset = 0;

      /* 优化35+56: 缓存 TableClass 实例，forEach → for 循环 */
      ttf.support.tables = [];
      var writeTables = ttf.writeOptions.tables;
      var supportTables = _support.default;
      var tableInstances = {};
      for (var ti = 0, tl = writeTables.length; ti < tl; ti++) {
        var tableName = writeTables[ti];
        var offset = ttfSize;
        if (!tableInstances[tableName]) {
          tableInstances[tableName] = new supportTables[tableName]();
        }
        var tableSize = tableInstances[tableName].size(ttf);
        var size = tableSize;
        if (tableName === 'head') {
          ttfHeadOffset = offset;
        }
        if (size % 4) {
          size += 4 - size % 4;
        }
        ttf.support.tables.push({
          name: tableName,
          checkSum: 0,
          offset: offset,
          length: tableSize,
          size: size
        });
        ttfSize += size;
      }
      var writer = new _writer.default(new ArrayBuffer(ttfSize));

      /* 优化36: 头部直接 view 写入 */
      var wView = writer.view;
      var pos = writer.offset;
      wView.setInt32(pos, Math.round(ttf.version * 65536), false); pos += 4;
      wView.setUint16(pos, ttf.numTables, false); pos += 2;
      wView.setUint16(pos, ttf.searchRange, false); pos += 2;
      wView.setUint16(pos, ttf.entrySelector, false); pos += 2;
      wView.setUint16(pos, ttf.rangeShift, false); pos += 2;
      writer.offset = pos;

      new _directory.default().write(writer, ttf);

      /* 优化56: forEach → for 循环 */
      var supportTableList = ttf.support.tables;
      for (var si = 0, sl = supportTableList.length; si < sl; si++) {
        var table = supportTableList[si];
        var tableStart = writer.offset;
        var tName = table.name;
        if (!tableInstances[tName]) {
          tableInstances[tName] = new supportTables[tName]();
        }
        tableInstances[tName].write(writer, ttf);
        if (table.length % 4) {
          writer.writeEmpty(4 - table.length % 4);
        }
        table.checkSum = (0, _checkSum.default)(writer.getBuffer(), tableStart, table.size);
      }

      /* 重新写入校验和 */
      for (var ci = 0, cl = supportTableList.length; ci < cl; ci++) {
        var offset2 = 12 + ci * 16 + 4;
        writer.writeUint32(supportTableList[ci].checkSum, offset2);
      }

      /* 写入总校验和 */
      var ttfCheckSum = (0xB1B0AFBA - (0, _checkSum.default)(writer.getBuffer()) + 0x100000000) % 0x100000000;
      writer.writeUint32(ttfCheckSum, ttfHeadOffset + 8);
      delete ttf.writeOptions;
      delete ttf.support;
      var buffer = writer.getBuffer();
      writer.dispose();
      return buffer;
    }
  }, {
    key: "prepareDump",
    value: function prepareDump(ttf) {
      if (!ttf.glyf || ttf.glyf.length === 0) {
        _error.default.raise(10201);
      }
      if (!ttf['OS/2'] || !ttf.head || !ttf.name) {
        _error.default.raise(10204);
      }
      var tables = SUPPORT_TABLES.slice(0);
      ttf.writeOptions = {};
      /* 优化56: forEach → for 循环 */
      if (this.options.hinting) {
        var hintTables = ['cvt', 'fpgm', 'prep', 'gasp', 'GPOS', 'kern', 'kerx'];
        for (var i = 0; i < hintTables.length; i++) {
          if (ttf[hintTables[i]]) {
            tables.push(hintTables[i]);
          }
        }
      }
      if (this.options.kerning) {
        var kernTables = ['GPOS', 'kern', 'kerx'];
        for (var j = 0; j < kernTables.length; j++) {
          if (ttf[kernTables[j]]) {
            tables.push(kernTables[j]);
          }
        }
      }
      ttf.writeOptions.writeZeroContoursGlyfData = !!this.options.writeZeroContoursGlyfData;
      ttf.writeOptions.hinting = !!this.options.hinting;
      ttf.writeOptions.kerning = !!this.options.kerning;
      ttf.writeOptions.tables = tables.sort();
    }
  }, {
    key: "write",
    value: function write(ttf) {
      this.prepareDump(ttf);
      this.resolveTTF(ttf);
      var buffer = this.dump(ttf);
      return buffer;
    }
  }, {
    key: "dispose",
    value: function dispose() {
      delete this.options;
    }
  }]);
}();
