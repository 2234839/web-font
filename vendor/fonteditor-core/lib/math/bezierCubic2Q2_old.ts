/**
 * @file 三次贝塞尔转二次贝塞尔（高精度递归分割版）
 * @author mengke01(kekee000@gmail.com)
 *
 * 改进：递归分割三次贝塞尔直到可精确近似，提高 SSIM
 */

const MAX_DEPTH = 4;

/** 路径点 */
interface PathPoint {
  /** 水平坐标 */
  x: number;
  /** 垂直坐标 */
  y: number;
  /** 是否曲线端点 */
  onCurve?: boolean;
}

/** 单段二次贝塞尔：[起点, 控制点, 终点] */
type QuadSegment = [PathPoint, PathPoint, PathPoint];

function isFlatEnough(p1x: number, p1y: number, c1x: number, c1y: number, c2x: number, c2y: number, p2x: number, p2y: number): boolean {
  const ux = 3 * c1x - 2 * p1x - p2x;
  const uy = 3 * c1y - 2 * p1y - p2y;
  const vx = 3 * c2x - 2 * p2x - p1x;
  const vy = 3 * c2y - 2 * p2y - p1y;
  return Math.max(ux * ux + uy * uy, vx * vx + vy * vy) <= 0.25;
}

function cubicToQuads(p1x: number, p1y: number, c1x: number, c1y: number, c2x: number, c2y: number, p2x: number, p2y: number, depth: number, endpoints: PathPoint[], controls: PathPoint[]): void {
  if (isFlatEnough(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y) || depth >= MAX_DEPTH) {
    controls.push({
      x: (3 * c2x - p2x + 3 * c1x - p1x) * 0.25,
      y: (3 * c2y - p2y + 3 * c1y - p1y) * 0.25
    });
    return;
  }

  const m01x = (p1x + c1x) * 0.5, m01y = (p1y + c1y) * 0.5;
  const m12x = (c1x + c2x) * 0.5, m12y = (c1y + c2y) * 0.5;
  const m23x = (c2x + p2x) * 0.5, m23y = (c2y + p2y) * 0.5;
  const m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  const m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  const midx = (m012x + m123x) * 0.5, midy = (m012y + m123y) * 0.5;

  cubicToQuads(p1x, p1y, m01x, m01y, m012x, m012y, midx, midy, depth + 1, endpoints, controls);
  endpoints.push({ x: midx, y: midy, onCurve: true });
  cubicToQuads(midx, midy, m123x, m123y, m23x, m23y, p2x, p2y, depth + 1, endpoints, controls);
}

/**
 * 三次贝塞尔转二次贝塞尔（旧实现，保留对照）
 */
function bezierCubic2Q2(p1: PathPoint, c1: PathPoint, c2: PathPoint, p2: PathPoint): QuadSegment[] {
  if (p1.x === c1.x && p1.y === c1.y && c2.x === p2.x && c2.y === p2.y) {
    return [[p1, {
      x: (p1.x + p2.x) * 0.5,
      y: (p1.y + p2.y) * 0.5
    }, p2]];
  }

  const endpoints: PathPoint[] = [];
  const controls: PathPoint[] = [];
  cubicToQuads(p1.x, p1.y, c1.x, c1.y, c2.x, c2.y, p2.x, p2.y, 0, endpoints, controls);

  const segments: QuadSegment[] = [];
  let prev = p1;
  for (let i = 0; i < controls.length; i++) {
    const next = i < endpoints.length ? endpoints[i] : p2;
    segments.push([prev, controls[i], next]);
    prev = next;
  }
  return segments;
}

export default bezierCubic2Q2;
