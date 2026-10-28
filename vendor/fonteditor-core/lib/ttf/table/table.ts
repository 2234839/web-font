/**
 * @file ttf表基类
 * @author mengke01(kekee000@gmail.com)
 */
import struct from "./struct";
import error from "../error";

/** 表读取器最小结构（ttf/reader 的 Reader） */
export interface TableReader {
  /** 当前读取偏移 */
  offset: number;
  /** 底层数据视图 */
  view: DataView;
  /** 移动到指定偏移 */
  seek(offset: number): void;
}

/** 表写入器最小结构（ttf/writer 的 Writer） */
export interface TableWriter {
  /** 当前写入偏移 */
  offset: number;
  /** 底层数据视图 */
  view: DataView;
}

/** 已解析 ttf 对象（表类按表名动态访问字段） */
export type TtfObject = Record<string, any>;

/** 表结构定义项：[字段名, struct 类型常量, 可选长度/附加参数] */
export type TableStructItem = [string, number, number?];

/** 完整读取器（基础 read 分发与各表解析所需） */
export interface TableFullReader extends TableReader {
  /** 数据长度 */
  length: number;
  /** 按类型名读取 */
  read(typeName: string, offset?: number, littleEndian?: boolean): number;
  /** 读取 uint8 */
  readUint8(offset?: number): number;
  /** 读取 uint16 */
  readUint16(offset?: number): number;
  /** 读取 uint32 */
  readUint32(offset?: number): number;
  /** 读取 16.16 定点数 */
  readFixed(offset?: number): number;
  /** 读取 LongDateTime */
  readLongDateTime(offset?: number): Date;
  /** 读取字节数组 */
  readBytes(offset: number, length?: number | null): Uint8Array;
  /** 读取单字符 */
  readChar(offset?: number): string;
  /** 读取字符串 */
  readString(offset: number, length?: number | null): string;
}

/** 完整写入器（基础 write 分发与各表写入所需） */
export interface TableFullWriter extends TableWriter {
  /** 按类型名写入 */
  write(typeName: string, value: number, offset?: number, littleEndian?: boolean): unknown;
  /** 写入 16.16 定点数 */
  writeFixed(value: number, offset?: number): unknown;
  /** 写入 LongDateTime */
  writeLongDateTime(value: Date | number, offset?: number): unknown;
  /** 写入单字符 */
  writeChar(value: string, offset?: number): unknown;
  /** 写入字符串 */
  writeString(value: string, length: number, offset?: number): unknown;
  /** 写入字节数组 */
  writeBytes(value: ArrayLike<number>, length: number, offset?: number): unknown;
  /** 批量填充 0 */
  writeEmpty(length: number, offset?: number): unknown;
  /** 获取已写入的 buffer */
  getBuffer(): ArrayBuffer;
}

/** 表结构基类实例的原型形状（read 通过 this 写入解析出的字段） */
export interface TableProto {
  /** 表名 */
  name: string;
  /** 表结构定义 */
  struct: TableStructItem[];
  /** 表在字体文件中的偏移 */
  offset: number;
  /** 获取对象的值 */
  valueOf(): Record<string, unknown>;
  [field: string]: unknown;
}

/** 表类实例 */
export interface TableInstance extends TableProto {
  /** 读取表结构 */
  read(reader: TableReader, ttf?: TtfObject): unknown;
  /** 写表结构 */
  write(writer: TableWriter, ttf: TtfObject): unknown;
  /** 获取ttf表的size大小 */
  size(ttf: TtfObject): number;
}

/** 表构造函数 */
export interface TableCtor {
  new (offset?: number): TableProto & TableInstance;
  prototype: {
    read: (this: TableProto, reader: TableFullReader) => Record<string, unknown>;
    write: (this: TableProto, writer: TableFullWriter, ttf: TtfObject) => TableFullWriter;
    size: (this: TableProto, ttf: TtfObject) => number;
    valueOf: (this: TableProto) => Record<string, unknown>;
  };
}

/**
 * 读取表结构
 *
 * @param reader reader对象
 */
