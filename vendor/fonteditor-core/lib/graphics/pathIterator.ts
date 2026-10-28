/**
 * @file 遍历路径的路径集合，包括segment和 bezier curve
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

/**
 * 遍历回调：command 为 L（直线）时 p2 恒为数字 0 占位；为 Q（二次贝塞尔）时 p2 为曲线终点
 */
type PathIteratorCallback = (
  /** 命令类型 */
  command: "L" | "Q",
  /** 命令起点 */
  p0: PathPoint,
  /** 控制点（L 时为终点） */
  p1: PathPoint,
  /** 终点（L 时为数字 0） */
  p2: PathPoint | number,
  /** 当前遍历的点索引 */
  i: number
) => boolean | void;

/**
 * 遍历路径的路径集合，包括segment和 bezier curve
 */
function pathIterator(
  /** 坐标点集 */
  contour: PathPoint[],
  /** 回调函数，返回 false 中断遍历 */
  callBack: PathIteratorCallback
): void {
  let curPoint: PathPoint;
  let prevPoint: PathPoint;
  let nextPoint: PathPoint;
  /* 优化: 复用临时对象，避免每次分配 */
  const tmpPoint = { x: 0, y: 0 };

  // cursorPoint 为当前单个绘制命令的起点（首轮 i=0 必然重新赋值）
  let cursorPoint: PathPoint = tmpPoint;

  for (let i = 0, l = contour.length; i < l; i++) {
    curPoint = contour[i];
    prevPoint = i === 0 ? contour[l - 1] : contour[i - 1];
    nextPoint = i === l - 1 ? contour[0] : contour[i + 1];

    // 起始坐标
    if (i === 0) {
      if (curPoint.onCurve) {
        cursorPoint = curPoint;
      } else if (prevPoint.onCurve) {
        cursorPoint = prevPoint;
      } else {
        tmpPoint.x = (prevPoint.x + curPoint.x) * 0.5;
        tmpPoint.y = (prevPoint.y + curPoint.y) * 0.5;
        cursorPoint = tmpPoint;
      }
    }

    // 直线
    if (curPoint.onCurve && nextPoint.onCurve) {
      if (false === callBack("L", curPoint, nextPoint, 0, i)) {
        break;
      }
      cursorPoint = nextPoint;
    } else if (!curPoint.onCurve) {
      if (nextPoint.onCurve) {
        if (false === callBack("Q", cursorPoint, curPoint, nextPoint, i)) {
          break;
        }
        cursorPoint = nextPoint;
      } else {
        tmpPoint.x = (curPoint.x + nextPoint.x) * 0.5;
        tmpPoint.y = (curPoint.y + nextPoint.y) * 0.5;
        if (false === callBack("Q", cursorPoint, curPoint, tmpPoint, i)) {
          break;
        }
        cursorPoint = tmpPoint;
      }
    }
  }
}

export default pathIterator;
