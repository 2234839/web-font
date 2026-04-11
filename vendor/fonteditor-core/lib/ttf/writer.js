"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _lang = require("../common/lang");
var _error = _interopRequireDefault(require("./error"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); } /**
 * @file 数据写入器
 * @author mengke01(kekee000@gmail.com)
 */
// 检查数组支持情况
if (typeof ArrayBuffer === 'undefined' || typeof DataView === 'undefined') {
  throw new Error('not support ArrayBuffer and DataView');
}

/** 优化178: 全局 Uint8Array 视图缓存，避免 writeBytes/writeEmpty 每次创建视图 */
var _globalView = null;
var _globalViewBuf = null;
/** 优化: 预编译正则，避免 writeLongDateTime 每次创建 RegExp */
var _isAllDigits = /^\d+$/;

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

/**
 * 读取器
 *
 * @constructor
 * @param {Array.<byte>} buffer 缓冲数组
 * @param {number} offset 起始偏移
 * @param {number=} length 数组长度
 * @param {boolean=} littleEndian 是否小尾
 */
var Writer = /*#__PURE__*/function () {
  function Writer(buffer, offset, length, littleEndian) {
    _classCallCheck(this, Writer);
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
   * @param {number} value value值
   * @param {number=} offset 位移
   * @param {boolean=} littleEndian 是否小尾
   *
   * @return {this}
   */
  return _createClass(Writer, [{
    key: "write",
    value: function write(type, value, offset, littleEndian) {
      if (undefined === offset) {
        offset = this.offset;
      }
      if (undefined === littleEndian) {
        littleEndian = this.littleEndian;
      }
      if (undefined === dataType[type]) {
        return this['write' + type](value, offset, littleEndian);
      }
      var size = dataType[type];
      this.offset = offset + size;
      /* 优化20: switch 直接分发，避免动态属性查找 */
      switch (type) {
        case 'Int8': this.view.setInt8(offset, value, littleEndian); break;
        case 'Uint8': this.view.setUint8(offset, value, littleEndian); break;
        case 'Int16': this.view.setInt16(offset, value, littleEndian); break;
        case 'Uint16': this.view.setUint16(offset, value, littleEndian); break;
        case 'Int32': this.view.setInt32(offset, value, littleEndian); break;
        case 'Uint32': this.view.setUint32(offset, value, littleEndian); break;
        case 'Float32': this.view.setFloat32(offset, value, littleEndian); break;
        case 'Float64': this.view.setFloat64(offset, value, littleEndian); break;
      }
      return this;
    }

    /**
     * 写入指定的字节数组
     *
     * @param {ArrayBuffer} value 写入值
     * @param {number=} length 数组长度
     * @param {number=} offset 起始偏移
     * @return {this}
     */
  }, {
    key: "writeBytes",
    value: function writeBytes(value, length, offset) {
      length = length || value.byteLength || value.length;
      if (!length) {
        return this;
      }
      if (undefined === offset) {
        offset = this.offset;
      }
      if (length < 0 || offset + length > this.length) {
        _error.default.raise(10002, this.length, offset + length);
      }
      /* 优化178: 复用全局 Uint8Array 视图，避免每次 writeBytes 创建新视图 */
      if (_globalViewBuf !== this.view.buffer) {
        _globalViewBuf = this.view.buffer;
        _globalView = new Uint8Array(_globalViewBuf);
      }
      var vOff = this.view.byteOffset + offset;
      if (value instanceof Uint8Array) {
        _globalView.set(value, vOff);
      } else {
        _globalView.set(value instanceof ArrayBuffer ? new Uint8Array(value, 0, length) : new Uint8Array(value), vOff);
      }
      this.offset = offset + length;
      return this;
    }

    /**
     * 写空数据
     *
     * @param {number} length 长度
     * @param {number=} offset 起始偏移
     * @return {this}
     */
  }, {
    key: "writeEmpty",
    value: function writeEmpty(length, offset) {
      if (length < 0) {
        _error.default.raise(10002, this.length, length);
      }
      if (undefined === offset) {
        offset = this.offset;
      }
      /* 优化178: 复用全局视图 fill(0) */
      if (_globalViewBuf !== this.view.buffer) {
        _globalViewBuf = this.view.buffer;
        _globalView = new Uint8Array(_globalViewBuf);
      }
      _globalView.fill(0, this.view.byteOffset + offset, this.view.byteOffset + offset + length);
      this.offset = offset + length;
      return this;
    }

    /**
     * 写入一个string
     *
     * @param {string} str 字符串
     * @param {number=} length 长度
     * @param {number=} offset 偏移
     *
     * @return {this}
     */
  }, {
    key: "writeString",
    value: function writeString() {
      var str = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : '';
      var length = arguments.length > 1 ? arguments[1] : undefined;
      var offset = arguments.length > 2 ? arguments[2] : undefined;
      if (undefined === offset) {
        offset = this.offset;
      }
      // eslint-disable-next-line no-control-regex
      length = length || str.replace(/[^\x00-\xff]/g, '11').length;
      if (length < 0 || offset + length > this.length) {
        _error.default.raise(10002, this.length, offset + length);
      }
      /* 优化28: 直接 view 写入，替代逐字节 writeUint8/writeUint16 */
      var pos = offset;
      for (var i = 0, l = str.length, charCode; i < l; ++i) {
        charCode = str.charCodeAt(i);
        if (charCode > 127) {
          this.view.setUint16(pos, charCode, this.littleEndian);
          pos += 2;
        } else {
          this.view.setUint8(pos, charCode);
          pos += 1;
        }
      }
      this.offset = offset + length;
      return this;
    }

    /**
     * 写入一个字符
     *
     * @param {string} value 字符
     * @param {number=} offset 偏移
     * @return {this}
     */
  }, {
    key: "writeChar",
    value: function writeChar(value, offset) {
      return this.writeString(value, offset);
    }

    /**
     * 写入fixed类型
     *
     * @param {number} value 写入值
     * @param {number=} offset 偏移
     * @return {number} float
     */
  }, {
    key: "writeFixed",
    value: function writeFixed(value, offset) {
      if (undefined === offset) {
        offset = this.offset;
      }
      this.writeInt32((value * 65536 + 0.5) | 0, offset);
      return this;
    }

    /**
     * 写入长日期
     *
     * @param {Date} value 日期对象
     * @param {number=} offset 偏移
     *
     * @return {Date} Date对象
     */
  }, {
    key: "writeLongDateTime",
    value: function writeLongDateTime(value, offset) {
      if (undefined === offset) {
        offset = this.offset;
      }

      // new Date(1970, 1, 1).getTime() - new Date(1904, 1, 1).getTime();
      var delta = -2077545600000;
      if (typeof value === 'undefined') {
        value = delta;
      } else if (typeof value.getTime === 'function') {
        value = value.getTime();
      } else if (_isAllDigits.test(value)) {
        value = +value;
      } else {
        value = Date.parse(value);
      }
      var time = Math.round((value - delta) / 1000);
      this.writeUint32(0, offset);
      this.writeUint32(time, offset + 4);
      return this;
    }

    /**
     * 跳转到指定偏移
     *
     * @param {number=} offset 偏移
     * @return {this}
     */
  }, {
    key: "seek",
    value: function seek(offset) {
      if (undefined === offset) {
        this.offset = 0;
      }
      if (offset < 0 || offset > this.length) {
        _error.default.raise(10002, this.length, offset);
      }
      this._offset = this.offset;
      this.offset = offset;
      return this;
    }

    /**
     * 跳转到写入头部位置
     *
     * @return {this}
     */
  }, {
    key: "head",
    value: function head() {
      this.offset = this._offset || 0;
      return this;
    }

    /**
     * 获取缓存的byte数组
     *
     * @return {ArrayBuffer}
     */
  }, {
    key: "getBuffer",
    value: function getBuffer() {
      return this.view.buffer;
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
}(); // 优化19: 直接绑定方法，避免 curry 闭包开销
Writer.prototype.writeInt8 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 1; this.view.setInt8(offset, value, this.littleEndian); return this; };
Writer.prototype.writeUint8 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 1; this.view.setUint8(offset, value, this.littleEndian); return this; };
Writer.prototype.writeInt16 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 2; this.view.setInt16(offset, value, this.littleEndian); return this; };
Writer.prototype.writeUint16 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 2; this.view.setUint16(offset, value, this.littleEndian); return this; };
Writer.prototype.writeInt32 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 4; this.view.setInt32(offset, value, this.littleEndian); return this; };
Writer.prototype.writeUint32 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 4; this.view.setUint32(offset, value, this.littleEndian); return this; };
Writer.prototype.writeFloat32 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 4; this.view.setFloat32(offset, value, this.littleEndian); return this; };
Writer.prototype.writeFloat64 = function(value, offset) { if (offset === undefined) offset = this.offset; this.offset = offset + 8; this.view.setFloat64(offset, value, this.littleEndian); return this; };
var _default = exports.default = Writer;