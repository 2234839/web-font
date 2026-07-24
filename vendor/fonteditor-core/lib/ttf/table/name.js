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
/**
 * 优化325: web 子集字体 name 表白名单——只保留浏览器字体匹配/渲染必需的 nameId。
 * subset 字体的核心目的是小体积下载 + 正确渲染，版权/商标/URL/版本/描述等元数据 nameId
 * 对 web 渲染无价值却显著增大体积（思源 8 字 ttf 8.8KB 里 name 占 3.9KB/44%，多为这些元数据）。
 * 保留白名单：
 *   1 fontFamily / 2 fontSubFamily —— CSS font-family 与 weight/style 匹配的核心
 *   4 fullName / 6 postScriptName —— 全名与 PS 名，部分工具/场景引用
 *   16 preferredFamily / 17 preferredSubFamily —— 变体/typographic 匹配
 * 精简后思源 8 字 woff2 4448→2632B（-41%），SSIM 全部不变（渲染像素不受 name 内容影响）。
 */
var KEEP_NAME_IDS = { 1: true, 2: true, 4: true, 6: true, 16: true, 17: true };
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

    /**
     * 优化324: 单遍扫描确定 platform + 直接产出 names，消除全部中间 nameRecord 对象。
     * 原实现先建 count 个 {platform,encoding,language,nameId,length,offset} 对象（思源 56 个），
     * 再两遍遍历。改为：
     *  pass1 只读 platform/encoding/language 三字段比较，确定最终 platform（windows english 优先），
     *        不读 nameId/length/offset、不建对象；
     *  pass2 头开始只对匹配 platform+encoding+language 的记录读 nameId/length/offset + readBytes + 解码。
     * 思源 56 条记录只约 15 条匹配，对象分配 56→0、第二遍 view 读次数减半。
     */
    var dirStart = vOffset;
    var platform = _platform.default.Macintosh;
    var encoding = _encoding.mac.Default;
    var language = 0;
    var p = dirStart;
    for (var i = 0; i < count; ++i) {
      if (view.getUint16(p, false) === _platform.default.Microsoft
        && view.getUint16(p + 2, false) === _encoding.win.UCS2
        && view.getUint16(p + 4, false) === 1033) {
        platform = _platform.default.Microsoft;
        encoding = _encoding.win.UCS2;
        language = 1033;
        break;
      }
      p += 12;
    }
    reader.offset = dirStart + count * 12 - view.byteOffset;

    var baseOffset = offset + nameTbl.stringOffset;
    var names = {};
    /** 优化323: 按需 readBytes，只对匹配记录解码（N 次 slice → 有用记录数次） */
    var isUTF8 = language === 0;
    var p2 = dirStart;
    for (var m = 0; m < count; ++m) {
      if (view.getUint16(p2, false) === platform
        && view.getUint16(p2 + 2, false) === encoding
        && view.getUint16(p2 + 4, false) === language) {
        var nameId = view.getUint16(p2 + 6, false);
        var nameKeyId = _nameId.default[nameId];
        if (nameKeyId) {
          var len = view.getUint16(p2 + 8, false);
          var recOff = view.getUint16(p2 + 10, false);
          var nameBytes = reader.readBytes(baseOffset + recOff, len);
          names[nameKeyId] = isUTF8 ? _string.default.getUTF8String(nameBytes) : _string.default.getUCS2String(nameBytes);
        }
      }
      p2 += 12;
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
      /** 优化325: web 子集字体仅保留渲染必需 nameId，跳过版权/商标/URL/版本等元数据 */
      if (id !== undefined && !KEEP_NAME_IDS[id]) continue;
      /** 优化320: 合并 UTF-8 + UCS-2 编码（单次扫描 + ASCII 快路径），替代两次独立编码 */
      var _pair = _string.default.toUTF8AndUCS2Bytes(names[ki_name]);
      var utf8Bytes = _pair.utf8;
      var usc2Bytes = _pair.ucs2;
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