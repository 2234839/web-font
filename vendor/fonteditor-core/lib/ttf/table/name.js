"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _nameId = _interopRequireDefault(require("../enum/nameId"));
var _string = _interopRequireDefault(require("../util/string"));
var _platform = _interopRequireDefault(require("../enum/platform"));
var _encoding = require("../enum/encoding");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file name表
 * @author mengke01(kekee000@gmail.com)
 */
var _default = exports.default = _table.default.create('name', [], {
  read: function read(reader) {
    var offset = this.offset;
    /* 直接 view 批量读取 */
    var view = reader.view;
    var vOffset = view.byteOffset + offset;
    var nameTbl = {};
    nameTbl.format = view.getUint16(vOffset, false); vOffset += 2;
    nameTbl.count = view.getUint16(vOffset, false); vOffset += 2;
    nameTbl.stringOffset = view.getUint16(vOffset, false); vOffset += 2;
    var count = nameTbl.count;
    var nameRecordTbl = new Array(count);
    for (var i = 0; i < count; ++i) {
      nameRecordTbl[i] = {
        platform: view.getUint16(vOffset, false),
        encoding: view.getUint16(vOffset + 2, false),
        language: view.getUint16(vOffset + 4, false),
        nameId: view.getUint16(vOffset + 6, false),
        length: view.getUint16(vOffset + 8, false),
        offset: view.getUint16(vOffset + 10, false)
      };
      vOffset += 12;
    }
    reader.offset = vOffset - view.byteOffset;

    var baseOffset = offset + nameTbl.stringOffset;
    for (var j = 0; j < count; ++j) {
      nameRecordTbl[j].name = reader.readBytes(baseOffset + nameRecordTbl[j].offset, nameRecordTbl[j].length);
    }
    var names = {};

    var platform = _platform.default.Macintosh;
    var encoding = _encoding.mac.Default;
    var language = 0;

    /* 检查是否有 windows english name */
    for (var k = 0; k < count; k++) {
      if (nameRecordTbl[k].platform === _platform.default.Microsoft && nameRecordTbl[k].encoding === _encoding.win.UCS2 && nameRecordTbl[k].language === 1033) {
        platform = _platform.default.Microsoft;
        encoding = _encoding.win.UCS2;
        language = 1033;
        break;
      }
    }
    for (var m = 0; m < count; ++m) {
      var nameRecord = nameRecordTbl[m];
      if (nameRecord.platform === platform && nameRecord.encoding === encoding && nameRecord.language === language && _nameId.default[nameRecord.nameId]) {
        names[_nameId.default[nameRecord.nameId]] = language === 0 ? _string.default.getUTF8String(nameRecord.name) : _string.default.getUCS2String(nameRecord.name);
      }
    }
    return names;
  },
  write: function write(writer, ttf) {
    var nameRecordTbl = ttf.support.name;
    /* view 批量写入 */
    var pos = writer.offset;
    var view = writer.view;
    view.setUint16(pos, 0, false); pos += 2;
    view.setUint16(pos, nameRecordTbl.length, false); pos += 2;
    view.setUint16(pos, 6 + nameRecordTbl.length * 12, false); pos += 2;

    var offset = 0;
    for (var i = 0, l = nameRecordTbl.length; i < l; i++) {
      var r = nameRecordTbl[i];
      view.setUint16(pos, r.platform, false); pos += 2;
      view.setUint16(pos, r.encoding, false); pos += 2;
      view.setUint16(pos, r.language, false); pos += 2;
      view.setUint16(pos, r.nameId, false); pos += 2;
      view.setUint16(pos, r.name.length, false); pos += 2;
      view.setUint16(pos, offset, false); pos += 2;
      offset += r.name.length;
    }

    /** 优化206: 直接 fullView.set 替代 writer.writeBytes，消除函数调用+边界检查开销 */
    var fullView = new Uint8Array(view.buffer, view.byteOffset);
    for (var j = 0, jl = nameRecordTbl.length; j < jl; j++) {
      fullView.set(nameRecordTbl[j].name, pos);
      pos += nameRecordTbl[j].name.length;
    }
    writer.offset = pos;
    return writer;
  },
  size: function size(ttf) {
    var names = ttf.name;
    var nameRecordTbl = [];

    // 写入name信息
    // 这里为了简化书写，仅支持英文编码字符，
    // 中文编码字符将被转化成url encode
    var size = 6;
    /** 优化239: Object.keys + for 替代 for...in */
    var nameKeys = Object.keys(names);
    for (var ki = 0, kl = nameKeys.length; ki < kl; ki++) {
      var ki_name = nameKeys[ki];
      var name = ki_name;
      var id = _nameId.default.names[name];
      var utf8Bytes = _string.default.toUTF8Bytes(names[ki_name]);
      var usc2Bytes = _string.default.toUCS2Bytes(names[ki_name]);
      if (undefined !== id) {
        // mac
        nameRecordTbl.push({
          nameId: id,
          platform: 1,
          encoding: 0,
          language: 0,
          name: utf8Bytes
        });

        // windows
        nameRecordTbl.push({
          nameId: id,
          platform: 3,
          encoding: 1,
          language: 1033,
          name: usc2Bytes
        });

        // 子表大小
        size += 12 * 2 + utf8Bytes.length + usc2Bytes.length;
      }
    }
    var namingOrder = ['platform', 'encoding', 'language', 'nameId'];
    nameRecordTbl = nameRecordTbl.sort(function (a, b) {
      for (var ni = 0; ni < 4; ni++) {
        var o = a[namingOrder[ni]] - b[namingOrder[ni]];
        if (o) return o;
      }
      return 0;
    });

    // 保存预处理信息
    ttf.support.name = nameRecordTbl;
    return size;
  }
});