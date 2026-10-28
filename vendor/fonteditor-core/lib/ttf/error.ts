/**
 * @file ttf 相关错误号定义
 * @author mengke01(kekee000@gmail.com)
 */
import string from '../common/string';
import i18n from './i18n';

const error = {
  /**
   * 抛出一个异常（e 为错误号，或含 number/data 字段的异常对象；
   * fargs 为格式化参数，首个参数为对象时按 ${key} 取值，否则按 ${0} ${1} 序号取值）
   *
   * 例如：
   * e = 1001
   * e = {
   *     number: 1001,
   *     data: 错误数据
   * }
   */
  raise(
    e: number | { number?: number; data?: unknown },
    ...fargs: unknown[]
  ): never {
    let number: number;
    let data: unknown;
    if (typeof e === 'object') {
      number = e.number || 0;
      data = e.data;
    } else {
      number = e;
    }
    let message: any = i18n.lang[number];
    if (fargs.length > 0) {
      const args: any = typeof fargs[0] === 'object' ? fargs[0] : fargs;
      message = string.format(message, args);
    }
    const event: any = new Error(message);
    event.number = number;
    if (data) {
      event.data = data;
    }
    throw event;
  }
};

export default error;
