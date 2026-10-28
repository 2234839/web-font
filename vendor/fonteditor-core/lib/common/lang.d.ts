/**
 * 通用工具函数（common/lang.js 的类型声明）
 */

/**
 * 将 thatObj 的指定字段覆写到 thisObj 上
 */
export function overwrite(
  thisObj: object,
  thatObj: object,
  /** 需要覆写的字段名列表；未指定则仅覆写 thisObj 自身可枚举的字段 */
  fields?: string[]
): void;
