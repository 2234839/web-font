/**
 * @file 缩减path大小，去除冗余节点
 * @author mengke01(kekee000@gmail.com)
 */
import reducePathFlat from "./reducePathFlat";

/** 路径点 */
interface PathPoint {
  /** 水平坐标 */
  x: number;
  /** 垂直坐标 */
  y: number;
  /** 是否曲线端点 */
  onCurve?: boolean;
}

/** 轮廓：对象格式或扁平格式 [x, y, onCurve, ...] */
export type Contour = PathPoint[] | number[];

/**
 * 判断轮廓是否为扁平格式
 */
function isFlatContour(contour: Contour): contour is number[] {
  /* 检测扁平格式 - 第一个元素是 number 则为扁平格式 */
  return typeof contour[0] === 'number';
}

/**
 * 判断点是否多余的点
 *
 * @param prev 上一个
 * @param p 当前
 * @param next 下一个
 * @return 是否多余
 */
function redundant(
  /** 上一个 */
  prev: PathPoint,
  /** 当前 */
  p: PathPoint,
  /** 下一个 */
  next: PathPoint
): boolean {
  /* Math.pow(x,2) → x*x，提取 dx/dy 避免重复计算；p.onCurve === next.onCurve 替代双重布尔运算 */
  const dx = p.x - next.x;
  const dy = p.y - next.y;
  if (p.onCurve === next.onCurve && dx * dx + dy * dy <= 1) {
    return true;
  }

  /* 叉积复用 dx/dy，减少 2 次减法；坐标为整数时叉积也是整数，取反判断替代浮点比较 */
  const cross = dx * (prev.y - p.y) - dy * (prev.x - p.x);
  if (prev.onCurve && next.onCurve && !cross) {
    return true;
  }

  return false;
}

/**
 * 缩减glyf，去除冗余节点
 *
 * @param contour 路径对象（对象格式或扁平格式 [x, y, onCurve, ...]）
 * @return 路径对象
 */
export default function reducePath(
  /** 路径对象 */
  contour: Contour
): Contour {
  if (!contour.length) {
    return contour;
  }

  if (isFlatContour(contour)) {
    return reducePathFlat(contour);
  }

  /* write-index 替代 splice，O(n) 替代 O(n²) */
  const len = contour.length;
  let writeIdx = 0;
  for (let i = 0; i < len; i++) {
    const next = i === len - 1 ? contour[0] : contour[i + 1];
    const prev = i === 0 ? contour[len - 1] : contour[i - 1];
    const cur = contour[i];
    if (!redundant(prev, cur, next)) {
      contour[writeIdx++] = cur;
    }
  }
  contour.length = writeIdx;
  return contour;
}
