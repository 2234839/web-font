/**
 * @file DOM解析器，兼容node端和浏览器端
 * @author mengke01(kekee000@gmail.com)
 */
/* eslint-disable no-undef */
import * as nodeModule from "node:module";

/** DOM 解析器构造器最小形状（浏览器 DOMParser 与 @xmldom/xmldom 的 DOMParser 共同满足） */
interface DOMParserLike {
  new (): {
    /** 解析字符串为 Document（两端 Document 形状不同，边界放宽为 any） */
    parseFromString(source: string, type: string): any;
  };
}

/**
 * 惰性获取 DOM 解析器：浏览器端用原生 window.DOMParser，node 端经
 * createRequire 引入 @xmldom/xmldom。必须惰性——模块顶层无法同步 require CJS
 * 依赖（ESM），且 svg 解析仅在解析 SVG 字体时才需要；浏览器侧本模块被 vite
 * shim 整体替换，不会走到 node 分支。
 */
let cached: DOMParserLike | null = null;

function loadNodeDOMParser(): DOMParserLike {
  // createRequire 是 ESM 环境下 require CJS 依赖的标准方式；用静态 import
  // 直接引入 node:module（Node 内置，浏览器 shim 分支不会走到这里）
  const { createRequire } = nodeModule;
  return createRequire(import.meta.url)('@xmldom/xmldom').DOMParser;
}

const parser = new Proxy({} as DOMParserLike, {
  construct(_target, args) {
    let impl = cached;
    if (!impl) {
      impl =
        typeof window !== 'undefined' && window.DOMParser
          ? window.DOMParser
          : loadNodeDOMParser();
      cached = impl;
    }
    return new impl(...(args as []));
  },
});

export default parser;
