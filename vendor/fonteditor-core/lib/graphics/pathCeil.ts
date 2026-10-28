/**
 * @file 对路径进行四舍五入
 * @author mengke01(kekee000@gmail.com)
 */

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
type Contour = PathPoint[] | number[];

/**
 * 检测扁平格式 - 第一个元素是 number 则为扁平格式（优化66）
 */
function isFlatContour(contour: Contour): contour is number[] {
  return typeof contour[0] === "number";
}

/**
 * 对path坐标进行调整
 */
export default function pathCeil(
  /** 轮廓点数组（对象格式或扁平格式 [x, y, onCurve, ...]） */
  contour: Contour,
  /** 四舍五入的小数位数 */
  point?: number
): Contour {
  if (!contour.length) {
    return contour;
  }
  /* 优化66: 检测扁平格式 */
  if (isFlatContour(contour)) {
    for (let i = 0, l = contour.length; i < l; i += 3) {
      if (!point) {
        contour[i] = Math.round(contour[i]);
        contour[i + 1] = Math.round(contour[i + 1]);
      } else {
        contour[i] = Number(contour[i].toFixed(point));
        contour[i + 1] = Number(contour[i + 1].toFixed(point));
      }
    }
  } else {
    for (const p of contour) {
      if (!point) {
        p.x = Math.round(p.x);
        p.y = Math.round(p.y);
      } else {
        p.x = Number(p.x.toFixed(point));
        p.y = Number(p.y.toFixed(point));
      }
    }
  }
  return contour;
}
