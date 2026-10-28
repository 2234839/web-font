/**
 * @file otf格式转ttf格式对象
 * @author mengke01(kekee000@gmail.com)
 */

import error from "./error";
import OTFReader from "./otfreader";
import { otfContours2ttfContoursInPlace } from "./util/otfContours2ttfContours";

/** otf/ttf 对象（字段动态访问） */
type FontObject = Record<string, any>;

/**
 * otf格式转ttf格式对象
 *
 * @param otfBuffer 原始数据或者解析后的otf数据
 * @param options 参数
 * @return ttfObject对象
 */
export default function otf2ttfobject(
  otfBuffer: ArrayBuffer | FontObject,
  options?: object
): FontObject {
  let otfObject: FontObject;
  if (otfBuffer instanceof ArrayBuffer) {
    const otfReader = new OTFReader(options);
    otfObject = otfReader.read(otfBuffer);
    otfReader.dispose();
  } else if (otfBuffer.head && otfBuffer.glyf && otfBuffer.cmap) {
    otfObject = otfBuffer;
  } else {
    return error.raise(10111);
  }

  // 转换otf轮廓，同时获取包围盒
  const glyf = otfObject.glyf;
  /* 使用就地写入版本，消除每个 glyph 一次中间对象分配 */
  const convertInPlace = otfContours2ttfContoursInPlace;
  for (let i = 0, l = glyf.length; i < l; i++) {
    convertInPlace(glyf[i].contours, glyf[i]);
  }
  otfObject.version = 0x1;

  // 修改maxp相关配置
  otfObject.maxp.version = 1.0;
  otfObject.maxp.maxZones = otfObject.maxp.maxTwilightPoints ? 2 : 1;

  /**
   * OTF→TTF 转换后字体没有 TrueType instructions，
   * 必须清除 head.flags 中"依赖 hinting"的标志位，
   * 否则浏览器会跳过渲染（skia-canvas 不受影响）。
   * 同时清除"lossless"标志，因为三次→二次贝塞尔转换是有损的。
   */
  otfObject.head.flags = (otfObject.head.flags || 0) & ~(0x0008 | 0x0800);
  otfObject.head.fontDirectionHint = 2;
  /* delete → null 赋值，避免 V8 隐藏类转换 */
  otfObject.CFF = null;
  otfObject.VORG = null;
  return otfObject;
}
