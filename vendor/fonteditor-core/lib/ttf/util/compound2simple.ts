/**
 * @file 复合字形设置轮廓，转化为简单字形
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 复合字形转简单字形
 *
 * @param glyf glyf对象
 * @param contours 轮廓数组
 * @return 转换后对象
 */
export default function compound2simple(glyf: any, contours: any[]): any {
  glyf.contours = contours;
  /** 优化260: delete → null 赋值，避免 V8 隐藏类转换 */
  glyf.compound = null;
  glyf.glyfs = null;
  glyf.instructions = null;
  return glyf;
}
