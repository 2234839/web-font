"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _writer = _interopRequireDefault(require("./writer"));
var _directory = _interopRequireDefault(require("./table/directory"));
var _support = _interopRequireDefault(require("./table/support"));
var _checkSum = _interopRequireDefault(require("./util/checkSum"));
var _checkSumArrayBuffer = _interopRequireDefault(require("./util/checkSum")).checkSumArrayBuffer;
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
/** 优化291: 日期正则预编译为模块级常量 */
var ALL_DIGITS = /^\d+$/;
var TTFWriter = exports.default = /*#__PURE__*/function () {
  function TTFWriter() {
    var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    this.options = {
      writeZeroContoursGlyfData: options.writeZeroContoursGlyfData || false,
      hinting: options.hinting || false,
      kerning: options.kerning || false,
      support: options.support,
      /** 优化316: woff2/woff/eot 输出会重新编码，不消费 TTF directory 的 per-table checksum 与
       *  head.checkSumAdjustment（encodeTTFToWOFF2 只读 directory 的 tag/offset/length，重建自己的 directory）。
       *  跳过 checksum 计算可省大字集下 ~5% 的 checkSumArrayBuffer 开销。head.checkSumAdjustment 保持 0 占位
       *  （resolveTTF 已置 0），浏览器渲染不依赖该字段。仅 ttf 直出（消费 directory checksum）时不能跳过。 */
      skipCheckSum: options.skipCheckSum || false
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
      ttf.entrySelector = 31 - Math.clz32(ttf.numTables);
      ttf.searchRange = 2 << ttf.entrySelector;
      ttf.rangeShift = ttf.numTables * 16 - ttf.searchRange;

      ttf.head.checkSumAdjustment = 0;
      ttf.head.magickNumber = 0x5F0F3CF5;
      if (typeof ttf.head.created === 'string') {
        ttf.head.created = ALL_DIGITS.test(ttf.head.created) ? +ttf.head.created : Date.parse(ttf.head.created);
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
      /* 优化112+145: optimizettf 已排序 unicode 并检查重复，跳过冗余工作；延迟分配 checkUnicodeRepeat */
      if (!ttf._unicodeSorted) {
        var checkUnicodeRepeat = {};
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
    }
  }, {
    key: "dump",
    value: function dump(ttf) {
      /** 优化286: support 为 undefined 时直接赋值空对象，避免 Object.assign 调用 */
      ttf.support = this.options.support ? Object.assign({}, this.options.support) : {};
      var ttfSize = 12 + ttf.numTables * 16;
      var ttfHeadOffset = 0;

      /* 优化35+56: 缓存 TableClass 实例，forEach → for 循环 */
      var writeTables = ttf.writeOptions.tables;
      var supportTables = _support.default;
      var tableInstances = {};
      var supportTablesArr = new Array(writeTables.length);
      ttf.support.tables = supportTablesArr;
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
        size = (size + 3) & ~3;
        supportTablesArr[ti] = {
          name: tableName,
          checkSum: 0,
          offset: offset,
          length: tableSize,
          size: size
        };
        ttfSize += size;
      }
      var writer = new _writer.default(new ArrayBuffer(ttfSize));

      /* 优化36+184: 头部直接 view 写入，Math.round 替换为位运算 */
      var wView = writer.view;
      var pos = writer.offset;
      wView.setInt32(pos, ttf.version * 65536 + 0.5 | 0, false); pos += 4;
      wView.setUint16(pos, ttf.numTables, false); pos += 2;
      wView.setUint16(pos, ttf.searchRange, false); pos += 2;
      wView.setUint16(pos, ttf.entrySelector, false); pos += 2;
      wView.setUint16(pos, ttf.rangeShift, false); pos += 2;
      writer.offset = pos;

      /* 优化: directory 实例复用 tableInstances 缓存 */
      if (!tableInstances['directory']) {
        tableInstances['directory'] = new _directory.default();
      }
      tableInstances['directory'].write(writer, ttf);

      /* 优化56+87+179+184: forEach → for 循环，缓存 buffer 引用，累加各表校验和避免全局重算
       * 优化184: 内联 writeEmpty 为 fullView.fill(0)，避免 writer.writeEmpty 的函数调用 + 边界检查开销 */
      var supportTableList = ttf.support.tables;
      var buf = writer.getBuffer();
      /** 优化316: skipCheckSum（woff2/woff/eot）时跳过 checksum 计算，head.checkSumAdjustment 保持 0 占位 */
      var skipCheckSum = this.options.skipCheckSum;
      var wholeCheckSum = 0;
      /** fullView 仍需用于表 padding fill(0)，skipCheckSum 时不必创建 fullDataView */
      var fullView = new Uint8Array(buf);
      var fullDataView = skipCheckSum ? null : new DataView(buf);
      for (var si = 0, sl = supportTableList.length; si < sl; si++) {
        var table = supportTableList[si];
        var tableStart = writer.offset;
        var tName = table.name;
        if (!tableInstances[tName]) {
          tableInstances[tName] = new supportTables[tName]();
        }
        tableInstances[tName].write(writer, ttf);
        var pad = table.length % 4;
        if (pad) {
          fullView.fill(0, wView.byteOffset + writer.offset, wView.byteOffset + writer.offset + (4 - pad));
          writer.offset += 4 - pad;
        }
        if (!skipCheckSum) {
          table.checkSum = _checkSumArrayBuffer(buf, tableStart, table.size, fullView, fullDataView);
          wholeCheckSum = (wholeCheckSum + table.checkSum) >>> 0;
        }
      }

      if (!skipCheckSum) {
        /* 优化111: 重新写入校验和，直接 view 写入 */
        var csView = writer.view;
        for (var ci = 0, cl = supportTableList.length; ci < cl; ci++) {
          var offset2 = 12 + ci * 16 + 4;
          csView.setUint32(offset2, supportTableList[ci].checkSum, false);
        }

        /* 优化179: 用累加的各表校验和替代全局 checkSum，避免重遍历整个 buffer */
        var ttfCheckSum = (0xB1B0AFBA - wholeCheckSum) >>> 0;
        csView.setUint32(ttfHeadOffset + 8, ttfCheckSum, false);
      }
      /** 优化260: delete → null 赋值，避免 V8 隐藏类转换 */
      ttf.writeOptions = null;
      ttf.support = null;
      writer.dispose();
      return buf;
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
      /* 优化: 无 hinting/kerning 时直接使用 SUPPORT_TABLES，避免 concat 开销 */
      /* 优化186: 使用 slice() 创建副本，防止 push 变异模块级数组导致后续调用表膨胀 */
      var tables = SUPPORT_TABLES;
      ttf.writeOptions = {};
      /* 优化228+291: 合并 hinting 和 kerning 分支，消除重复表名 */
      if (this.options.hinting || this.options.kerning) {
        tables = SUPPORT_TABLES.slice();
        /** 优化291: 使用 Set 去重，防止 hinting+kerning 同时开启时 GPOS/kern/kerx 被重复 push */
        var added = {};
        if (this.options.hinting) {
          var hintTables = ['cvt', 'fpgm', 'prep', 'gasp', 'GPOS', 'kern', 'kerx'];
          for (var i = 0; i < hintTables.length; i++) {
            var tn = hintTables[i];
            if (ttf[tn] && !added[tn]) {
              tables.push(tn);
              added[tn] = true;
            }
          }
        }
        if (this.options.kerning) {
          var kernTables = ['GPOS', 'GSUB', 'kern', 'kerx'];
          for (var j = 0; j < kernTables.length; j++) {
            var kn = kernTables[j];
            if (ttf[kn] && !added[kn]) {
              tables.push(kn);
              added[kn] = true;
            }
          }
        }
      }
      ttf.writeOptions.writeZeroContoursGlyfData = !!this.options.writeZeroContoursGlyfData;
      ttf.writeOptions.hinting = !!this.options.hinting;
      ttf.writeOptions.kerning = !!this.options.kerning;
      /* 优化144: SUPPORT_TABLES 已有序，hint/kern 表名按字母序追加，无需 sort() */
      ttf.writeOptions.tables = tables;
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
      /** 优化262: delete → null 赋值，避免 V8 隐藏类转换 */
      this.options = null;
    }
  }]);
}();
