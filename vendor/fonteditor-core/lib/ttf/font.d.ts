/**
 * fonteditor-core 类型声明
 */

export namespace FontEditor {
  export type FontType = "ttf" | "otf" | "woff" | "woff2" | "eot" | "svg";
  
  export interface SubsetOptions {
    type?: string;
    subset?: number[];
    kerning?: boolean;
    extraSubsetGids?: number[];
    presetCmap?: Record<number, number>;
  }
}

export interface FontEditor {
  /** 字体编辑器接口 */
}

export function createFontEditor(data: ArrayBuffer): FontEditor;

export class Font {
  static create(buffer: ArrayBuffer | Buffer | string | Document, options?: FontEditor.SubsetOptions): Font;
  
  get(): any;
  set(data: any): Font;
  export(options?: { type?: string }): ArrayBuffer;
  optimize(options?: any): Font;
  write(options?: any): ArrayBuffer;
}