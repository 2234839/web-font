/**
 * @file fonteditor-core 入口（ESM 版，自 main.js 重写）
 * @author mengke01(kekee000@gmail.com)
 */
import Font, { createFont } from "./ttf/font";
import TTF from "./ttf/ttf";
import TTFReader from "./ttf/ttfreader";
import TTFWriter from "./ttf/ttfwriter";
import ttf2eot from "./ttf/ttf2eot";
import eot2ttf from "./ttf/eot2ttf";
import ttf2woff from "./ttf/ttf2woff";
import ttf2svg from "./ttf/ttf2svg";
import svg2ttfobject from "./ttf/svg2ttfobject";
import ttf2symbol from "./ttf/ttf2symbol";
import otf2ttfobject from "./ttf/otf2ttfobject";
import ttf2base64 from "./ttf/ttf2base64";
import eot2base64 from "./ttf/eot2base64";
import woff2base64 from "./ttf/woff2base64";
import svg2base64 from "./ttf/svg2base64";
import woff2tottf from "./ttf/woff2tottf";
import woff2ttf from "./ttf/woff2ttf";
import ttftowoff2 from "./ttf/ttftowoff2";
import woff2tobase64 from "./ttf/woff2tobase64";
import woff2 from "../woff2/index";

export default {
  Font,
  createFont,
  TTF,
  TTFReader,
  TTFWriter,
  ttf2eot,
  eot2ttf,
  ttf2woff,
  ttf2svg,
  svg2ttfobject,
  ttf2symbol,
  otf2ttfobject,
  ttf2base64,
  eot2base64,
  woff2base64,
  svg2base64,
  woff2tottf,
  woff2ttf,
  ttftowoff2,
  woff2tobase64,
  woff2,
};

export { Font, createFont, TTF, TTFReader, TTFWriter, woff2 };
