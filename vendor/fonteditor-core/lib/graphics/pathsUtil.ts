/**
 * @file 路径组变化函数
 * @author mengke01(kekee000@gmail.com)
 */
import { computePath } from "./computeBoundingBox";
import pathAdjust from "./pathAdjust";
import pathRotate from "./pathRotate";

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
 * 翻转路径
 *
 * @param paths 路径数组
 * @param xScale x翻转
 * @param yScale y翻转
 * @return 变换后的路径
 */
function mirrorPaths(
  /** 路径数组 */
  paths: PathPoint[][],
  /** x翻转 */
  xScale: number,
  /** y翻转 */
  yScale: number
): PathPoint[][] {
  const bound = computePath(...paths);
  if (!bound) {
    return paths;
  }
  const { x, y, width, height } = bound;

  if (xScale === -1) {
    paths.forEach((p) => {
      pathAdjust(p, -1, 1, -x, 0);
      pathAdjust(p, 1, 1, x + width, 0);
      p.reverse();
    });
  }

  if (yScale === -1) {
    paths.forEach((p) => {
      pathAdjust(p, 1, -1, 0, -y);
      pathAdjust(p, 1, 1, 0, y + height);
      p.reverse();
    });
  }

  return paths;
}

/**
 * 路径组变换函数集合
 */
const pathsUtil = {
  /**
   * 旋转路径
   *
   * @param paths 路径数组
   * @param angle 弧度
   * @return 变换后的路径
   */
  rotate(
    /** 路径数组 */
    paths: PathPoint[][],
    /** 弧度 */
    angle: number
  ): PathPoint[][] {
    if (!angle) {
      return paths;
    }
    const bound = computePath(...paths);
    if (!bound) {
      return paths;
    }
    const cx = bound.x + bound.width / 2;
    const cy = bound.y + bound.height / 2;
    paths.forEach((p) => {
      pathRotate(p, angle, cx, cy);
    });
    return paths;
  },

  /**
   * 路径组变换
   *
   * @param paths 路径数组
   * @param x x 方向缩放
   * @param y y 方向缩放
   * @return 变换后的路径
   */
  move(
    /** 路径数组 */
    paths: PathPoint[][],
    /** x 方向缩放 */
    x: number,
    /** y 方向缩放 */
    y: number
  ): PathPoint[][] {
    const bound = computePath(...paths);
    if (!bound) {
      return paths;
    }
    paths.forEach((path) => {
      pathAdjust(path, 1, 1, x - bound.x, y - bound.y);
    });
    return paths;
  },

  /**
   * 水平镜像路径
   *
   * @param paths 路径数组
   * @return 变换后的路径
   */
  mirror(
    /** 路径数组 */
    paths: PathPoint[][]
  ): PathPoint[][] {
    return mirrorPaths(paths, -1, 1);
  },

  /**
   * 垂直翻转路径
   *
   * @param paths 路径数组
   * @return 变换后的路径
   */
  flip(
    /** 路径数组 */
    paths: PathPoint[][]
  ): PathPoint[][] {
    return mirrorPaths(paths, 1, -1);
  }
};

export default pathsUtil;
