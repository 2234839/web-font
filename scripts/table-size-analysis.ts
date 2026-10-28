/**
 * 表级体积分析：子集输出各 sfnt 表占比 + woff2 压缩率对比
 * 用法：pnpx tsx scripts/table-size-analysis.ts（仓库根目录执行）
 */
import { fontSubset } from "../backend/font_util/font.js";
import { readFileSync } from "fs";

/** 解析 sfnt 表目录，返回各表 (name, length) 按大小降序 */
function tableSizes(buf: Uint8Array): Array<[string, number]> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = dv.getUint16(4, false);
  const out: Array<[string, number]> = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const name = String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
    out.push([name, dv.getUint32(off + 12, false)!]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

/** 分析用例：[字体路径, 源格式, 测试文本] */
const cases: Array<[string, "ttf" | "otf", string]> = [
  ["font/令东齐伋复刻体.ttf", "ttf", "天地玄黄宇宙洪荒日月盈昃"],
  ["font/得意黑.ttf", "ttf", "你好，世界！测试标点。"],
  ["/mnt/d/字体资源/FiraCode/FiraCode-Medium.ttf", "ttf", "=> !== >= <= === function const"],
];

for (const [p, sourceType, text] of cases) {
  const buf = readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const ttf = fontSubset(ab, text, { sourceType, outType: "ttf" }) as Uint8Array;
  const woff2 = fontSubset(ab, text, { sourceType, outType: "woff2" }) as Uint8Array;
  const total = ttf.length;
  console.log(
    `\n== ${p.split("/").pop()} text=${text.slice(0, 8)}… ttf=${total}B woff2=${woff2.length}B (woff2/ttf=${((woff2.length / total) * 100).toFixed(0)}%)`,
  );
  for (const [name, len] of tableSizes(ttf)) {
    const bar = "█".repeat(Math.max(1, Math.round((len / total) * 40)));
    console.log(`  ${name.padEnd(6)} ${String(len).padStart(7)}B ${((len / total) * 100).toFixed(1).padStart(5)}% ${bar}`);
  }
}
