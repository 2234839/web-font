import { Font, type FontEditor } from "fonteditor-core";

/**
 * 字体裁剪的所有可配置步骤
 * 每个步骤独立导出，方便组合使用和单独测试
 */

/** 从字符串提取 Unicode 码点数组 */
export const textToCodePoints = (text: string) =>
  [...text].map((char) => char.codePointAt(0)!);

/** 解析字体并执行 subset（最耗时的步骤） */
export const createSubsetFont = (
  fontBuffer: ArrayBuffer,
  codePoints: number[],
  sourceType: FontEditor.FontType,
) =>
  Font.create(fontBuffer, {
    type: sourceType,
    subset: codePoints,
  });

/** 优化字体（去冗余表、清理无用字形） */
export const optimizeFont = (font: ReturnType<typeof Font.create>) => {
  let optimized = font.optimize();
  optimized = optimized.compound2simple();
  optimized = optimized.sort();
  return optimized;
};

/** 序列化为指定格式的二进制数据 */
export const writeFont = (
  font: ReturnType<ReturnType<typeof Font.create>["optimize"]>,
  outType: FontEditor.FontType,
) => {
  const result = font.write({ type: outType });
  if (typeof result !== "string") {
    return new Uint8Array(result);
  }
  return new TextEncoder().encode(result);
};

/**
 * 完整的字体裁剪流程（当前生产实现）
 * 解析 -> subset -> 优化 -> 序列化
 */
export const fontSubset = async (
  fontBuffer: ArrayBuffer,
  subString: string,
  option: { sourceType: FontEditor.FontType; outType: FontEditor.FontType },
) => {
  const codePoints = textToCodePoints(subString);
  const font = createSubsetFont(fontBuffer, codePoints, option.sourceType);
  const optimized = optimizeFont(font);
  return writeFont(optimized, option.outType);
};
