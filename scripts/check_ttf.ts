import { readFile } from "node:fs/promises";
import { Font } from "../vendor/fonteditor-core/lib/ttf/font.js";

const raw = await readFile("font/temp/YiShanBeiZhuanTi.ttf");
const buf = new Uint8Array(raw).buffer;
const text = "你好世界";
const subset = [...text].map(c => c.codePointAt(0));

const font = Font.create(buf, { type: "ttf", subset });
const optimized = font.optimize().sort();
const result = optimized.write({ type: "ttf" });
const data = new Uint8Array(result);

console.log("=== TTF Header ===");
const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
console.log("sfVersion:", "0x" + view.getUint32(0, false).toString(16));
console.log("numTables:", view.getUint16(4, false));

const tables: Array<{ tag: string; offset: number; length: number }> = [];
for (let i = 0; i < view.getUint16(4, false); i++) {
  const offset = 12 + i * 16;
  const tag = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  const toffset = view.getUint32(offset + 8, false);
  const tlength = view.getUint32(offset + 12, false);
  tables.push({ tag, offset: toffset, length: tlength });
  console.log("  ", tag, "offset=" + toffset, "length=" + tlength);
}

const headEntry = tables.find(t => t.tag === "head");
if (headEntry) {
  const magic = view.getUint32(headEntry.offset + 12, false);
  console.log("\nhead magicNumber:", "0x" + magic.toString(16), magic === 0x5F0F3CF5 ? "OK" : "INVALID!");
}

console.log("\nfile size:", data.length);
console.log("last table end:", Math.max(...tables.map(t => t.offset + t.length)));

/** 和原始字体对比 */
const origView = new DataView(buf);
console.log("\n=== 原始字体 ===");
console.log("sfVersion:", "0x" + origView.getUint32(0, false).toString(16));
console.log("numTables:", origView.getUint16(4, false));
