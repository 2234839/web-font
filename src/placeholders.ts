/**
 * SSG 模板占位符 —— 前后端共享
 *
 * Vue 组件用这些常量渲染模板（SSG 产出含占位符的 HTML），
 * 后端读取模板 HTML 后用 replaceAll 替换为实际值。
 *
 * 约定：占位符用双下划线包裹，避免和正常文本冲突。
 */

/** 字体名称占位符（如 "令东齐伋复刻体.ttf"） */
export const FONT_NAME = "__FONT_NAME__";

/** 字体 slug 占位符（URL 路径部分，如 "令东齐伋复刻体.ttf"） */
export const FONT_SLUG = "__FONT_SLUG__";

/** 站点 origin 占位符（如 "https://webfont.shenzilong.cn"） */
export const ORIGIN = "__ORIGIN__";

/**
 * 占位符 → 实际值 的映射类型
 * 后端替换时传入此对象
 */
export type PlaceholderValues = {
  [FONT_NAME]: string;
  [FONT_SLUG]: string;
  [ORIGIN]: string;
};
