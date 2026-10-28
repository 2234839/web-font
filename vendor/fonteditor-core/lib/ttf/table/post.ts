/**
 * @file post 表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6post.html
 */
import table from "./table";
import struct from "./struct";
import string from "../util/string";
import unicodeName from "../enum/unicodeName";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** post 头部表（post 表的前 32 字节结构） */
interface PostheadFields {
  /** 表在字体文件中的偏移 */
  offset: number;
  /** 版本号（16.16 定点数） */
  format: number;
  /** 斜体角度 */
  italicAngle: number;
  /** 下划线位置 */
  underlinePosition: number;
  /** 下划线厚度 */
  underlineThickness: number;
  /** 是否等宽字体 */
  isFixedPitch: number;
  /** 最小内存（format 2） */
  minMemType42: number;
  /** 最大内存（format 2） */
  maxMemType42: number;
  /** 最小内存（format 1） */
  minMemType1: number;
  /** 最大内存（format 1） */
  maxMemType1: number;
  /** glyph nameIndex（format 2） */
  nameIndex?: number[] | null;
  /** glyph names（format 2） */
  names?: string[] | null;
}

/** posthead 构造函数（实例可读取自身字段） */
var Posthead = table.create('posthead', [['format', struct.Fixed], ['italicAngle', struct.Fixed], ['underlinePosition', struct.Int16], ['underlineThickness', struct.Int16], ['isFixedPitch', struct.Uint32], ['minMemType42', struct.Uint32], ['maxMemType42', struct.Uint32], ['minMemType1', struct.Uint32], ['maxMemType1', struct.Uint32]]) as unknown as new (offset?: number) => PostheadFields & {
  /** 读取 post 头部字段 */
  read(reader: TableFullReader, ttf: TtfObject): PostheadFields;
};

/** 优化287: 空名常量，避免每次 push [0] 普通数组导致 writeBytes 慢路径 */
var EMPTY_PASCAL = new Uint8Array([0]);

/**
 * 优化64+252: 从原始字节按需提取单个 pascal string，使用 fromCharCode.apply 替代数组+join
 */
function getPascalStringAt(bytes: ArrayLike<number>, offset: number) {
  var length = bytes[offset];
  if (length === 0) return '';
  var chars = new Array<number>(length);
  for (var i = 0; i < length; i++) {
    chars[i] = bytes[offset + 1 + i];
  }
  return String.fromCharCode.apply(null, chars);
}

/** post 表的 support 预处理数据（size 阶段构建，write 阶段消费） */
interface PostSupport {
  /** glyph nameIndex */
  nameIndex?: number[];
  /** glyph pascal name 字节数组 */
  names?: Uint8Array[];
}

