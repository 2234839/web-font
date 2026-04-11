import { Font } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import type { FontEditor } from "../../vendor/fonteditor-core/lib/ttf/font.js";

/** 优化291: TextEncoder 模块级单例 */
const textEncoder = new TextEncoder();

/**
 * 字体裁剪的所有可配置步骤
 * 每个步骤独立导出，方便组合使用和单独测试
 */

/** 从字符串提取 Unicode 码点数组 */
export const textToCodePoints = (text: string) => {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) as number;
    result.push(cp);
    if (cp > 0xFFFF) i++; /** 跳过代理对的低半部分 */
  }
  return result;
};

/**
 * 解析字体并执行 subset（最耗时的步骤）
 */
export const createSubsetFont = (
  fontBuffer: ArrayBuffer,
  codePoints: number[],
  sourceType: FontEditor.FontType,
) =>
  Font.create(fontBuffer, {
    type: sourceType,
    subset: codePoints,
  });

/**
 * 优化字体（去冗余表、清理无用字形）
 * subset 模式下 TTFReader.resolveGlyf 已完成 compound2simple，跳过
 * optimizettf 已设置 _unicodeSorted=true，sortGlyf 会直接返回
 */
export const optimizeFont = (font: ReturnType<typeof Font.create>) => {
  const optimized = font.optimize();
  return optimized;
};

/** 序列化为指定格式的二进制数据 */
/** 优化291: 移除 async，消除不必要的微任务调度 */
export const writeFont = (
  font: ReturnType<ReturnType<typeof Font.create>["optimize"]>,
  outType: FontEditor.FontType,
): Uint8Array => {
  const result = font.write({ type: outType });
  if (typeof result === "string") {
    return textEncoder.encode(result);
  }
  /** 优化278: Buffer 是 Uint8Array 子类，直接返回避免多余拷贝 */
  if (result instanceof Uint8Array) {
    return result;
  }
  return new Uint8Array(result);
};

/**
 * 完整的字体裁剪流程（当前生产实现）
 * 解析 -> subset -> 优化 -> 序列化
 * 优化293: 移除 async，函数体内无 await，消除不必要的 Promise 包装和微任务调度
 */
export const fontSubset = (
  fontBuffer: ArrayBuffer,
  subString: string,
  option: { sourceType: FontEditor.FontType; outType: FontEditor.FontType },
): Uint8Array => {
  const codePoints = textToCodePoints(subString);
  const font = createSubsetFont(fontBuffer, codePoints, option.sourceType);
  const optimized = optimizeFont(font);
  return writeFont(optimized, option.outType);
};