function read(this: TableProto, reader: TableFullReader): Record<string, unknown> {
  var offset = this.offset;
  if (undefined !== offset) {
    reader.seek(offset);
  }
  var me = this;
  var structDef = this.struct;
  for (var si = 0, sl = structDef.length; si < sl; si++) {
    var item = structDef[si];
    var name = item[0];
    var type = item[1];
    var typeName: string | null;
    switch (type) {
      case struct.Int8:
      case struct.Uint8:
      case struct.Int16:
      case struct.Uint16:
      case struct.Int32:
      case struct.Uint32:
        typeName = struct.names[type];
        me[name] = reader.read(typeName);
        break;
      case struct.Fixed:
        me[name] = reader.readFixed();
        break;
      case struct.LongDateTime:
        me[name] = reader.readLongDateTime();
        break;
      case struct.Bytes:
        me[name] = reader.readBytes(reader.offset, item[2] || 0);
        break;
      case struct.Char:
        me[name] = reader.readChar();
        break;
      case struct.String:
        me[name] = reader.readString(reader.offset, item[2] || 0);
        break;
      default:
        error.raise(10003, name, type);
    }
  }
  return this.valueOf();
}

/**
 * 写表结构
 *
 * @param writer writer对象
 * @param ttf 已解析的ttf对象
 */
function write(this: TableProto, writer: TableFullWriter, ttf: TtfObject): TableFullWriter {
  var table = ttf[this.name];
  if (!table) {
    error.raise(10203, this.name);
  }
  var structDef = this.struct;
  /* 优化152: 直接分发到 writer 方法，消除 string 类型名中间层双重 switch */
  for (var si = 0, sl = structDef.length; si < sl; si++) {
    var item = structDef[si];
    var name = item[0];
    switch (item[1]) {
      case 1: writer.write('Int8', table[name]); break;
      case 2: writer.write('Uint8', table[name]); break;
      case 3: writer.write('Int16', table[name]); break;
      case 4: writer.write('Uint16', table[name]); break;
      case 5: writer.write('Int32', table[name]); break;
      case 6: writer.write('Uint32', table[name]); break;
      case 7: writer.writeFixed(table[name]); break;
      case 12: writer.writeLongDateTime(table[name]); break;
      case 13: writer.writeChar(table[name]); break;
      case 14: writer.writeString(table[name], item[2] || 0); break;
      case 15: writer.writeBytes(table[name], item[2] || 0); break;
      default: error.raise(10003, name, item[1]);
    }
  }
  return writer;
}

/**
 * 优化152: 类型大小查找表，替代 switch 循环
 */
var TYPE_SIZES = [0, 1, 1, 2, 2, 4, 4, 4, 0, 0, 0, 2, 8, 1, 0, 0, 0, 0, 0, 0, 3];

/**
 * 获取ttf表的size大小
 */
function size(this: TableProto, _ttf: TtfObject): number {
  var sz = 0;
  var structDef = this.struct;
  for (var si = 0, sl = structDef.length; si < sl; si++) {
    var item = structDef[si];
    var t = item[1];
    /* Bytes/String 使用 item[2] 指定长度，其余查表 */
    sz += (t === 15 || t === 14) ? (item[2] || 0) : TYPE_SIZES[t];
  }
  return sz;
}

/**
 * 获取对象的值
 */
function valueOf(this: TableProto): Record<string, unknown> {
  var val: Record<string, unknown> = {};
  var me = this;
  var structDef = this.struct;
  for (var si = 0, sl = structDef.length; si < sl; si++) {
    val[structDef[si][0]] = me[structDef[si][0]];
  }
  return val;
}

const table = {
  read: read,
  write: write,
  size: size,
  valueOf: valueOf,
  /**
   * 创建一个表结构
   *
   * @param name 表名
   * @param structDef 表结构
   * @param proto 原型
   * @return 表构造函数
   */
  create: function create(name: string, structDef: TableStructItem[], proto?: object): TableCtor {
    class Table implements TableProto, TableInstance {
      /** 表名 */
      name: string;
      /** 表结构定义 */
      struct: TableStructItem[];
      /** 表在字体文件中的偏移 */
      offset: number;
      /** 解析出的表字段（read 通过 this 写入） */
      [field: string]: unknown;

      constructor(offset?: number) {
        this.name = name;
        this.struct = structDef;
        this.offset = offset!;
      }

      /** 读取表结构 */
      read(reader: TableFullReader, _ttf?: TtfObject) {
        return read.call(this, reader);
      }

      /** 写表结构 */
      write(writer: TableFullWriter, ttf: TtfObject) {
        return write.call(this, writer, ttf);
      }

      /** 获取ttf表的size大小 */
      size(ttf: TtfObject) {
        return size.call(this, ttf);
      }

      /** 获取对象的值 */
      valueOf() {
        return valueOf.call(this);
      }
    }
    Object.assign(Table.prototype, proto);
    return Table;
  }
};

export default table;
