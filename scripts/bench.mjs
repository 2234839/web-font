/**
 * 线上高并发压测脚本 —— 每次请求随机字体+随机文字（不命中缓存）
 *
 * 用法：
 *   node scripts/bench.mjs [并发数] [总请求数]
 *   node scripts/bench.mjs           # 默认 20 并发 100 请求
 *   node scripts/bench.mjs 50 200    # 50 并发 200 请求
 *   node scripts/bench.mjs 100 200   # 100 并发极限测试
 */
const FONTS = [
  "令东齐伋复刻体.ttf",
  "霞鹜文楷.ttf",
  "得意黑.ttf",
  "龙藏体.ttf",
  "马善政楷体.ttf",
  "钟齐志莽行书.ttf",
  "悠哉字体.ttf",
  "马克笔哥特体.ttf",
];
const CHARS =
  "天地玄黄宇宙洪荒阴阳变化春夏秋冬风花雪月山川河海诗词歌赋琴棋书画梅兰竹菊龙凤呈祥福禄寿喜吉祥如意清风明月高山流水";
const ORIGIN = "https://webfont.shenzilong.cn";

/** 随机生成一条 /api 子集请求 URL（字体随机、文字随机） */
function randUrl(): string {
  const font = FONTS[Math.floor(Math.random() * FONTS.length)];
  /** 随机 2~8 个字 */
  const len = 2 + Math.floor(Math.random() * 7);
  let text = "";
  for (let i = 0; i < len; i++) {
    text += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return (
    ORIGIN +
    "/api?font=" +
    encodeURIComponent(font) +
    "&text=" +
    encodeURIComponent(text) +
    "&outType=woff2"
  );
}

const concurrency = parseInt(process.argv[2] || "20");
const total = parseInt(process.argv[3] || "100");

/** 单次请求：返回状态码+耗时(ms) */
async function fetchOne(
  url: string,
): Promise<{ status: number; ms: number }> {
  const t0 = performance.now();
  try {
    const resp = await fetch(url);
    await resp.arrayBuffer();
    return { status: resp.status, ms: performance.now() - t0 };
  } catch {
    return { status: 0, ms: performance.now() - t0 };
  }
}

async function main() {
  console.log(
    `=== ${concurrency} 并发, ${total} 请求, 每次随机字体+文字 ===`,
  );

  const results: { status: number; ms: number }[] = [];
  let nextIdx = 0;

  /** worker 线程：循环抢任务执行 */
  async function worker() {
    while (nextIdx < total) {
      nextIdx++;
      results.push(await fetchOne(randUrl()));
    }
  }

  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );
  const elapsed = (performance.now() - t0) / 1000;

  const ok = results.filter((r) => r.status === 200);
  const fail = results.filter((r) => r.status !== 200);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);

  console.log(`总耗时: ${elapsed.toFixed(1)}s | QPS: ${(total / elapsed).toFixed(1)}`);
  console.log(
    `成功: ${ok.length}/${total} (${((ok.length / total) * 100).toFixed(0)}%) | 失败: ${fail.length}`,
  );

  if (times.length) {
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `延迟 avg=${avg.toFixed(0)}ms  p50=${p50.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  max=${times[times.length - 1].toFixed(0)}ms`,
    );
  }

  if (fail.length) {
    const codes: Record<number, number> = {};
    fail.forEach((r) => {
      codes[r.status] = (codes[r.status] || 0) + 1;
    });
    console.log("失败状态码:", codes);
  }
}

main();
