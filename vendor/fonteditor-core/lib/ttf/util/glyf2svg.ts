import contours2svg from "./contours2svg";
import transformGlyfContours from "./transformGlyfContours";

/**
 * @file glyf转换svg，复合字形轮廓需要ttfObject支持
 * @author mengke01(kekee000@gmail.com)
 *
 * thanks to：
 * ynakajima/ttf.js
 * https://github.com/ynakajima/ttf.js
 */

/**
 * glyf转换svg
 *
 * @param glyf 解析后的glyf结构
 * @param ttf ttf对象
 * @return svg文本
 */
export default function glyf2svg(glyf: any, ttf: any): string {
  if (!glyf) {
    return "";
  }
  const pathArray: string[] = [];
  if (!glyf.compound) {
    if (glyf.contours && glyf.contours.length) {
      pathArray.push(contours2svg(glyf.contours));
    }
  } else {
    const contours = transformGlyfContours(glyf, ttf);
    if (contours && contours.length) {
      pathArray.push(contours2svg(contours));
    }
  }
  return pathArray.join(" ");
}
