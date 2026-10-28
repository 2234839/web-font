/**
 * @file 将ttf路径转换为svg路径`d`
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 轮廓点
 */
interface ContourPoint {
  /** 水平坐标 */
  x: number;
  /** 垂直坐标 */
  y: number;
  /** 是否曲线端点 */
  onCurve?: boolean;
}

/**
 * 将路径转换为svg路径
 *
 * @param contour 轮廓序列
 * @param precision 精确度
 * @return 路径
 */
export default function contour2svg(contour: ContourPoint[], precision: number = 2): string {
  if (!contour.length) {
    return "";
  }
  /** 优化293: 用乘法+截断替代 toFixed()，消除每个坐标点的 toFixed 调用开销 */
  const factor = precision <= 0 ? 1 : Math.pow(10, precision);
  const invFactor = 1 / factor;
  /** 优化293: ceil 内联，避免闭包创建 */
  const ceil = (number: number) => Math.round(number * factor) * invFactor;

  const pathArr: string[] = [];
  let curPoint: ContourPoint;
  let prevPoint: ContourPoint;
  let nextPoint: ContourPoint;
  let x = 0; // x相对坐标
  let y = 0; // y相对坐标
  for (let i = 0, l = contour.length; i < l; i++) {
    curPoint = contour[i];
    prevPoint = i === 0 ? contour[l - 1] : contour[i - 1];
    nextPoint = i === l - 1 ? contour[0] : contour[i + 1];

    // 起始坐标
    if (i === 0) {
      if (curPoint.onCurve) {
        x = curPoint.x;
        y = curPoint.y;
        pathArr.push("M" + ceil(x) + " " + ceil(y));
      } else if (prevPoint.onCurve) {
        x = prevPoint.x;
        y = prevPoint.y;
        pathArr.push("M" + ceil(x) + " " + ceil(y));
      } else {
        x = (prevPoint.x + curPoint.x) / 2;
        y = (prevPoint.y + curPoint.y) / 2;
        pathArr.push("M" + ceil(x) + " " + ceil(y));
      }
    }

    // 直线
    if (curPoint.onCurve && nextPoint.onCurve) {
      pathArr.push("l" + ceil(nextPoint.x - x) + " " + ceil(nextPoint.y - y));
      x = nextPoint.x;
      y = nextPoint.y;
    } else if (!curPoint.onCurve) {
      if (nextPoint.onCurve) {
        pathArr.push(
          "q" + ceil(curPoint.x - x) + " " + ceil(curPoint.y - y) + " " + ceil(nextPoint.x - x) + " " + ceil(nextPoint.y - y)
        );
        x = nextPoint.x;
        y = nextPoint.y;
      } else {
        const x1 = (curPoint.x + nextPoint.x) / 2;
        const y1 = (curPoint.y + nextPoint.y) / 2;
        pathArr.push("q" + ceil(curPoint.x - x) + " " + ceil(curPoint.y - y) + " " + ceil(x1 - x) + " " + ceil(y1 - y));
        x = x1;
        y = y1;
      }
    }
  }
  pathArr.push("Z");
  return pathArr.join(" ");
}
