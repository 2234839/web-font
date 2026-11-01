import type { FontEditor } from "../../vendor/fonteditor-core/lib/ttf/font";
import { fontSubsetToObject, type SubsetResult } from "./font";
import { stat } from "../interface";
import { readFontBuffer } from "../shared";

/**
 * 根据源字体大小预留裁剪任务内存。
 * 轮廓解析、布局表重写和序列化会同时持有源文件及多份临时结构，不能只按源文件大小限流。
 */
export async function estimateSubsetMemory(fontPath: string): Promise<number> {
  const { size } = await stat(fontPath);
  return Math.max(64 * 1024 * 1024, size * 4);
}

/**
 * 字体裁剪的唯一文件入口。
 * HTTP 裁剪接口和截图找字体都调用这里，不额外缓存完整字体对象。
 * 返回的 ttf 为内存子集对象（可直接光栅化评分，免去序列化再解析）；
 * OTF（CFF）输入时 ttf 为 null。
 */
export async function subsetFontFile(
  fontPath: string,
  text: string,
  outType: FontEditor.FontType,
): Promise<SubsetResult & { bytes: Uint8Array; readMs: number; subsetMs: number }> {
  const sourceType = fontPath.split(".").pop() as FontEditor.FontType;
  const readStarted = Date.now();
  const fontBuffer = await readFontBuffer(fontPath);
  const subsetStarted = Date.now();
  const result = fontSubsetToObject(fontBuffer, text, { sourceType, outType });
  return {
    ...result,
    bytes: result.write(outType),
    readMs: subsetStarted - readStarted,
    subsetMs: Date.now() - subsetStarted,
  };
}
