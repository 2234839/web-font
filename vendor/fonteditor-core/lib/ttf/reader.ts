/**
 * @file 数据读取器
 * @author mengke01(kekee000@gmail.com)
 *
 * thanks to：
 * ynakajima/ttf.js
 * https://github.com/ynakajima/ttf.js
 */

import error from "./error";

// 检查数组支持情况
if (typeof ArrayBuffer === "undefined" || typeof DataView === "undefined") {
  throw new Error("not support ArrayBuffer and DataView");
}

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

/** 基础数值类型的读取方法名集合 */
type BasicReadType = keyof typeof dataType;

/**
 * 数据读取器
 */
export default class Reader {
  /** 当前读取偏移 */
  offset: number;
  /** 数据长度 */
  length: number;
  /** 是否小尾 */
  littleEndian: boolean;
  /** 底层数据视图 */
  view: DataView;

  /**
   * 读取器
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
   * 读取指定的数据类型
   *
   * @param type 数据类型
   * @param offset 位移
   * @param littleEndian 是否小尾
   * @return 返回值
   */
  read(type: string, offset?: number, littleEndian?: boolean): number {
    if (undefined === offset) {
      offset = this.offset;
    }
    if (undefined === littleEndian) {
      littleEndian = this.littleEndian;
    }
    if (undefined === dataType[type]) {
      const dynamicRead = (this as unknown as Record<string, (o: number, le: boolean) => number>)["read" + type];
      return dynamicRead.call(this, offset, littleEndian);
    }
    const size = dataType[type];
    this.offset = offset + size;
    /* switch 直接分发，避免动态属性查找 */
    switch (type as BasicReadType) {
      case "Int8":
        return this.view!.getInt8(offset);
      case "Uint8":
        return this.view!.getUint8(offset);
      case "Int16":
        return this.view!.getInt16(offset, littleEndian);
      case "Uint16":
        return this.view!.getUint16(offset, littleEndian);
      case "Int32":
        return this.view!.getInt32(offset, littleEndian);
      case "Uint32":
        return this.view!.getUint32(offset, littleEndian);
      case "Float32":
        return this.view!.getFloat32(offset, littleEndian);
      case "Float64":
        return this.view!.getFloat64(offset, littleEndian);
    }
    return 0;
  }

  /**
   * 获取指定的字节数组
   *
   * @param offset 偏移
   * @param length 字节长度
   * @return 字节数组
   */
  readBytes(offset: number, length: number | null = null): Uint8Array {
    if (length == null) {
      length = offset;
      offset = this.offset;
    }
    if (length < 0 || offset + length > this.length) {
      error.raise(10001, this.length, offset + length);
    }
    /* Uint8Array.slice 批量读取，替代逐字节 push */
    const bytes = new Uint8Array(this.view!.buffer, this.view!.byteOffset + offset, length).slice();
    this.offset = offset + length;
    return bytes;
  }

  /**
   * 读取一个string
   *
   * @param offset 偏移
   * @param length 长度
   * @return 字符串
   */
  readString(offset: number, length: number | null = null): string {
    if (length == null) {
      length = offset;
      offset = this.offset;
    }
    if (length < 0 || offset + length > this.length) {
      error.raise(10001, this.length, offset + length);
    }
    /* 使用 Uint8Array + String.fromCharCode.apply 批量转换 */
    const viewOffset = this.view!.byteOffset + offset;
    const bytes = new Uint8Array(this.view!.buffer, viewOffset, length);
    this.offset = offset + length;
    if (length <= 1024) {
      return String.fromCharCode.apply(null, bytes as unknown as number[]);
    }
    /* 长字符串分段构建，避免 call stack 溢出 */
    const parts: string[] = [];
    const chunkSize = 1024;
    for (let ci = 0; ci < length; ci += chunkSize) {
      const end = ci + chunkSize < length ? ci + chunkSize : length;
      parts.push(String.fromCharCode.apply(null, bytes.subarray(ci, end) as unknown as number[]));
    }
    return parts.join("");
  }

  /**
   * 读取一个字符
   *
   * @param offset 偏移
   * @return 字符串
   */
  readChar(offset: number): string {
    return this.readString(offset, 1);
  }

  /**
   * 读取一个uint24整形
   *
   * @param offset 偏移
   * @return 数值
   */
  readUint24(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    /* 直接 view 读取 3 字节，消除 readBytes 的临时数组分配 */
    const vOff = this.view!.byteOffset + offset;
    const buf = this.view!.buffer as unknown as Uint8Array;
    return (buf[vOff] << 16) + (buf[vOff + 1] << 8) + buf[vOff + 2];
  }

  /**
   * 读取fixed类型
   *
   * @param offset 偏移
   * @return float
   */
  readFixed(offset?: number): number {
    if (undefined === offset) {
      offset = this.offset;
    }
    const val = this.readInt32(offset) / 65536.0;
    return Math.ceil(val * 100000) / 100000;
  }

  /**
   * 读取长日期
   *
   * @param offset 偏移
   * @return Date对象
   */
  readLongDateTime(offset?: number): Date {
    if (undefined === offset) {
      offset = this.offset;
    }

    // new Date(1970, 1, 1).getTime() - new Date(1904, 1, 1).getTime();
    const delta = -2077545600000;
    const time = this.readUint32(offset + 4);
    const date = new Date();
    date.setTime(time * 1000 + delta);
    return date;
  }

  /**
   * 跳转到指定偏移
   *
   * @param offset 偏移
   * @return this
   */
  seek(offset?: number): Reader {
    if (undefined === offset) {
      this.offset = 0;
    }
    if (offset! < 0 || offset! > this.length) {
      error.raise(10001, this.length, offset);
    }
    this.offset = offset!;
    return this;
  }

  /**
   * 注销
   */
  dispose(): void {
    /* delete → null 赋值，避免 V8 隐藏类转换 */
    this.view = null as unknown as DataView;
  }

  /* 以下基础类型读取方法直接定义为原型方法，避免 curry 闭包和动态属性查找开销 */

  /**
   * 读取 Int8
   *
   * @param offset 偏移
   * @return 数值
   */
  readInt8(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 1;
    return this.view!.getInt8(offset);
  }

  /**
   * 读取 Uint8
   *
   * @param offset 偏移
   * @return 数值
   */
  readUint8(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 1;
    return this.view!.getUint8(offset);
  }

  /**
   * 读取 Int16
   *
   * @param offset 偏移
   * @return 数值
   */
  readInt16(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 2;
    return this.view!.getInt16(offset, this.littleEndian);
  }

  /**
   * 读取 Uint16
   *
   * @param offset 偏移
   * @return 数值
   */
  readUint16(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 2;
    return this.view!.getUint16(offset, this.littleEndian);
  }

  /**
   * 读取 Int32
   *
   * @param offset 偏移
   * @return 数值
   */
  readInt32(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 4;
    return this.view!.getInt32(offset, this.littleEndian);
  }

  /**
   * 读取 Uint32
   *
   * @param offset 偏移
   * @return 数值
   */
  readUint32(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 4;
    return this.view!.getUint32(offset, this.littleEndian);
  }

  /**
   * 读取 Float32
   *
   * @param offset 偏移
   * @return 数值
   */
  readFloat32(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 4;
    return this.view!.getFloat32(offset, this.littleEndian);
  }

  /**
   * 读取 Float64
   *
   * @param offset 偏移
   * @return 数值
   */
  readFloat64(offset?: number): number {
    if (offset === undefined) offset = this.offset;
    this.offset = offset + 8;
    return this.view!.getFloat64(offset, this.littleEndian);
  }
}
