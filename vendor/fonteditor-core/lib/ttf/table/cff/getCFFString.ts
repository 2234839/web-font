/**
 * @file 获取cff字符串
 * @author mengke01(kekee000@gmail.com)
 */
import cffStandardStrings from "./cffStandardStrings";

/**
 * 根据索引获取cff字符串
 *
 * @param strings 标准cff字符串索引
 * @param index 索引号
 * @return 字符串索引
 */
function getCFFString(strings: string[], index: number) {
  if (index <= 390) {
    return cffStandardStrings[index];
  }
  // Strings below index 392 are standard CFF strings and are not encoded in the font.
  return strings[index - 391];
}

export default getCFFString;
