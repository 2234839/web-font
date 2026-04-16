/**
 * LLRT 字体裁剪 — 生成子集字体供 Node 渲染验证
 * 运行: pnpm build_backend && ./llrt dist_backend/llrt_bench.lrt
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Font } from "./vendor/fonteditor-core/lib/ttf/font.js";

const FONT_PATH = "font/令东齐伋复刻体.ttf";
const FONT_NAME = "令东齐伋复刻体";
const BENCHMARK_DIR = "benchmark_results";

const testCases = [
  { label: "8个汉字", text: "天地玄黄宇宙洪荒" },
  { label: "拉丁+数字", text: "Hello World 123" },
  { label: "千字文前段", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔" },
];

const ROUNDS = 10;

async function main() {
  const raw = await readFile(FONT_PATH);
  const fontBuffer = new Uint8Array(raw).buffer;

  await mkdir(BENCHMARK_DIR, { recursive: true });

  console.log("\n=== LLRT 字体裁剪验证 ===\n");
  console.log("[runtime]", globalThis.process?.release?.name ?? "unknown");
  console.log("[font]", FONT_PATH, "size:", fontBuffer.byteLength, "bytes\n");

  const summary: Array<{ label: string; text: string; avg: number; min: number; max: number; outputSize: number; fontFile: string }> = [];

  for (const { label, text } of testCases) {
    const subset = [...text].map((c) => c.codePointAt(0)!);
    const times: number[] = [];
    let lastOutput: Uint8Array | null = null;

    for (let i = 0; i < ROUNDS; i++) {
      const t0 = performance.now();
      const font = Font.create(fontBuffer, { type: "ttf", subset });
      const optimized = font.optimize().sort();
      const result = optimized.write({ type: "ttf" });
      const t1 = performance.now();
      times.push(t1 - t0);

      if (i === 0) {
        lastOutput = typeof result === "string"
          ? new TextEncoder().encode(result)
          : new Uint8Array(result);
      }
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const size = lastOutput?.length ?? 0;

    /** 保存子集字体文件 */
    const safeLabel = label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
    const fontFile = `${BENCHMARK_DIR}/llrt_${safeLabel}.ttf`;
    if (lastOutput) {
      await writeFile(fontFile, lastOutput);
    }

    summary.push({ label, text, avg, min, max, outputSize: size, fontFile });
    console.log(`  ${label}: avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms  输出=${size.toLocaleString()} bytes`);
  }

  await writeFile(
    `${BENCHMARK_DIR}/llrt_bench_meta.json`,
    JSON.stringify({ runtime: globalThis.process?.release?.name, fontPath: FONT_PATH, fontName: FONT_NAME, rounds: ROUNDS, results: summary }, null, 2),
  );

  console.log("\n子集字体已保存");
}

main();
