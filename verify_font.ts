/**
 * 字体裁剪正确性验证工具
 *
 * 用法:
 *   pnpm tsx verify_font.ts baseline — 生成基准（用当前代码裁剪 + 渲染图片）
 *   pnpm tsx verify_font.ts          — 对比当前代码与基准
 *
 * 验证方式:
 *   1. 结构化对比（glyf contours/pts/unicode/advanceWidth）
 *   2. 渲染相似度对比（skia-canvas 渲染，SSIM 相似度阈值）
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Font } from "fonteditor-core";
import { Canvas, FontLibrary } from "skia-canvas";

const isBaseline = process.argv[2] === "baseline";

const FONT_PATH = "font/令东齐伋复刻体.ttf";
const FONT_NAME = "令东齐伋复刻体";
const SIMILARITY_THRESHOLD = 0.98;

const raw = await readFile(FONT_PATH);
const fontBuffer = new Uint8Array(raw).buffer;

FontLibrary.use(FONT_NAME, FONT_PATH);

const testCases = [
  { text: "天地玄黄宇宙洪荒", label: "8个汉字" },
  { text: "Hello World 123", label: "拉丁+数字" },
  { text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", label: "千字文前段" },
];

/** 子集字体注册计数器 */
let subsetFontCounter = 0;


/** 渲染文字到纯图片数据（不保存文件），返回 Uint8Array */
function renderText(fontFamily: string, text: string, fontSize: number): Uint8Array {
  const charWidth = Math.ceil(fontSize * 1.5);
  const width = text.length * charWidth + 20;
  const height = Math.ceil(fontSize * 1.5);
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle = "black";
  ctx.fillText(text, 10, Math.ceil(fontSize * 1.2));
  const imgData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(imgData.data.buffer);
}

/**
 * 计算两张图片的结构相似度（简化版 SSIM）
 * 返回 0~1 之间的值，1 表示完全相同
 */
function calculateSSIM(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;

  /** 转灰度 */
  const toGray = (data: Uint8Array, offset: number) =>
    0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];

  const pixelCount = a.length / 4;
  let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const ga = toGray(a, idx);
    const gb = toGray(b, idx);
    sumA += ga;
    sumB += gb;
    sumA2 += ga * ga;
    sumB2 += gb * gb;
    sumAB += ga * gb;
  }

  const meanA = sumA / pixelCount;
  const meanB = sumB / pixelCount;
  const varA = sumA2 / pixelCount - meanA * meanA;
  const varB = sumB2 / pixelCount - meanB * meanB;
  const covAB = sumAB / pixelCount - meanA * meanB;

  const C1 = 6.5025;
  const C2 = 58.5225;

  const ssim =
    (2 * meanA * meanB + C1) * (2 * covAB + C2) /
    ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));

  return ssim;
}

/** 从 Font 对象中提取可对比的结构数据 */
function extractFontData(font: any) {
  const d = font.data;
  const glyf = d.glyf.map((g: any, i: number) => {
    const contourHeads = g.contours
      ? g.contours.map((c: any[]) =>
          c.slice(0, 3).map((p: any) => [p.x, p.y, !!p.onCurve])
        )
      : [];
    return {
      index: i,
      contours: g.contours?.length || 0,
      pts: g.contours ? g.contours.reduce((s: number, c: any[]) => s + c.length, 0) : 0,
      compound: !!g.compound,
      unicode: g.unicode ? [...g.unicode].sort((a: number, b: number) => a - b) : [],
      advanceWidth: g.advanceWidth,
      leftSideBearing: g.leftSideBearing,
      contourHeads,
    };
  });

  const out = font.write({ type: "ttf" });
  const buf = out instanceof ArrayBuffer ? out : new Uint8Array(out as any).buffer;
  const view = new DataView(buf);
  const numTables = view.getUint16(4, false);
  const tables: Record<string, { offset: number; length: number; checksum: number }> = {};
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(base), view.getUint8(base + 1),
      view.getUint8(base + 2), view.getUint8(base + 3)
    );
    tables[tag] = {
      offset: view.getUint32(base + 8, false),
      length: view.getUint32(base + 12, false),
      checksum: view.getUint32(base + 4, false),
    };
  }

  return { glyfCount: d.glyf.length, glyf, outputSize: buf.byteLength, tables, buffer: buf };
}

/** 注册子集字体并返回 fontFamily 名 */
async function registerSubsetFont(ttfBuffer: ArrayBuffer, counter: number): Promise<string> {
  const fontPath = `verify_font_baseline/_verify_${counter}.ttf`;
  await writeFile(fontPath, Buffer.from(ttfBuffer));
  const familyName = `SubsetFont_${counter}`;
  FontLibrary.use(familyName, [fontPath]);
  return familyName;
}

