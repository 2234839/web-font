/**
 * @file 数据写入器
 * @author mengke01(kekee000@gmail.com)
 */

import error from "./error";

// 检查数组支持情况
if (typeof ArrayBuffer === "undefined" || typeof DataView === "undefined") {
  throw new Error("not support ArrayBuffer and DataView");
}

/** 全局 Uint8Array 视图缓存，避免 writeBytes/writeEmpty 每次创建视图 */
let globalView: Uint8Array | null = null;
let globalViewBuf: ArrayBufferLike | null = null;
/** 预编译正则，避免 writeLongDateTime 每次创建 RegExp */
const isAllDigits = /^\d+$/;

/** 数据类型与字节数映射 */
const dataType: Record<string, number> = {
  Int8: 1,
  Int16: 2,
  Int32: 4,
  Uint8: 1,
  Uint16: 2,
  Uint32: 4,
  Float32: 4,
  Float64: 8,
};

/** 基础数值类型的写入方法名集合 */
type BasicWriteType = keyof typeof dataType;

/**
 * 数据写入器
 */
export default class Writer {
  /** 当前写入偏移 */
  offset: number;
  /** 数据长度 */
  length: number;
  /** 是否小尾 */
  littleEndian: boolean;
  /** 底层数据视图 */
  view: DataView;
  /** seek 之前的位置，供 head() 跳回 */
  private _offset?: number;

  /**
   * 写入器
   *
   * @param buffer 缓冲数组
   * @param offset 起始偏移
   * @param length 数组长度
   * @param littleEndian 是否小尾
   */
  constructor(buffer: ArrayBuffer | Uint8Array, offset?: number, length?: number, littleEndian?: boolean) {
    const bufferLength = buffer.byteLength || (buffer as Uint8Array).length;
    this.offset = offset || 0;
    this.length = length || bufferLength - this.offset;
    this.littleEndian = littleEndian || false;
    this.view = new DataView(buffer as ArrayBuffer, this.offset, this.length);
  }

  /**
   * 写入指定的数据类型
   *
   * @param type 数据类型
   * @param value value值
   * @param offset 位移
   * @param littleEndian 是否小尾
   * @return this
   */
  write(type: string, value: number, offset?: number, littleEndian?: boolean): Writer {
    if (undefined === offset) {
      offset = this.offset;
    }
    if (undefined === littleEndian) {
      littleEndian = this.littleEndian;
    }
    if (undefined === dataType[type]) {
      const dynamicWrite = (this as unknown as Record<string, (v: number, o: number, le: boolean) => Writer>)[
        "write" + type
      ];
      return dynamicWrite.call(this, value, offset, littleEndian);
    }
    const size = dataType[type];
    this.offset = offset + size;
    /* switch 直接分发，避免动态属性查找 */
    switch (type as BasicWriteType) {
      case "Int8":
        this.view!.setInt8(offset, value);
        break;
      case "Uint8":
        this.view!.setUint8(offset, value);
        break;
      case "Int16":
        this.view!.setInt16(offset, value, littleEndian);
        break;
      case "Uint16":
        this.view!.setUint16(offset, value, littleEndian);
        break;
      case "Int32":
        this.view!.setInt32(offset, value, littleEndian);
        break;
      case "Uint32":
        this.view!.setUint32(offset, value, littleEndian);
        break;
      case "Float32":
        this.view!.setFloat32(offset, value, littleEndian);
        break;
      case "Float64":
        this.view!.setFloat64(offset, value, littleEndian);
        break;
    }
    return this;
  }

  /**
   * 写入指定的字节数组
   *
   * @param value 写入值
   * @param length 数组长度
   * @param offset 起始偏移
   * @return this
   */
  writeBytes(
    value: ArrayBuffer | Uint8Array | number[],
    length?: number,
    offset?: number
  ): Writer {
    length = length || (value instanceof Uint8Array ? value.length : (value as ArrayBuffer).byteLength || (value as number[]).length);
    if (!length) {
      return this;
    }
    if (undefined === offset) {
      offset = this.offset;
    }
    if (length < 0 || offset + length > this.length) {
      error.raise(10002, this.length, offset + length);
    }
    /* 复用全局 Uint8Array 视图，避免每次 writeBytes 创建新视图 */
    if (globalViewBuf !== this.view!.buffer) {
      globalViewBuf = this.view!.buffer;
      globalView = new Uint8Array(globalViewBuf);
    }
    const vOff = this.view!.byteOffset + offset;
    if (value instanceof Uint8Array) {
      globalView!.set(value, vOff);
    } else {
      globalView!.set(
        value instanceof ArrayBuffer ? new Uint8Array(value, 0, length) : new Uint8Array(value as number[]),
        vOff
      );
    }
    this.offset = offset + length;
    return this;
  }

