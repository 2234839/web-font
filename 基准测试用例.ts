/**
 * 字体裁剪基准测试共享用例表
 *
 * 被 基准测试.test.ts（puppeteer 浏览器渲染）与 基准测试_leafer.test.ts
 * （@leafer-ui/node + Skia 渲染）共用，保证两版测同一组输入。
 *
 * 字段说明见 TestCase 各成员注释；fullFormat 仅供浏览器 @font-face format 提示使用。
 */

/**
 * 千字文中段（接续前段，用于更长文本压力测试）
 */
const QIANZIWEN_MID = "墨悲丝染诗赞羔羊景行维贤克念作圣德建名立形端表正空谷传声虚堂习听祸因恶积福缘善庆尺璧非宝寸阴是竞资父事君曰严与敬孝当竭力忠则尽命临深履薄夙兴温凊似兰斯馨如松之盛川流不息渊澄取映";

/** 单条基准用例 */
export interface TestCase {
  /** 结果展示标签（同名不同 outType 视为同场景的两种输出） */
  label: string;
  /** 字体文件路径（相对项目根，或绝对路径） */
  fontPath: string;
  /** 字体名（仅展示用） */
  fontName: string;
  /** 裁剪保留的文本 */
  text: string;
  /** 输入字体轮廓类型：ttf(glyf) / otf(CFF) */
  sourceType: "ttf" | "otf";
  /** 输出容器：裸 ttf / woff2 */
  outType: "ttf" | "woff2";
  /** 浏览器 @font-face 的 format 提示（仅 puppeteer 版使用） */
  fullFormat: "truetype" | "opentype";
  /** 渲染字号（默认 48），小字号用例守护低分辨率下 SSIM 不退化 */
  fontSize?: number;
}

