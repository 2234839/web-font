/**
 * @file 语言相关函数
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 判断是否为数组
 */
export function isArray(obj: unknown): boolean {
  return obj != null && Object.prototype.toString.call(obj).slice(8, -1) === 'Array';
}

/**
 * 判断是否为普通对象
 */
export function isObject(obj: unknown): boolean {
  return obj != null && Object.prototype.toString.call(obj).slice(8, -1) === 'Object';
}

/**
 * 判断是否为字符串
 */
export function isString(obj: unknown): boolean {
  return obj != null && Object.prototype.toString.call(obj).slice(8, -1) === 'String';
}

/**
 * 判断是否为函数
 */
export function isFunction(obj: unknown): boolean {
  return obj != null && Object.prototype.toString.call(obj).slice(8, -1) === 'Function';
}

/**
 * 判断是否为日期对象
 */
export function isDate(obj: unknown): boolean {
  return obj != null && Object.prototype.toString.call(obj).slice(8, -1) === 'Date';
}

/**
 * 判断是否为空对象（无可枚举自有属性）
 */
export function isEmptyObject(object: object): boolean {
  for (const name in object) {
    // eslint-disable-next-line no-prototype-builtins
    if (object.hasOwnProperty(name)) {
      return false;
    }
  }
  return true;
}

/**
 * 为函数提前绑定前置参数（柯里化）
 *
 * @see http://en.wikipedia.org/wiki/Currying
 */
export function curry(fn: (...args: any[]) => any, ...cargs: any[]): (...args: any[]) => any {
  return function (this: unknown, ...rargs: any[]) {
    const args = cargs.concat(rargs);
    // eslint-disable-next-line no-invalid-this
    return fn.apply(this, args);
  };
}

/**
 * 方法静态化, 反绑定、延迟绑定
 */
export function generic(method: (...args: any[]) => any): (...args: any[]) => any {
  return function (...fargs: any[]) {
    // 等价于 Function.call.apply(method, fargs)：以 fargs[0] 为 this、其余为参数反绑定调用
    const [thisArg, ...rest] = fargs;
    return method.apply(thisArg, rest);
  };
}

/**
 * 设置覆盖相关的属性值，嵌套对象递归覆写
 */
export function overwrite(thisObj: any, thatObj: any, fields?: string[]): any {
  if (!thatObj) {
    return thisObj;
  }

  // 这里`fields`未指定则仅overwrite自身可枚举的字段，指定`fields`则不做限制
  fields = fields || Object.keys(thatObj);
  fields.forEach(function (field) {
    // 拷贝对象
    if (
      thisObj[field] &&
      typeof thisObj[field] === 'object' &&
      thatObj[field] &&
      typeof thatObj[field] === 'object'
    ) {
      overwrite(thisObj[field], thatObj[field]);
    } else {
      thisObj[field] = thatObj[field];
    }
  });
  return thisObj;
}

/**
 * 深复制对象，仅复制数据
 */
export function clone(source: any): any {
  if (!source || typeof source !== 'object') {
    return source;
  }
  let cloned = source;
  if (isArray(source)) {
    cloned = source.slice().map(clone);
  } else if (isObject(source) && 'isPrototypeOf' in source) {
    cloned = {};
    for (const key of Object.keys(source)) {
      cloned[key] = clone(source[key]);
    }
  }
  return cloned;
}

// Returns a function, that, when invoked, will only be triggered at most once
// during a given window of time.
// @see underscore.js
export function throttle(func: (...args: any[]) => any, wait: number): (...args: any[]) => any {
  let context: unknown;
  let args: any[];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: any;
  let previous = 0;
  const later = function () {
    previous = new Date().getTime();
    timeout = undefined;
    result = func.apply(context, args);
  };
  return function (this: unknown, ...rest: any[]) {
    const now = new Date().getTime();
    const remaining = wait - (now - previous);
    // eslint-disable-next-line no-invalid-this
    context = this;
    if (remaining <= 0) {
      clearTimeout(timeout);
      timeout = undefined;
      previous = now;
      args = rest;
      result = func.apply(context, args);
    } else if (!timeout) {
      timeout = setTimeout(later, remaining);
    }
    return result;
  };
}

// Returns a function, that, as long as it continues to be invoked, will not
// be triggered. The function will be called after it stops being called for
// N milliseconds. If `immediate` is passed, trigger the function on the
// leading edge, instead of the trailing.
// @see underscore.js
export function debounce(
  func: (...args: any[]) => any,
  wait: number,
  immediate?: boolean
): (...args: any[]) => any {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: any;
  return function (this: unknown, ...args: any[]) {
    // eslint-disable-next-line no-invalid-this
    const context = this;
    const later = function () {
      timeout = undefined;
      if (!immediate) {
        result = func.apply(context, args);
      }
    };
    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) {
      result = func.apply(context, args);
    }
    return result;
  };
}

/**
 * 判断两个对象的字段是否相等，嵌套对象递归比较
 */
export function equals(thisObj: any, thatObj: any, fields?: string[]): boolean {
  if (thisObj === thatObj) {
    return true;
  }
  if (thisObj == null && thatObj == null) {
    return true;
  }
  if ((thisObj == null && thatObj != null) || (thisObj != null && thatObj == null)) {
    return false;
  }

  // 这里`fields`未指定则仅overwrite自身可枚举的字段，指定`fields`则不做限制
  fields = fields || (typeof thisObj === 'object' ? Object.keys(thisObj) : []);
  if (!fields.length) {
    return thisObj === thatObj;
  }
  let equal = true;
  let field: string;
  for (let i = 0, l = fields.length; equal && i < l; i++) {
    field = fields[i];
    if (
      thisObj[field] &&
      typeof thisObj[field] === 'object' &&
      thatObj[field] &&
      typeof thatObj[field] === 'object'
    ) {
      equal = equal && equals(thisObj[field], thatObj[field]);
    } else {
      equal = equal && thisObj[field] === thatObj[field];
    }
  }
  return equal;
}
