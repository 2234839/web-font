import { Injectable } from '@nestjs/common';
import Fontmin from 'fontmin';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  font_min(text:string,font:string) {
    const srcPath = `./src/font/${font}.ttf`; // 字体源文件
    const outPath = `asset/font/${Date.now()}/`;
    const destPath = `./${outPath}`; // 输出路径
    // 初始化
    const fontmin = new Fontmin()
      .src(srcPath) // 输入配置
      .use(
        Fontmin.glyph({
          text, // 所需文字
        }),
      )
      .use(Fontmin.ttf2eot()) // eot 转换插件
      .use(Fontmin.ttf2woff()) // woff 转换插件
      .use(Fontmin.ttf2svg()) // svg 转换插件
      .use(Fontmin.css({ fontPath: `http://127.0.0.1:3000/${outPath}` })) // css 生成插件
      .dest(destPath); // 输出配置

    // 执行
    return new Promise((resolve, reject) => {
      fontmin.run(function(err, files, stream) {
        if (err) {
          // 异常捕捉
          reject(err);
        } else {
          const css = files
            .filter(f =>
              (f.history[f.history.length - 1] as string).endsWith('.css'),
            )
            .map(f => f._contents.toString());
          // resolve({code:0,fil:files.map(f=>f._contents.toString())}); // 成功
          // resolve({code:0,files}); // 成功
          resolve(css); // 成功
        }
      });
    });
  }
}
