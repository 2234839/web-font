/**
 * ttf 相关错误号定义（error.js 的类型声明）
 */
declare const error: {
  /**
   * 抛出一个异常（number 为错误号或含 number/data 的对象）
   */
  raise(e: number | { number?: number; data?: unknown }, ...fargs: unknown[]): void;
};

export default error;
