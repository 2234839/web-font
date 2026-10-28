/**
 * 复合图元标记位（componentFlag.js 的类型声明）
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6glyf.html
 */
declare const componentFlag: {
  readonly ARG_1_AND_2_ARE_WORDS: 0x01;
  readonly ARGS_ARE_XY_VALUES: 0x02;
  readonly ROUND_XY_TO_GRID: 0x04;
  readonly WE_HAVE_A_SCALE: 0x08;
  readonly RESERVED: 0x10;
  readonly MORE_COMPONENTS: 0x20;
  readonly WE_HAVE_AN_X_AND_Y_SCALE: 0x40;
  readonly WE_HAVE_A_TWO_BY_TWO: 0x80;
  readonly WE_HAVE_INSTRUCTIONS: 0x100;
  readonly USE_MY_METRICS: 0x200;
  readonly OVERLAP_COMPOUND: 0x400;
  readonly SCALED_COMPONENT_OFFSET: 0x800;
  readonly UNSCALED_COMPONENT_OFFSET: 0x1000;
};

export default componentFlag;