export const testCases: TestCase[] = [
  /** ===== 令东齐伋复刻体（TTF，楷书复古字体，主基准） ===== */
  { label: "8个汉字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "ttf", fullFormat: "truetype" },
  { label: "8个汉字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  { label: "拉丁+数字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "Hello World 123", sourceType: "ttf", outType: "ttf", fullFormat: "truetype" },
  { label: "拉丁+数字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "Hello World 123", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  { label: "千字文前段", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", sourceType: "ttf", outType: "ttf", fullFormat: "truetype" },
  { label: "千字文前段", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** 重复字符：守护 codePoints 去重逻辑，相同字形不应重复输出 */
  { label: "重复字符", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天天天天地地地地", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },

  /** ===== 思源黑体（TTF，无衬线黑体，字形简洁） ===== */
  { label: "思源黑体-8字", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "ttf", fullFormat: "truetype" },
  { label: "思源黑体-8字", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** 纯标点：非汉字字形 + 组合标记的渲染守护 */
  { label: "思源黑体-标点", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "，。！？、；：“”‘’", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** CJK 扩展 B 罕见字（代理对）：守护 textToCodePoints 的代理对跳过逻辑 */
  { label: "思源黑体-扩展B", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "𠮷𡧑𢀖𤍤𥝹", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** 千字文中段：超长文本压力测试（>100 字） */
  { label: "思源黑体-千字文中段", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: QIANZIWEN_MID, sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },

  /** ===== Yi山碑篆体（TTF，笔画极其复杂的篆书，字形数据量大） ===== */
  { label: "篆体-8字", fontPath: "font/temp/YiShanBeiZhuanTi.ttf", fontName: "Yi山碑篆体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "ttf", fullFormat: "truetype" },
  { label: "篆体-8字", fontPath: "font/temp/YiShanBeiZhuanTi.ttf", fontName: "Yi山碑篆体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },

  /** ===== OTF 字体（含三点水等复杂笔画字，守护 OTF→TTF 转换正确性） ===== */
  { label: "otf-五个汉字", fontPath: "font/temp/BaiHuOTFJiaoYuHanZi-2.otf", fontName: "白狐教育汉字", text: "天地黄宇宙法海波", sourceType: "otf", outType: "ttf", fullFormat: "opentype" },
  /** OTF→woff2 输出路径守护（之前仅测 ttf 输出） */
  { label: "otf-五个汉字", fontPath: "font/temp/BaiHuOTFJiaoYuHanZi-2.otf", fontName: "白狐教育汉字", text: "天地黄宇宙法海波", sourceType: "otf", outType: "woff2", fullFormat: "opentype" },
  { label: "otf-思源黑体", fontPath: "font/temp/SourceHanSans-Regular.otf", fontName: "思源黑体", text: "天地玄黄宇宙洪法海波", sourceType: "otf", outType: "ttf", fullFormat: "opentype" },
  { label: "otf-思源黑体", fontPath: "font/temp/SourceHanSans-Regular.otf", fontName: "思源黑体", text: "天地玄黄宇宙洪法海波", sourceType: "otf", outType: "woff2", fullFormat: "opentype" },
  /** 白狐千字文长文本：触发 type3 AlternateSubst 大 coverage（千 gid）反转路径 + 守护
   *  serializeAlternateSubst 越界 coverage gid 正确性（白狐含损坏 coverage，原 undefined 漏网 bug） */
  { label: "otf-白狐千字文", fontPath: "font/temp/BaiHuOTFJiaoYuHanZi-2.otf", fontName: "白狐教育汉字", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳", sourceType: "otf", outType: "woff2", fullFormat: "opentype" },

  /** ===== 小字号渲染（size=24，守护 SSIM 在小字号下不退化） ===== */
  { label: "小字号-8字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "woff2", fullFormat: "truetype", fontSize: 24 },
  { label: "小字号-篆体", fontPath: "font/temp/YiShanBeiZhuanTi.ttf", fontName: "Yi山碑篆体", text: "天地玄黄宇宙洪荒", sourceType: "ttf", outType: "woff2", fullFormat: "truetype", fontSize: 24 },

  /**
   * ===== D:\字体资源 多字体扩展覆盖 =====
   * 用「汉字+标点」混合文本，最能暴露 GPOS 标点压缩丢失问题。
   * 覆盖不同 GPOS lookup 类型：得意黑仅 PairPos(完全支持)，霞鹜文楷含 ChainedContextPos(type8，降级)，
   * 思源宋体(OTF)含 MarkBasePos(type4，降级)。降级时保留原始 GPOS 字节，验证不劣于子集化前。
   */
  { label: "得意黑-汉字标点", fontPath: "/mnt/d/字体资源/得意黑/SmileySans-Oblique.ttf", fontName: "得意黑", text: "你好，世界！今天天气不错。", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  { label: "霞鹜文楷-汉字标点", fontPath: "/mnt/d/字体资源/霞鹜文楷/LXGWWenKai-Regular.ttf", fontName: "霞鹜文楷", text: "你好，世界！今天天气不错。", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** 初夏明朝（TTF，宋体/明朝风格衬线字，含标点压缩） */
  { label: "初夏明朝-汉字标点", fontPath: "/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf", fontName: "初夏明朝", text: "你好，世界！今天天气不错。", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  { label: "霞鹜文楷-纯标点", fontPath: "/mnt/d/字体资源/霞鹜文楷/LXGWWenKai-Regular.ttf", fontName: "霞鹜文楷", text: "，。！？、；：“”‘’", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  { label: "初夏明朝-纯标点", fontPath: "/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf", fontName: "初夏明朝", text: "，。！？、；：“”‘’", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  { label: "得意黑-纯标点", fontPath: "/mnt/d/字体资源/得意黑/SmileySans-Oblique.ttf", fontName: "得意黑", text: "，。！？、；：“”‘’", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** 鸿蒙黑体（TTF，现代无衬线，GPOS 仅 SinglePos/PairPos） */
  { label: "鸿蒙黑体-汉字标点", fontPath: "/mnt/d/字体资源/鸿蒙字体/HarmonyOS_Sans_SC_Black.ttf", fontName: "鸿蒙黑体", text: "你好，世界！今天天气不错。", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** 优设标题黑（TTF，艺术黑体） */
  { label: "优设标题黑-汉字标点", fontPath: "/mnt/d/字体资源/优设标题黑/优设标题黑.ttf", fontName: "优设标题黑", text: "你好，世界！今天天气不错。", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
  /** FiraCode（拉丁等宽，GPOS 做 ligature，非 CJK 标点，验证降级路径不破坏拉丁字体） */
  { label: "FiraCode-代码", fontPath: "/mnt/d/字体资源/FiraCode/FiraCode-Medium.ttf", fontName: "FiraCode", text: "=> !== >= <= ===", sourceType: "ttf", outType: "woff2", fullFormat: "truetype" },
];
