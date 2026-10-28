/**
 * 轮廓标记位（glyFlag.js 的类型声明）
 *
 * see:
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6glyf.html
 */
declare const glyFlag: {
  /** on curve, off curve */
  readonly ONCURVE: 0x01;
  /** x-Short Vector */
  readonly XSHORT: 0x02;
  /** y-Short Vector */
  readonly YSHORT: 0x04;
  /** next byte is flag repeat count */
  readonly REPEAT: 0x08;
  /** This x is same (Positive x-Short vector) */
  readonly XSAME: 0x10;
  /** This y is same (Positive y-Short vector) */
  readonly YSAME: 0x20;
  readonly Reserved1: 0x40;
  readonly Reserved2: 0x80;
};

export default glyFlag;
