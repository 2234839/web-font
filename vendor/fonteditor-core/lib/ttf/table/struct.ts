/**
 * @file ttf基本数据结构
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6.html
 */

/** struct 类型常量表 */
const struct = {
  /** Int8 */
  Int8: 1,
  /** Uint8 */
  Uint8: 2,
  /** Int16 */
  Int16: 3,
  /** Uint16 */
  Uint16: 4,
  /** Int32 */
  Int32: 5,
  /** Uint32 */
  Uint32: 6,
  /** 32-bit signed fixed-point number (16.16) */
  Fixed: 7,
  /** Smallest measurable distance in the em space */
  FUnit: 8,
  /** 16-bit signed fixed number with the low 14 bits of fraction */
  F2Dot14: 11,
  /**
   * The long internal format of a date in seconds since 12:00 midnight,
   * January 1, 1904. It is represented as a signed 64-bit integer.
   */
  LongDateTime: 12,
  /** extend data type */
  Char: 13,
  String: 14,
  Bytes: 15,
  Uint24: 20
};

/** 反转名字查找 */
const names: Record<number, string> = {};
for (const [key, value] of Object.entries(struct)) {
  names[value] = key;
}

export default Object.assign(struct, { names });
