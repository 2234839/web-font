/**
 * @file otf字体格式支持的表
 * @author mengke01(kekee000@gmail.com)
 */
import head from "./head";
import maxp from "./maxp";
import cmap from "./cmap";
import name from "./name";
import hhea from "./hhea";
import hmtx from "./hmtx";
import post from "./post";
import OS2 from "./OS2";
import CFF from "./CFF";
import GPOS from "./GPOS";
import kern from "./kern";
import type { TtfTableInstance } from "./support";

/** otf 字体格式支持的表集合 */
const supportOtf: Record<string, { new (offset?: number): TtfTableInstance }> = {
  head: head,
  maxp: maxp,
  cmap: cmap,
  name: name,
  hhea: hhea,
  hmtx: hmtx,
  post: post,
  'OS/2': OS2,
  CFF: CFF,
  GPOS: GPOS,
  kern: kern
};

export default supportOtf;
