import transformGlyfContours from "./transformGlyfContours";
import compound2simple from "./compound2simple";

/**
 * @file ttf复合字形转简单字形
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * ttf复合字形转简单字形
 *
 * @param glyf glyf对象或者glyf索引
 * @param ttf ttfObject对象
 * @param recrusive 是否递归的进行转换，如果复合字形为嵌套字形，则转换每一个复合字形
 * @return 转换后的对象
 */
export default function compound2simpleglyf(glyf: any, ttf: any, recrusive?: boolean): any {
  let glyfIndex: number;
  // 兼容索引和对象传入
  if (typeof glyf === "number") {
    glyfIndex = glyf;
    glyf = ttf.glyf[glyfIndex];
  } else {
    glyfIndex = ttf.glyf.indexOf(glyf);
    if (-1 === glyfIndex) {
      return glyf;
    }
  }
  if (!glyf.compound || !glyf.glyfs) {
    return glyf;
  }
  const contoursList: Record<number, any[]> = {};
  transformGlyfContours(glyf, ttf, contoursList, glyfIndex);
  if (recrusive) {
    /* 优化62: for...in 替代 Object.keys + forEach */
    for (const idx in contoursList) {
      const target = ttf.glyf[idx];
      compound2simple(target, contoursList[idx]);
      if (target.contours && target.contours.length && typeof target.contours[0][0] === "number") {
        target._flatContours = true;
      }
    }
  } else {
    compound2simple(glyf, contoursList[glyfIndex]);
    /* 优化66: 检测扁平格式并设置标记 */
    if (glyf.contours && glyf.contours.length && typeof glyf.contours[0][0] === "number") {
      glyf._flatContours = true;
    }
  }
  return glyf;
}
