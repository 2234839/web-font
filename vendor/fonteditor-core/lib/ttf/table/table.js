"use strict";

function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _struct = _interopRequireDefault(require("./struct"));
var _error = _interopRequireDefault(require("../error"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } } /**
 * @file ttf表基类
 * @author mengke01(kekee000@gmail.com)
 */
/* eslint-disable no-invalid-this */
/**
 * 读取表结构
 *
 * @param {Reader} reader reader对象
 * @return {Object} 当前对象
 */
function read(reader) {
  var offset = this.offset;
  if (undefined !== offset) {
    reader.seek(offset);
  }
  var me = this;
  var struct = this.struct;
  for (var si = 0, sl = struct.length; si < sl; si++) {
    var item = struct[si];
    var name = item[0];
    var type = item[1];
    var typeName = null;
    switch (type) {
      case _struct.default.Int8:
      case _struct.default.Uint8:
      case _struct.default.Int16:
      case _struct.default.Uint16:
      case _struct.default.Int32:
      case _struct.default.Uint32:
        typeName = _struct.default.names[type];
        me[name] = reader.read(typeName);
        break;
      case _struct.default.Fixed:
        me[name] = reader.readFixed();
        break;
      case _struct.default.LongDateTime:
        me[name] = reader.readLongDateTime();
        break;
      case _struct.default.Bytes:
        me[name] = reader.readBytes(reader.offset, item[2] || 0);
        break;
      case _struct.default.Char:
        me[name] = reader.readChar();
        break;
      case _struct.default.String:
        me[name] = reader.readString(reader.offset, item[2] || 0);
        break;
      default:
        _error.default.raise(10003, name, type);
    }
  }
  return this.valueOf();
}

/**
 * 写表结构
 *
 * @param {Object} writer writer对象
 * @param {Object} ttf 已解析的ttf对象
 *
 * @return {Writer} 返回writer对象
 */
function write(writer, ttf) {
  var table = ttf[this.name];
  if (!table) {
    _error.default.raise(10203, this.name);
  }
  var struct = this.struct;
  /* 优化152: 直接分发到 writer 方法，消除 string 类型名中间层双重 switch */
  for (var si = 0, sl = struct.length; si < sl; si++) {
    var item = struct[si];
    var name = item[0];
    switch (item[1]) {
      case 1: writer.write('Int8', table[name]); break;
      case 2: writer.write('Uint8', table[name]); break;
      case 3: writer.write('Int16', table[name]); break;
      case 4: writer.write('Uint16', table[name]); break;
      case 5: writer.write('Int32', table[name]); break;
      case 6: writer.write('Uint32', table[name]); break;
      case 7: writer.writeFixed(table[name]); break;
      case 12: writer.writeLongDateTime(table[name]); break;
      case 13: writer.writeChar(table[name]); break;
      case 14: writer.writeString(table[name], item[2] || 0); break;
      case 15: writer.writeBytes(table[name], item[2] || 0); break;
      default: _error.default.raise(10003, name, item[1]);
    }
  }
  return writer;
}

/**
 * 获取ttf表的size大小
 *
 * @param {string} name 表名
 * @return {number} 表大小
 */
/* 优化152: 类型大小查找表，替代 switch 循环 */
var TYPE_SIZES = [0, 1, 1, 2, 2, 4, 4, 4, 0, 0, 0, 2, 8, 1, 0, 0, 0, 0, 0, 0, 3];

function size() {
  var sz = 0;
  var struct = this.struct;
  for (var si = 0, sl = struct.length; si < sl; si++) {
    var item = struct[si];
    var t = item[1];
    /* Bytes/String 使用 item[2] 指定长度，其余查表 */
    sz += (t === 15 || t === 14) ? (item[2] || 0) : TYPE_SIZES[t];
  }
  return sz;
}

/**
 * 获取对象的值
 *
 * @return {*} 当前对象的值
 */
function valueOf() {
  var val = {};
  var me = this;
  var struct = this.struct;
  for (var si = 0, sl = struct.length; si < sl; si++) {
    val[struct[si][0]] = me[struct[si][0]];
  }
  return val;
}
var _default = exports.default = {
  read: read,
  write: write,
  size: size,
  valueOf: valueOf,
  /**
   * 创建一个表结构
   *
   * @param {string} name 表名
   * @param {Array<[string, number]>} struct 表结构
   * @param {Object} proto 原型
   * @return {Function} 表构造函数
   */
  create: function create(name, struct, proto) {
    var Table = /*#__PURE__*/_createClass(function Table(offset) {
      _classCallCheck(this, Table);
      this.name = name;
      this.struct = struct;
      this.offset = offset;
    });
    Table.prototype.read = read;
    Table.prototype.write = write;
    Table.prototype.size = size;
    Table.prototype.valueOf = valueOf;
    Object.assign(Table.prototype, proto);
    return Table;
  }
};