"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "Font", {
  enumerable: true,
  get: function get() {
    return _font.Font;
  }
});
Object.defineProperty(exports, "OTFReader", {
  enumerable: true,
  get: function get() {
    return _otfreader.default;
  }
});
Object.defineProperty(exports, "Reader", {
  enumerable: true,
  get: function get() {
    return _reader.default;
  }
});
Object.defineProperty(exports, "TTF", {
  enumerable: true,
  get: function get() {
    return _ttf.default;
  }
});
Object.defineProperty(exports, "TTFReader", {
  enumerable: true,
  get: function get() {
    return _ttfreader.default;
  }
});
Object.defineProperty(exports, "TTFWriter", {
  enumerable: true,
  get: function get() {
    return _ttfwriter.default;
  }
});
Object.defineProperty(exports, "Writer", {
  enumerable: true,
  get: function get() {
    return _writer.default;
  }
});
Object.defineProperty(exports, "createFont", {
  enumerable: true,
  get: function get() {
    return _font.createFont;
  }
});
exports.default = void 0;
Object.defineProperty(exports, "eot2ttf", {
  enumerable: true,
  get: function get() {
    return _eot2ttf.default;
  }
});
Object.defineProperty(exports, "otf2ttfobject", {
  enumerable: true,
  get: function get() {
    return _otf2ttfobject.default;
  }
});
Object.defineProperty(exports, "svg2ttfobject", {
  enumerable: true,
  get: function get() {
    return _svg2ttfobject.default;
  }
});
exports.toBuffer = exports.toArrayBuffer = void 0;
Object.defineProperty(exports, "ttf2base64", {
  enumerable: true,
  get: function get() {
    return _ttf2base.default;
  }
});
Object.defineProperty(exports, "ttf2eot", {
  enumerable: true,
  get: function get() {
    return _ttf2eot.default;
  }
});
Object.defineProperty(exports, "ttf2icon", {
  enumerable: true,
  get: function get() {
    return _ttf2icon.default;
  }
});
Object.defineProperty(exports, "ttf2svg", {
  enumerable: true,
  get: function get() {
    return _ttf2svg.default;
  }
});
Object.defineProperty(exports, "ttf2woff", {
  enumerable: true,
  get: function get() {
    return _ttf2woff.default;
  }
});
Object.defineProperty(exports, "ttftowoff2", {
  enumerable: true,
  get: function get() {
    return _ttftowoff.default;
  }
});
Object.defineProperty(exports, "woff2", {
  enumerable: true,
  get: function get() {
    return _index.default;
  }
});
Object.defineProperty(exports, "woff2tottf", {
  enumerable: true,
  get: function get() {
    return _woff2tottf.default;
  }
});
Object.defineProperty(exports, "woff2ttf", {
  enumerable: true,
  get: function get() {
    return _woff2ttf.default;
  }
});
var _font = require("./ttf/font");
var _ttf = _interopRequireDefault(require("./ttf/ttf"));
var _ttfreader = _interopRequireDefault(require("./ttf/ttfreader"));
var _ttfwriter = _interopRequireDefault(require("./ttf/ttfwriter"));
var _ttf2eot = _interopRequireDefault(require("./ttf/ttf2eot"));
var _eot2ttf = _interopRequireDefault(require("./ttf/eot2ttf"));
var _ttf2woff = _interopRequireDefault(require("./ttf/ttf2woff"));
var _woff2ttf = _interopRequireDefault(require("./ttf/woff2ttf"));
var _ttf2svg = _interopRequireDefault(require("./ttf/ttf2svg"));
var _svg2ttfobject = _interopRequireDefault(require("./ttf/svg2ttfobject"));
var _reader = _interopRequireDefault(require("./ttf/reader"));
var _writer = _interopRequireDefault(require("./ttf/writer"));
var _otfreader = _interopRequireDefault(require("./ttf/otfreader"));
var _otf2ttfobject = _interopRequireDefault(require("./ttf/otf2ttfobject"));
var _ttf2base = _interopRequireDefault(require("./ttf/ttf2base64"));
var _ttf2icon = _interopRequireDefault(require("./ttf/ttf2icon"));
var _ttftowoff = _interopRequireDefault(require("./ttf/ttftowoff2"));
var _woff2tottf = _interopRequireDefault(require("./ttf/woff2tottf"));
var _index = _interopRequireDefault(require("../woff2/index"));
var _buffer = _interopRequireDefault(require("./nodejs/buffer"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 主函数
 * @author mengke01(kekee000@gmail.com)
 */

var toArrayBuffer = exports.toArrayBuffer = _buffer.default.toArrayBuffer;
var toBuffer = exports.toBuffer = _buffer.default.toBuffer;
var _default = exports.default = {
  createFont: _font.createFont,
  Font: _font.Font,
  TTF: _ttf.default,
  TTFReader: _ttfreader.default,
  TTFWriter: _ttfwriter.default,
  ttf2eot: _ttf2eot.default,
  eot2ttf: _eot2ttf.default,
  ttf2woff: _ttf2woff.default,
  woff2ttf: _woff2ttf.default,
  ttf2svg: _ttf2svg.default,
  svg2ttfobject: _svg2ttfobject.default,
  Reader: _reader.default,
  Writer: _writer.default,
  OTFReader: _otfreader.default,
  otf2ttfobject: _otf2ttfobject.default,
  ttf2base64: _ttf2base.default,
  ttf2icon: _ttf2icon.default,
  ttftowoff2: _ttftowoff.default,
  woff2tottf: _woff2tottf.default,
  woff2: _index.default,
  toArrayBuffer: _buffer.default.toArrayBuffer,
  toBuffer: _buffer.default.toBuffer
};