if (isBaseline) {
  await mkdir("verify_font_baseline", { recursive: true });
  const baseline: Record<string, any> = {};

  for (const { text, label } of testCases) {
    const subset = [...text].map((c) => c.codePointAt(0)!);
    const font = Font.create(fontBuffer, { type: "ttf", subset });
    const data = extractFontData(font);

    await writeFile(`verify_font_baseline/${label}.ttf`, Buffer.from(data.buffer));

    /** 用完整字体和子集字体分别渲染，保存像素数据 */
    const fullPixels = renderText(FONT_NAME, text, 48);

    subsetFontCounter++;
    const familyName = await registerSubsetFont(data.buffer, subsetFontCounter);
    const subsetPixels = renderText(familyName, text, 48);

    const ssim = calculateSSIM(fullPixels, subsetPixels);

    const { buffer: _, ...structData } = data;
    baseline[label] = {
      ...structData,
      fullPixels: Array.from(fullPixels),
      subsetPixels: Array.from(subsetPixels),
      ssim,
    };
    console.log(`  ${label}: glyf=${data.glyfCount}, output=${data.outputSize} bytes, ssim=${ssim.toFixed(4)}`);
  }

  await writeFile("verify_font_baseline.json", JSON.stringify(baseline, null, 2));
  console.log("\n基准已生成（含完整字体+子集字体渲染像素数据及相似度）");
} else {
  const baselineRaw = await readFile("verify_font_baseline.json", "utf-8");
  const baseline = JSON.parse(baselineRaw);

  let allPassed = true;
  for (const { text, label } of testCases) {
    const expected = baseline[label];
    if (!expected) { console.log(`? ${label}: 无基准数据`); continue; }

    const subset = [...text].map((c) => c.codePointAt(0)!);
    const font = Font.create(fontBuffer, { type: "ttf", subset });
    const actual = extractFontData(font);

    const errors: string[] = [];

    /** 1. 结构化对比 */
    if (actual.glyfCount !== expected.glyfCount) {
      errors.push(`glyfCount: ${actual.glyfCount} != ${expected.glyfCount}`);
    }
    for (let i = 0; i < Math.max(actual.glyf.length, expected.glyf.length); i++) {
      const a = actual.glyf[i];
      const e = expected.glyf[i];
      if (!a || !e) { errors.push(`glyf[${i}]: 缺失`); continue; }
      if (a.contours !== e.contours) errors.push(`glyf[${i}].contours: ${a.contours} != ${e.contours}`);
      if (a.pts !== e.pts) errors.push(`glyf[${i}].pts: ${a.pts} != ${e.pts}`);
      if (a.compound !== e.compound) errors.push(`glyf[${i}].compound: ${a.compound} != ${e.compound}`);
      if (JSON.stringify(a.unicode) !== JSON.stringify(e.unicode)) errors.push(`glyf[${i}].unicode: ${JSON.stringify(a.unicode)} != ${JSON.stringify(e.unicode)}`);
      if (a.advanceWidth !== e.advanceWidth) errors.push(`glyf[${i}].advanceWidth: ${a.advanceWidth} != ${e.advanceWidth}`);
      if (JSON.stringify(a.contourHeads) !== JSON.stringify(e.contourHeads)) errors.push(`glyf[${i}].contourHeads: 不一致`);
    }

    /** 2. 渲染相似度对比：当前子集字体 vs 基准完整字体 */
    const fullPixels = new Uint8Array(expected.fullPixels);
    subsetFontCounter++;
    const familyName = await registerSubsetFont(actual.buffer, subsetFontCounter);
    const currentPixels = renderText(familyName, text, 48);
    const ssim = calculateSSIM(fullPixels, currentPixels);

    if (ssim < SIMILARITY_THRESHOLD) {
      errors.push(`渲染相似度: ${ssim.toFixed(4)} < 阈值 ${SIMILARITY_THRESHOLD}`);
    }

    if (errors.length === 0) {
      console.log(`✓ ${label}: PASS (glyf=${actual.glyfCount}, output=${actual.outputSize} bytes, ssim=${ssim.toFixed(4)})`);
    } else {
      allPassed = false;
      console.log(`✗ ${label}: FAIL (${errors.length} errors)`);
      for (const err of errors) console.log(`    ${err}`);
    }
  }

  console.log(`\n${allPassed ? "ALL PASSED ✓" : "SOME CHECKS FAILED ✗"}`);
  if (!allPassed) process.exit(1);
}