export default table.create('post', [], {
  read: function read(this: { offset: number }, reader: TableFullReader, ttf: TtfObject) {
    var tbl = new Posthead(this.offset).read(reader, ttf);
    var format = tbl.format;

    if (format === 2) {
      var numberOfGlyphs = reader.readUint16();
      /* 优化（post name 跳过）：subset 模式下 glyph name 对 web 字体渲染无用（浏览器靠
       *  cmap→gid→glyf 渲染，不依赖 post glyph name；glyph name 仅用于 PDF 嵌入/编辑器）。
       *  强制降级 format 3（无 nameIndex/names），跳过 nameIndex 解析、pascalString 区
       *  readBytes（思源 278KB）、resolveGlyf 的按需 name 读取（实测占 Font.create 69%）。
       *  resolveGlyf 第 148 行 `2 === format` 不成立整段跳过；write/size 走 format 3（32B）。 */
      if (ttf.readOptions && ttf.readOptions.subset) {
        tbl.format = 3;
        tbl.nameIndex = null;
        tbl.names = null;
      } else {
        /* 优化60: 直接 view 批量读取 glyphNameIndex */
        var view = reader.view;
        var vOffset = view.byteOffset + reader.offset;
        var pascalStringOffset = reader.offset + numberOfGlyphs * 2;
        var pascalStringLength = ttf.tables.post.length - (pascalStringOffset - this.offset);
        var pascalStringBytes = reader.readBytes(pascalStringOffset, pascalStringLength);
        var glyphNameIndex = new Array<number>(numberOfGlyphs);
        for (var i = 0; i < numberOfGlyphs; i++) {
          glyphNameIndex[i] = view.getUint16(vOffset, false);
          vOffset += 2;
        }
        tbl.nameIndex = glyphNameIndex;
        tbl.names = string.getPascalString(pascalStringBytes);
      }
    }
    else if (format === 2.5) {
      tbl.format = 3;
    }
    return tbl;
  },
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    var post = ttf.post || {
      format: 3
    };

    /* 优化77: post header 直接 view 写入 32 字节 */
    var view = writer.view;
    var pos = writer.offset;
    view.setInt32(pos, post.format * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt32(pos, (post.italicAngle || 0) * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt16(pos, post.underlinePosition || 0, false); pos += 2;
    view.setInt16(pos, post.underlineThickness || 0, false); pos += 2;
    view.setUint32(pos, post.isFixedPitch || 0, false); pos += 4;
    view.setUint32(pos, post.minMemType42 || 0, false); pos += 4;
    view.setUint32(pos, post.maxMemType42 || 0, false); pos += 4;
    view.setUint32(pos, post.minMemType1 || 0, false); pos += 4;
    view.setUint32(pos, post.maxMemType1 || 0, false); pos += 4;

    if (post.format === 2) {
      var numberOfGlyphs = ttf.glyf.length;
      view.setUint16(pos, numberOfGlyphs, false); pos += 2;
      /* 优化77: nameIndex 直接 view 批量写入 */
      var postSupport: PostSupport = ttf.support.post;
      var nameIndex = postSupport.nameIndex!;
      for (var i = 0, l = nameIndex.length; i < l; i++) {
        view.setUint16(pos, nameIndex[i], false); pos += 2;
      }
      writer.offset = pos;
      /** 优化287: 创建一次 Uint8Array 视图，直接 set 替代 writer.writeBytes */
      var names = postSupport.names!;
      var uv = new Uint8Array(writer.getBuffer());
      for (var j = 0, jl = names.length; j < jl; j++) {
        var nameBytes = names[j];
        uv.set(nameBytes, pos);
        pos += nameBytes.length;
      }
      writer.offset = pos;
    } else {
      writer.offset = pos;
    }
  },
  size: function size(ttf: TtfObject) {
    var numberOfGlyphs = ttf.glyf.length;
    ttf.post = ttf.post || {};
    ttf.post.format = ttf.post.format || 3;
    ttf.post.maxMemType1 = numberOfGlyphs;

    /* 优化109: format 3/1 不需要 nameIndex/names 计算 */
    if (ttf.post.format === 3 || ttf.post.format === 1) {
      ttf.support.post = {};
      return 32;
    }

    var size = 34 + numberOfGlyphs * 2;
    var glyphNames: Uint8Array[] = [];
    var nameIndexArr = new Array<number>(numberOfGlyphs);
    var nameIndex = 0;

    for (var i = 0; i < numberOfGlyphs; i++) {
      if (i === 0) {
        nameIndexArr[i] = 0;
      } else {
        var glyf = ttf.glyf[i];
        var unicode = glyf.unicode ? glyf.unicode[0] : 0;
        var unicodeNameIndex = unicodeName[unicode];
        if (undefined !== unicodeNameIndex) {
          nameIndexArr[i] = unicodeNameIndex;
        } else {
          var name = glyf.name;
          if (!name || name.charCodeAt(0) < 32) {
            nameIndexArr[i] = 258 + nameIndex++;
            glyphNames.push(EMPTY_PASCAL);
            size++;
          } else {
            nameIndexArr[i] = 258 + nameIndex++;
            var bytes = string.toPascalStringBytes(name);
            glyphNames.push(bytes);
            size += bytes.length;
          }
        }
      }
    }
    var postSupport: PostSupport = {
      nameIndex: nameIndexArr,
      names: glyphNames
    };
    ttf.support.post = postSupport;
    return size;
  }
});

export { getPascalStringAt };
