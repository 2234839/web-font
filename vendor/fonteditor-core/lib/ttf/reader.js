"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _lang = require("../common/lang");
var _error = _interopRequireDefault(require("./error"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _slicedToArray(arr, i) { return _arrayWithHoles(arr) || _iterableToArrayLimit(arr, i) || _unsupportedIterableToArray(arr, i) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(o, minLen) { if (!o) return; if (typeof o === "string") return _arrayLikeToArray(o, minLen); var n = Object.prototype.toString.call(o).slice(8, -1); if (n === "Object" && o.constructor) n = o.constructor.name; if (n === "Map" || n === "Set") return Array.from(o); if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen); }
function _arrayLikeToArray(arr, len) { if (len == null || len > arr.length) len = arr.length; for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i]; return arr2; }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(arr) { if (Array.isArray(arr)) return arr; }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); } /**
 * @file 数据读取器
 * @author mengke01(kekee000@gmail.com)
 *
 * thanks to：
 * ynakajima/ttf.js
 * https://github.com/ynakajima/ttf.js
 */
// 检查数组支持情况
if (typeof ArrayBuffer === 'undefined' || typeof DataView === 'undefined') {
  throw new Error('not support ArrayBuffer and DataView');
}

// 数据类型
var dataType = {
  Int8: 1,
  Int16: 2,
  Int32: 4,
  Uint8: 1,
  Uint16: 2,
  Uint32: 4,
  Float32: 4,
  Float64: 8
};
var Reader = exports.default = /*#__PURE__*/function () {
  /**
   * 读取器
   *
   * @constructor
   * @param {Array.<byte>} buffer 缓冲数组
   * @param {number} offset 起始偏移
   * @param {number} length 数组长度
   * @param {boolean} littleEndian 是否小尾
   */
  function Reader(buffer, offset, length, littleEndian) {
    _classCallCheck(this, Reader);
    var bufferLength = buffer.byteLength || buffer.length;
    this.offset = offset || 0;
    this.length = length || bufferLength - this.offset;
    this.littleEndian = littleEndian || false;
    this.view = new DataView(buffer, this.offset, this.length);
  }

  /**
   * 读取指定的数据类型
   *
   * @param {string} type 数据类型
   * @param {number=} offset 位移
   * @param {boolean=} littleEndian 是否小尾
   * @return {number} 返回值
   */
  return _createClass(Reader, [{
    key: "read",
    value: function read(type, offset, littleEndian) {
      if (undefined === offset) {
        offset = this.offset;
      }
      if (undefined === littleEndian) {
        littleEndian = this.littleEndian;
      }
      if (undefined === dataType[type]) {
        return this['read' + type](offset, littleEndian);
      }
      var size = dataType[type];
      this.offset = offset + size;
      /* 优化20: switch 直接分发，避免动态属性查找 */
      switch (type) {
        case 'Int8': return this.view.getInt8(offset, littleEndian);
        case 'Uint8': return this.view.getUint8(offset, littleEndian);
        case 'Int16': return this.view.getInt16(offset, littleEndian);
        case 'Uint16': return this.view.getUint16(offset, littleEndian);
        case 'Int32': return this.view.getInt32(offset, littleEndian);
        case 'Uint32': return this.view.getUint32(offset, littleEndian);
        case 'Float32': return this.view.getFloat32(offset, littleEndian);
        case 'Float64': return this.view.getFloat64(offset, littleEndian);
      }
    }

    /**
     * 获取指定的字节数组
     *
     * @param {number} offset 偏移
     * @param {number} length 字节长度
     * @return {Array} 字节数组
     */
  }, {
    key: "readBytes",
    value: function readBytes(offset) {
      var length = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
      if (length == null) {
        length = offset;
        offset = this.offset;
      }
      if (length < 0 || offset + length > this.length) {
        _error.default.raise(10001, this.length, offset + length);
      }
      /* 优化68: Uint8Array.slice 批量读取，替代逐字节 push */
      var bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + offset, length).slice();
      this.offset = offset + length;
      return bytes;
    }

    /**
     * 读取一个string
     *
     * @param {number} offset 偏移
     * @param {number} length 长度
     * @return {string} 字符串
     */
  }, {
    key: "readString",
    value: function readString(offset) {
      var length = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
      if (length == null) {
        length = offset;
        offset = this.offset;
      }
      if (length < 0 || offset + length > this.length) {
        _error.default.raise(10001, this.length, offset + length);
      }
      /* 优化22: 批量读取字节后构建字符串，替代逐字节 readUint8 */
      var chars = new Array(length);
      var viewOffset = this.view.byteOffset + offset;
      var buf = this.view.buffer;
      for (var i = 0; i < length; ++i) {
        chars[i] = buf.charCodeAt ? String.fromCharCode(buf.charCodeAt(viewOffset + i)) : String.fromCharCode(new Uint8Array(buf, viewOffset + i, 1)[0]);
      }
      this.offset = offset + length;
      return chars.join('');
    }

    /**
     * 读取一个字符
     *
     * @param {number} offset 偏移
     * @return {string} 字符串
     */
  }, {
    key: "readChar",
    value: function readChar(offset) {
      return this.readString(offset, 1);
    }

    /**
     * 读取一个uint24整形
     *
     * @param {number} offset 偏移
     * @return {number}
     */
  }, {
    key: "readUint24",
    value: function readUint24(offset) {
      var _this$readBytes = this.readBytes(offset || this.offset, 3),
        _this$readBytes2 = _slicedToArray(_this$readBytes, 3),
        i = _this$readBytes2[0],
        j = _this$readBytes2[1],
        k = _this$readBytes2[2];
      return (i << 16) + (j << 8) + k;
    }

    /**
     * 读取fixed类型
     *
     * @param {number} offset 偏移
     * @return {number} float
     */
  }, {
    key: "readFixed",
    value: function readFixed(offset) {
      if (undefined === offset) {
        offset = this.offset;
      }
      var val = this.readInt32(offset, false) / 65536.0;
      return Math.ceil(val * 100000) / 100000;
    }

    /**
     * 读取长日期
     *
     * @param {number} offset 偏移
     * @return {Date} Date对象
     */
  }, {
    key: "readLongDateTime",
    value: function readLongDateTime(offset) {
      if (undefined === offset) {
        offset = this.offset;
      }

      // new Date(1970, 1, 1).getTime() - new Date(1904, 1, 1).getTime();
      var delta = -2077545600000;
      var time = this.readUint32(offset + 4, false);
      var date = new Date();
      date.setTime(time * 1000 + delta);
      return date;
    }

    /**
     * 跳转到指定偏移
     *
     * @param {number} offset 偏移
     * @return {Object} this
     */
  }, {
    key: "seek",
    value: function seek(offset) {
      if (undefined === offset) {
        this.offset = 0;
      }
      if (offset < 0 || offset > this.length) {
        _error.default.raise(10001, this.length, offset);
      }
      this.offset = offset;
      return this;
    }

    /**
     * 注销
     */
  }, {
    key: "dispose",
    value: function dispose() {
      delete this.view;
    }
  }]);
}(); // 优化19+20: 直接绑定方法 + switch 分发，避免 curry 闭包和动态属性查找
Reader.prototype.readInt8 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 1; return this.view.getInt8(offset, this.littleEndian); };
Reader.prototype.readUint8 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 1; return this.view.getUint8(offset, this.littleEndian); };
Reader.prototype.readInt16 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 2; return this.view.getInt16(offset, this.littleEndian); };
Reader.prototype.readUint16 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 2; return this.view.getUint16(offset, this.littleEndian); };
Reader.prototype.readInt32 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 4; return this.view.getInt32(offset, this.littleEndian); };
Reader.prototype.readUint32 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 4; return this.view.getUint32(offset, this.littleEndian); };
Reader.prototype.readFloat32 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 4; return this.view.getFloat32(offset, this.littleEndian); };
Reader.prototype.readFloat64 = function(offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 8; return this.view.getFloat64(offset, this.littleEndian); };