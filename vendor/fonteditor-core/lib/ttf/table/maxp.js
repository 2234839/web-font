"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file maxp 表
 * @author mengke01(kekee000@gmail.com)
 */
var _default = exports.default = _table.default.create('maxp', [['version', _struct.default.Fixed], ['numGlyphs', _struct.default.Uint16], ['maxPoints', _struct.default.Uint16], ['maxContours', _struct.default.Uint16], ['maxCompositePoints', _struct.default.Uint16], ['maxCompositeContours', _struct.default.Uint16], ['maxZones', _struct.default.Uint16], ['maxTwilightPoints', _struct.default.Uint16], ['maxStorage', _struct.default.Uint16], ['maxFunctionDefs', _struct.default.Uint16], ['maxInstructionDefs', _struct.default.Uint16], ['maxStackElements', _struct.default.Uint16], ['maxSizeOfInstructions', _struct.default.Uint16], ['maxComponentElements', _struct.default.Uint16], ['maxComponentDepth', _struct.default.Int16]], {
  /** 优化178: 直接 view 写入 32 字节，注意写入 ttf.support.maxp */
  write: function write(writer, ttf) {
    var m = ttf.support.maxp;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, Math.round(m.version * 65536), false); pos += 4;
    view.setUint16(pos, m.numGlyphs, false); pos += 2;
    view.setUint16(pos, m.maxPoints, false); pos += 2;
    view.setUint16(pos, m.maxContours, false); pos += 2;
    view.setUint16(pos, m.maxCompositePoints, false); pos += 2;
    view.setUint16(pos, m.maxCompositeContours, false); pos += 2;
    view.setUint16(pos, m.maxZones, false); pos += 2;
    view.setUint16(pos, m.maxTwilightPoints, false); pos += 2;
    view.setUint16(pos, m.maxStorage, false); pos += 2;
    view.setUint16(pos, m.maxFunctionDefs, false); pos += 2;
    view.setUint16(pos, m.maxInstructionDefs, false); pos += 2;
    view.setUint16(pos, m.maxStackElements, false); pos += 2;
    view.setUint16(pos, m.maxSizeOfInstructions, false); pos += 2;
    view.setUint16(pos, m.maxComponentElements, false); pos += 2;
    view.setInt16(pos, m.maxComponentDepth, false); pos += 2;
    writer.offset = pos;
    return writer;
  },
  size: function size() {
    return 32;
  }
});