/**
 * @file 字符串相关的函数
 * @author mengke01(kekee000@gmail.com)
 */

/** 字符串工具集合 */
const string = {
  /**
   * HTML解码字符串
   */
  decodeHTML(source: string): string {
    const str = String(source)
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

    // 处理转义的中文和实体字符
    return str.replace(/&#([\d]+);/g, function (_, $1) {
      return String.fromCodePoint(parseInt($1, 10));
    });
  },

  /**
   * HTML编码字符串
   */
  encodeHTML(source: string): string {
    return String(source)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * 获取string字节长度（非 ASCII 字符按 2 计）
   */
  getLength(source: string): number {
    // eslint-disable-next-line no-control-regex
    return String(source).replace(/[^\x00-\xff]/g, '11').length;
  },

  /**
   * 字符串格式化，支持如 ${xxx.xxx} 的语法
   */
  format(source: string, data: any): string {
    return source.replace(/\$\{([\w.]+)\}/g, function (_, $1) {
      const ref = $1.split('.');
      let refObject: any = data;
      let level: string | undefined;
      while (refObject != null && (level = ref.shift())) {
        refObject = refObject[level];
      }
      return refObject != null ? refObject : '';
    });
  },

  /**
   * 使用指定字符填充字符串,默认`0`；超长时从左侧截断到指定长度
   */
  pad(str: string, size: number, ch?: string): string {
    str = String(str);
    if (str.length > size) {
      return str.slice(str.length - size);
    }
    return new Array(size - str.length + 1).join(ch || '0') + str;
  },

  /**
   * 获取字符串哈希编码
   */
  hashcode(str: string): number {
    if (!str) {
      return 0;
    }
    let hash = 0;
    for (let i = 0, l = str.length; i < l; i++) {
      hash = 0x7ffffffff & hash * 31 + str.charCodeAt(i);
    }
    return hash;
  }
};

export default string;
