/**
 * SSIM（结构相似性）计算 —— Wang 2004 实现
 *
 * 与 scripts/ssim.ts（基准测试用）同算法，此处为前端字体识别页面独立持有，
 * 输入约定一致：RGBA 像素数据，width*height*4 === data.length，否则返回 0。
 */

export function calculateSSIM(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  if (a.length !== b.length) return 0;
  if (width * height * 4 !== a.length) return 0;
  if (width === 0 || height === 0) return 0;

  /** 转灰度并提取到独立数组 */
  const N = width * height;
  const grayA = new Float64Array(N);
  const grayB = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    grayA[i] = 0.299 * a[idx]! + 0.587 * a[idx + 1]! + 0.114 * a[idx + 2]!;
    grayB[i] = 0.299 * b[idx]! + 0.587 * b[idx + 1]! + 0.114 * b[idx + 2]!;
  }

  /** 构建积分图: S(x,y) = sum of gray[0..x-1, 0..y-1] */
  const w1 = width + 1;
  const intA = new Float64Array(w1 * (height + 1));
  const intA2 = new Float64Array(w1 * (height + 1));
  const intB = new Float64Array(w1 * (height + 1));
  const intB2 = new Float64Array(w1 * (height + 1));
  const intAB = new Float64Array(w1 * (height + 1));

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const irowOff = (y + 1) * w1;
    for (let x = 0; x < width; x++) {
      const va = grayA[rowOff + x]!;
      const vb = grayB[rowOff + x]!;
      const ip = irowOff + x + 1;
      intA[ip] = va + intA[ip - 1]! + intA[ip - w1]! - intA[ip - w1 - 1]!;
      intA2[ip] = va * va + intA2[ip - 1]! + intA2[ip - w1]! - intA2[ip - w1 - 1]!;
      intB[ip] = vb + intB[ip - 1]! + intB[ip - w1]! - intB[ip - w1 - 1]!;
      intB2[ip] = vb * vb + intB2[ip - 1]! + intB2[ip - w1]! - intB2[ip - w1 - 1]!;
      intAB[ip] = va * vb + intAB[ip - 1]! + intAB[ip - w1]! - intAB[ip - w1 - 1]!;
    }
  }

  /** 从积分图计算矩形区域 [x1, x2) x [y1, y2) 的和 */
  const rectSum = (img: Float64Array, x1: number, y1: number, x2: number, y2: number) =>
    img[y2 * w1 + x2]! - img[y1 * w1 + x2]! - img[y2 * w1 + x1]! + img[y1 * w1 + x1]!;

  /** 11x11 窗口, 半径=5 */
  const R = 5;
  /** (0.01 * 255)^2 */
  const C1 = 6.5025;
  /** (0.03 * 255)^2 */
  const C2 = 58.5225;

  /** 窗口尺寸过小时（< 11px）退化为全图单窗口，避免 SSIM 恒 0 */
  const wx1 = Math.max(1, Math.min(R, Math.floor(width / 2)));
  const wx2 = Math.max(wx1 + 1, width - Math.min(R, Math.floor(width / 2)));
  const wy1 = Math.max(1, Math.min(R, Math.floor(height / 2)));
  const wy2 = Math.max(wy1 + 1, height - Math.min(R, Math.floor(height / 2)));

  let ssimSum = 0;
  let windowCount = 0;

  for (let y = wy1; y < wy2; y++) {
    for (let x = wx1; x < wx2; x++) {
      const x1 = x - R, x2 = x + R + 1;
      const y1 = y - R, y2 = y + R + 1;
      const n = (2 * R + 1) * (2 * R + 1);

      const sA = rectSum(intA, x1, y1, x2, y2);
      const sA2 = rectSum(intA2, x1, y1, x2, y2);
      const sB = rectSum(intB, x1, y1, x2, y2);
      const sB2 = rectSum(intB2, x1, y1, x2, y2);
      const sAB = rectSum(intAB, x1, y1, x2, y2);

      const muA = sA / n;
      const muB = sB / n;
      const sigmaA2 = sA2 / n - muA * muA;
      const sigmaB2 = sB2 / n - muB * muB;
      const sigmaAB = sAB / n - muA * muB;

      ssimSum +=
        ((2 * muA * muB + C1) * (2 * sigmaAB + C2)) /
        ((muA * muA + muB * muB + C1) * (sigmaA2 + sigmaB2 + C2));
      windowCount++;
    }
  }

  return windowCount === 0 ? 0 : ssimSum / windowCount;
}
