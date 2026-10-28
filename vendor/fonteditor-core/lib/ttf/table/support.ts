/**
 * @file ttf读取和写入支持的表
 * @author mengke01(kekee000@gmail.com)
 */
import head from "./head";
import maxp from "./maxp";
import loca from "./loca";
import cmap from "./cmap";
import glyf from "./glyf";
import name from "./name";
import hhea from "./hhea";
import hmtx from "./hmtx";
import post from "./post";
import OS2 from "./OS2";
import fpgm from "./fpgm";
import cvt from "./cvt";
import prep from "./prep";
import gasp from "./gasp";
import GPOS from "./GPOS";
import GSUB from "./GSUB";
import kern from "./kern";
import kerx from "./kerx";
import BASE from "./BASE";

/** 表实例公共形状（读取/写入框架按 unknown 传参，具体类型由各表模块定义） */
export interface TtfTableInstance {
  /** 表在字体文件中的偏移 */
  offset?: number;
  /** 计算表大小 */
  size?(ttf: unknown): number;
  /** 写入表内容 */
  write(writer: unknown, ttf: unknown): unknown;
  /** 读取表内容 */
  read(reader: unknown, ttf: unknown): unknown;
}

/** ttf 读取和写入支持的表集合 */
const support: Record<string, { new (offset?: number): TtfTableInstance }> = {
  head: head,
  maxp: maxp,
  loca: loca,
  cmap: cmap,
  glyf: glyf,
  name: name,
  hhea: hhea,
  hmtx: hmtx,
  post: post,
  'OS/2': OS2,
  fpgm: fpgm,
  cvt: cvt,
  prep: prep,
  gasp: gasp,
  GPOS: GPOS,
  GSUB: GSUB,
  kern: kern,
  kerx: kerx,
  BASE: BASE
};

export default support;