  /**
   * 写空数据
   *
   * @param length 长度
   * @param offset 起始偏移
   * @return this
   */
  writeEmpty(length: number, offset?: number): Writer {
    if (length < 0) {
      error.raise(10002, this.length, length);
    }
    if (undefined === offset) {
      offset = this.offset;
    }
    /* 复用全局视图 fill(0) */
    if (globalViewBuf !== this.view!.buffer) {
      globalViewBuf = this.view!.buffer;
      globalView = new Uint8Array(globalViewBuf);
    }
    globalView!.fill(0, this.view!.byteOffset + offset, this.view!.byteOffset + offset + length);
    this.offset = offset + length;
    return this;
  }

  /**
   * 写入一个string
   *
   * @param str 字符串
   * @param length 长度
   * @param offset 偏移
   * @return this
   */
  writeString(str = "", length?: number, offset?: number): Writer {
    if (undefined === offset) {
      offset = this.offset;
    }
    // eslint-disable-next-line no-control-regex
    length = length || str.replace(/[^\x00-\xff]/g, "11").length;
    if (length < 0 || offset + length > this.length) {
      error.raise(10002, this.length, offset + length);
    }
    /* 直接 view 写入，替代逐字节 writeUint8/writeUint16 */
    let pos = offset;
    for (let i = 0, l = str.length, charCode; i < l; ++i) {
      charCode = str.charCodeAt(i);
      if (charCode > 127) {
        this.view!.setUint16(pos, charCode, this.littleEndian);
        pos += 2;
      } else {
        this.view!.setUint8(pos, charCode);
        pos += 1;
      }
    }
    this.offset = offset + length;
    return this;
  }

  /**
   * 写入一个字符
   *
   * @param value 字符
   * @param offset 偏移
   * @return this
   */
  writeChar(value: string, offset?: number): Writer {
    return this.writeString(value, offset);
  }

  /**
   * 写入fixed类型
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeFixed(value: number, offset?: number): Writer {
    if (undefined === offset) {
      offset = this.offset;
    }
    this.writeInt32((value * 65536 + 0.5) | 0, offset);
    return this;
  }

  /**
   * 写入长日期
   *
   * @param value 日期对象或时间戳
   * @param offset 偏移
   * @return this
   */
  writeLongDateTime(value: Date | number | string, offset?: number): Writer {
    if (undefined === offset) {
      offset = this.offset;
    }

    // new Date(1970, 1, 1).getTime() - new Date(1904, 1, 1).getTime();
    const delta = -2077545600000;
    let time: number;
    if (typeof value === "undefined") {
      time = delta;
    } else if (typeof (value as Date).getTime === "function") {
      time = (value as Date).getTime();
    } else if (typeof value === "number" || isAllDigits.test(String(value))) {
      time = +value;
    } else {
      time = Date.parse(String(value));
    }
    const seconds = Math.round((time - delta) / 1000);
    this.writeUint32(0, offset);
    this.writeUint32(seconds, offset + 4);
    return this;
  }

  /**
   * 跳转到指定偏移
   *
   * @param offset 偏移
   * @return this
   */
  seek(offset?: number): Writer {
    if (undefined === offset) {
      this.offset = 0;
    }
    if (offset! < 0 || offset! > this.length) {
      error.raise(10002, this.length, offset);
    }
    this._offset = this.offset;
    this.offset = offset!;
    return this;
  }

  /**
   * 跳转到写入头部位置
   *
   * @return this
   */
  head(): Writer {
    this.offset = this._offset || 0;
    return this;
  }

  /**
   * 获取缓存的byte数组
   *
   * @return ArrayBuffer
   */
  getBuffer(): ArrayBuffer {
    return this.view!.buffer as ArrayBuffer;
  }

  /**
   * 注销
   */
  dispose(): void {
    /* delete → null 赋值，避免 V8 隐藏类转换 */
    this.view = null as unknown as DataView;
  }

  /* 以下基础类型写入方法直接定义为原型方法，避免 curry 闭包开销 */

  /**
   * 写入 Int8
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeInt8(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 1;
    this.view!.setInt8(offset, value);
    return this;
  }

  /**
   * 写入 Uint8
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeUint8(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 1;
    this.view!.setUint8(offset, value);
    return this;
  }

  /**
   * 写入 Int16
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeInt16(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 2;
    this.view!.setInt16(offset, value, this.littleEndian);
    return this;
  }

  /**
   * 写入 Uint16
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeUint16(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 2;
    this.view!.setUint16(offset, value, this.littleEndian);
    return this;
  }

  /**
   * 写入 Int32
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeInt32(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 4;
    this.view!.setInt32(offset, value, this.littleEndian);
    return this;
  }

  /**
   * 写入 Uint32
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeUint32(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 4;
    this.view!.setUint32(offset, value, this.littleEndian);
    return this;
  }

  /**
   * 写入 Float32
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeFloat32(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 4;
    this.view!.setFloat32(offset, value, this.littleEndian);
    return this;
  }

  /**
   * 写入 Float64
   *
   * @param value 写入值
   * @param offset 偏移
   * @return this
   */
  writeFloat64(value: number, offset?: number): Writer {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 8;
    this.view!.setFloat64(offset, value, this.littleEndian);
    return this;
  }
}
