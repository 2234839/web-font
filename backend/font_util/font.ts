import { Font, type FontEditor } from "fonteditor-core";

export const fontSubset = async (
  fontBuffer: ArrayBuffer,
  subString: string,
  option: {
    sourceType: FontEditor.FontType;
    outType: FontEditor.FontType;
  },
) => {
  const font = Font.create(fontBuffer, {
    type: option.sourceType,
    subset: [...subString].map((char) => char.codePointAt(0)!),
  });
  //  优化字体
  let optimizedFont = font.optimize();
  optimizedFont = optimizedFont.compound2simple();
  optimizedFont = optimizedFont.sort();
  const newFont = optimizedFont.write({
    type: option.outType,
  });
  return newFont as unknown as DataView;
};
