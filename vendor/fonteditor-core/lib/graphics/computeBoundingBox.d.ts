/**
 * 包围盒计算（graphics/computeBoundingBox.js 的类型声明）
 */

/** 包围盒 */
export interface BoundBox {
  /** 水平最小值 */
  x: number;
  /** 垂直最小值 */
  y: number;
  /** 宽度 */
  width: number;
  /** 高度 */
  height: number;
}

/**
 * 计算轮廓点边界；轮廓为空时运行时返回 false（调用方需保证传入非空轮廓）
 */
export function computePath(
  /** 支持多个轮廓 */
  ...contours: object[][]
): BoundBox;

/**
 * 计算曲线点边界（内联展开版，避免中间对象分配）
 */
export function computePathBox(
  /** 支持多个轮廓 */
  ...contours: object[][]
): BoundBox;
