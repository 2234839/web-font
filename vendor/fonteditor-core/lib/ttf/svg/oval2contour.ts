import { computePath } from "../../graphics/computeBoundingBox";
import pathAdjust from "../../graphics/pathAdjust";
import circle from "../../graphics/path/circle";
import { clone } from "../../common/lang";

/**
 * @file 椭圆转换成轮廓
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 椭圆转换成轮廓
 *
 * @param cx 椭圆中心点x
 * @param cy 椭圆中心点y
 * @param rx 椭圆x轴半径
 * @param ry 椭圆y周半径
 * @return 轮廓数组
 */
export default function oval2contour(cx: number, cy: number, rx: number, ry?: number): any[] {
  if (undefined === ry) {
    ry = rx;
  }
  const bound = computePath(circle as any);
  if (!bound) {
    throw new Error("[svg.oval2contour] computePath returned false for unit circle");
  }
  const scaleX = (+rx * 2) / bound.width;
  const scaleY = (+ry! * 2) / bound.height;
  const centerX = (bound.width * scaleX) / 2;
  const centerY = (bound.height * scaleY) / 2;
  const contour = clone(circle);
  pathAdjust(contour, scaleX, scaleY);
  pathAdjust(contour, 1, 1, +cx - centerX, +cy - centerY);
  return contour;
}
