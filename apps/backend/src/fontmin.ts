import { Controller, File, Get, Post, Query } from "@malagu/mvc/lib/node";
import { Context } from "@malagu/web/lib/node";
import { createHash } from "crypto";
//@ts-ignore
import * as Fontmin from "fontmin";
import { promises as fs } from "fs";
import * as path from "path";
import { join } from "path";
//@ts-ignore
import { zip } from "zip-a-folder";
import { Stream } from "stream";

const font_src = path.join(__dirname, "../../frontend/font");
console.log("[__dirname]", __dirname);
console.log("[font_src]", font_src);
@Controller("api")
export class FontMinController {
  @Get("generate_fonts_dynamically")
  @File()
  async generate_fonts_dynamically(
    @Query("text") text: string,
    @Query("font") font: string,
    @Query("temp") temp: string = "true",
    @Query("type") type: string = "ttf",
  ) {
    console.log("字体请求", { text, font, temp, type });

    text += "●";
    const res = Context.getResponse();

    const hash = createHash("md5");
    hash.update(`${type}${font}${text}`);
    const hash_str = hash.digest("hex");

    const srcPath = path.join(font_src, `${font.replace(/.ttf$/, "")}.ttf`); // 字体源文件
    const outPath = `asset/dynamically/${hash_str}`;
    const destPath = `./${outPath}`; // 输出路径

    const full_path = join(__dirname, "../../", destPath, `${font}.${type}`);
    /** 需要持久化 */
    if (temp !== "true") {
      try {
        return await fs.readFile(full_path);
      } catch (error) {
        console.log(`开始生成 ${full_path}`, error);
      }
    }
    // 初始化
    const fontmin = new Fontmin()
      .src(srcPath) // 输入配置
      .use(
        Fontmin.glyph({
          text, // 所需文字
        }),
      );

    if ("eot" === type) {
      fontmin.use(Fontmin.ttf2eot()); // eot 转换插件
    }
    if ("woff" === type) {
      fontmin.use(Fontmin.ttf2woff()); // eot 转换插件
    }
    if ("svg" === type) {
      fontmin.use(Fontmin.ttf2svg()); // eot 转换插件
    }
    /** 缓存数据 */
    if (temp !== "true") {
      fontmin.dest(destPath);
    }

    // 执行
    return new Promise((resolve, reject) => {
      fontmin.run(async function (err: Error, files: any[]) {
        if (err) {
          // 异常捕捉
          reject(err);
        } else {
          const buffer = files.filter((f) =>
            /** 筛选需要的类型 */
            (f.history[f.history.length - 1] as string).endsWith(type),
          )[0]._contents;
          console.log("[buffer]", Buffer.isBuffer(buffer));
          const bufferStream = new Stream.PassThrough();
          bufferStream.end(buffer);
          bufferStream.pipe(res);
          // resolve(buffer); // 成功
        }
      });
    });
  }

  @Post("font_list")
  async font_list() {
    return fs.readdir(font_src);
  }
}
