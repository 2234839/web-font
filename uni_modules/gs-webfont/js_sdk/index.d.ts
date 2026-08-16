import { IncrementalEngine } from "webfont-sdk/engine";
//#region src/index.d.ts
/** 单个字体的加载选项 */
interface IUniFontOptions {
  /** 字体文件名（如 '令东齐伋复刻体.ttf'），服务端支持模糊匹配 */
  fontName: string;
  /** 子集化服务基地址，默认官方在线服务 */
  baseUrl?: string;
  /** loadFontFace 注册的 family 名，默认去掉扩展名的字体名 */
  family?: string;
  /**
   * 输出格式，默认 'ttf'。
   * 小程序建议 ttf（iOS 低版本对 woff2 兼容性差）；纯 H5 场景可传 'woff2' 省流量
   */
  outType?: 'ttf' | 'woff2';
  /** 是否全局生效（微信 2.10.0+，需在 App.vue 调用才对全 app 生效），默认 true */
  global?: boolean;
  /** 单次请求携带的最大字符数，超出自动分批串行加载，默认 300（URL 长度安全值） */
  maxCharsPerChunk?: number;
  /** 字体描述符透传（style / weight / variant） */
  desc?: {
    style?: string;
    weight?: string;
    variant?: string;
  };
  /** 是否在控制台输出调试日志 */
  debug?: boolean;
}
/** loadFont 返回的增量加载器 */
interface IUniFontLoader {
  /** 提交文本（自动去重，只请求出现过的字符） */
  update(text: string): void;
  /** 该字体是否有片段在请求/注册中 */
  isPending(): boolean;
  /** 等待全部在途片段就绪（截图/导出前调用） */
  ready(): Promise<void>;
  /** 清除失败记录，配合 update 重试失败字符 */
  retryFailed(): void;
  dispose(): void;
}
declare class UniWebFontMode {
  private engine;
  /** 未显式传 baseUrl 时的默认服务地址 */
  private defaultBaseUrl;
  constructor(config?: {
    baseUrl?: string;
  });
  getEngine(): IncrementalEngine;
  /**
   * 创建（或复用）一个字体的增量加载器。
   * 返回的 loader 可反复 update：引擎按字符去重，只有新字符触发网络请求
   */
  loadFont(options: IUniFontOptions): IUniFontLoader;
  /** 是否有片段在请求/注册中（所有字体） */
  hasPending(): boolean;
  /** 等待全部在途片段就绪（截图/导出前调用） */
  ready(): Promise<void>;
}
/** 默认实例（与 webfont-sdk 的 WebFont / WebFontCanvas 命名约定一致） */
declare const UniWebFont: UniWebFontMode;
//#endregion
export { IUniFontLoader, IUniFontOptions, UniWebFont, UniWebFontMode };