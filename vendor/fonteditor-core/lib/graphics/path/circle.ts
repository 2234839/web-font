/**
 * @file 圆路径集合，逆时针
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

const circle: PathPoint[] = [{
  x: 582,
  y: 0
}, {
  x: 758,
  y: 75
}, {
  x: 890,
  y: 208
}, {
  x: 965,
  y: 384
}, {
  x: 965,
  y: 583
}, {
  x: 890,
  y: 760
}, {
  x: 758,
  y: 891
}, {
  x: 582,
  y: 966
}, {
  x: 383,
  y: 966
}, {
  x: 207,
  y: 891
}, {
  x: 75,
  y: 760
}, {
  x: 0,
  y: 583
}, {
  x: 0,
  y: 384
}, {
  x: 75,
  y: 208
}, {
  x: 207,
  y: 75
}, {
  x: 383,
  y: 0
}];

export default circle;
