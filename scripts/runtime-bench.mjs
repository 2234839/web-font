/**
 * 三运行时（LLRT / Node / Perry）性能对比压测
 *
 * 用法：node scripts/runtime-bench.mjs [port]（默认 8090，服务需已启动并预热）
 * 输出：JSON 结果到 stdout（外层 shell 负责汇总成报告）
 *
 * 两类测试：
 * 1. 字体裁剪：典型用例（8字/千字文 × ttf/woff2 等），预热后计 p50/p95
 * 2. 字体搜索：POST /api/glyph-match（位图→字形匹配）
 */
const PORT = process.argv[2] || "8090";
const BASE = `http://127.0.0.1:${PORT}`;

/** 裁剪用例（覆盖 小/中文/长文/woff2压缩/标点/大字号字体） */
/** 随机化字符池（千字文全集采样，保证每次请求不同 → 不命中 subsetCache，测真实裁剪计算） */
const POOL = "天地玄黄宇宙洪荒日月盈昃宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王";

/** 生成随机不重复文本（长度固定，内容每请求不同） */
function randText(len) {
  let s = "";
  while (s.length < len) s += POOL[Math.floor(Math.random() * POOL.length)];
  return s.slice(0, len);
}

const SUBSET_CASES = [
  { name: "8字-ttf", font: "令东齐伋复刻体.ttf", textLen: 8, outType: "ttf" },
  { name: "8字-woff2", font: "令东齐伋复刻体.ttf", textLen: 8, outType: "woff2" },
  { name: "千字文128字-ttf", font: "令东齐伋复刻体.ttf", textLen: 128, outType: "ttf" },
  { name: "千字文128字-woff2", font: "令东齐伋复刻体.ttf", textLen: 128, outType: "woff2" },
  { name: "思源黑体-8字-woff2", font: "思源黑体.ttf", textLen: 8, outType: "woff2" },
  { name: "思源黑体-128字-woff2", font: "思源黑体.ttf", textLen: 128, outType: "woff2" },
];

const REPEAT = 15;

/** 单请求计时，返回 ms（失败/超时返回 -status） */
async function timed(url, opts, timeoutMs = 60000) {
  const t0 = performance.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...opts });
    await resp.arrayBuffer();
    return resp.status === 200 ? performance.now() - t0 : -resp.status;
  } catch (e) {
    const ms = performance.now() - t0;
    return e?.name === "TimeoutError" || ms >= timeoutMs - 50 ? -1 : -0;
  }
}

/** 百分位 */
function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
}

async function main() {
  const result = { port: PORT, subset: [], search: null };

  /** 裁剪：每请求随机文字（强制缓存不命中，测真实计算），预热只暖字体文件缓存 */
  for (const c of SUBSET_CASES) {
    await timed(`${BASE}/api?font=${encodeURIComponent(c.font)}&text=${encodeURIComponent(randText(c.textLen))}&outType=${c.outType}`, {}); // 预热字体文件 IO
    const runs = [];
    for (let i = 0; i < REPEAT; i++)
      runs.push(await timed(`${BASE}/api?font=${encodeURIComponent(c.font)}&text=${encodeURIComponent(randText(c.textLen))}&outType=${c.outType}`, {}));
    const ok = runs.filter((x) => x > 0);
    result.subset.push({
      name: c.name,
      n: ok.length,
      p50: ok.length ? +pct(ok, 50).toFixed(1) : null,
      p95: ok.length ? +pct(ok, 95).toFixed(1) : null,
      avg: ok.length ? +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(1) : null,
      fails: runs.length - ok.length,
    });
  }

  /** 字体搜索：读测试位图请求体 */
  const body = (await import("node:fs")).readFileSync("/tmp/gm_body.json");
  const gmOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  await timed(`${BASE}/api/glyph-match`, gmOpts); // 预热
  const runs = [];
  for (let i = 0; i < REPEAT; i++) runs.push(await timed(`${BASE}/api/glyph-match`, gmOpts));
  const ok = runs.filter((x) => x > 0);
  result.search = {
    n: ok.length,
    p50: ok.length ? +pct(ok, 50).toFixed(1) : null,
    p95: ok.length ? +pct(ok, 95).toFixed(1) : null,
    avg: ok.length ? +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(1) : null,
    fails: runs.length - ok.length,
  };

  console.log(JSON.stringify(result));
}

main();
