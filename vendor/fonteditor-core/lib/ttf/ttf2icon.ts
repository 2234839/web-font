/**
 * @file ttf转icon
 * @author mengke01(kekee000@gmail.com)
 */

import TTFReader from "./ttfreader";
import error from "./error";
import defaultTtf from "./data/default";
import { getSymbolId } from "./ttf2symbol";

/** ttf 对象（字段动态访问） */
type TtfObject = Record<string, any>;

/** icon 字形条目 */
interface IconGlyfItem {
  /** 字形编码 */
  code: string;
  /** 编码名列表 */
  codeName: string;
  /** 字形名 */
  name: string;
  /** symbol id */
  id: string;
}

/** icon 数据结构 */
interface IconObject {
  /** 字体族名 */
  fontFamily: string;
  /** icon 类名前缀 */
  iconPrefix: string;
  /** 字形列表 */
  glyfList: IconGlyfItem[];
}

/**
 * listUnicode
 *
 * @param unicode unicode
 * @return unicode string
 */
function listUnicode(unicode: number[]): string {
  return unicode
    .map(function (u) {
      return "\\" + u.toString(16);
    })
    .join(",");
}

/**
 * ttf数据结构转icon数据结构
 *
 * @param ttf ttfObject对象
 * @param options 选项
 * @param options.iconPrefix icon 类名前缀
 * @return icon obj
 */
function ttfobject2icon(ttf: TtfObject, options: { iconPrefix?: string } = {}): IconObject {
  const glyfList: IconGlyfItem[] = [];

  // glyf 信息
  const filtered = ttf.glyf.filter(function (g: TtfObject) {
    return (
      g.name !== ".notdef" && g.name !== ".null" && g.name !== "nonmarkingreturn" && g.unicode && g.unicode.length
    );
  });
  filtered.forEach(function (g: TtfObject, i: number) {
    glyfList.push({
      code: "&#x" + g.unicode[0].toString(16) + ";",
      codeName: listUnicode(g.unicode),
      name: g.name,
      id: getSymbolId(g, i),
    });
  });
  return {
    fontFamily: ttf.name.fontFamily || defaultTtf.name.fontFamily,
    iconPrefix: options.iconPrefix || "icon",
    glyfList: glyfList,
  };
}

/**
 * ttf格式转换成icon
 *
 * @param ttfBuffer ttf缓冲数组或者ttfObject对象
 * @param options 选项
 * @return icon object
 */
export default function ttf2icon(
  ttfBuffer: ArrayBuffer | TtfObject,
  options: { iconPrefix?: string } = {}
): IconObject {
  // 读取ttf二进制流
  if (ttfBuffer instanceof ArrayBuffer) {
    const reader = new TTFReader();
    const ttfObject = reader.read(ttfBuffer);
    reader.dispose();
    return ttfobject2icon(ttfObject, options);
  }
  // 读取ttfObject
  else if (ttfBuffer.version && ttfBuffer.glyf) {
    return ttfobject2icon(ttfBuffer, options);
  }
  return error.raise(10101) as never;
}
