import { Injectable } from '@nestjs/common';
import Fontmin from 'fontmin';
const { zip } = require('zip-a-folder');
import { join } from 'path';
import crypto from 'crypto';
import { config } from './config';
import { promises as fs } from 'fs';
import { req_par } from './req.decorator';

const font_src="./asset/font_src/"

@Injectable()
export class AppService {
  font_list() {
    const font_dir = join(__dirname, `../../${font_src}`);
    return fs.readdir(font_dir);
  }
  async font_min(text: string, font: string,server_url:string) {
    /** 因为 text 为 空或者是空格之类的 会导致 fontmin 运算很久 */
    text+='●'
    const srcPath = `${font_src}${font}.ttf`; // 字体源文件
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
      .use(Fontmin.css({ fontPath: `${server_url}${outPath}` })) // css 生成插件
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
            .map(f => f._contents.toString())[0];
          zip(
            join(__dirname, '../../', destPath),
            join(__dirname, '../../', destPath, 'asset.zip'),
          );
          // resolve({code:0,fil:files.map(f=>f._contents.toString())}); // 成功
          // resolve({code:0,files}); // 成功
          resolve(css); // 成功
        }
      });
    });
  }

  async generate_fonts_dynamically(
    text: string,
    font: string,
    temp: string,
    type: string,
  ) {
    text+='●'
    const hash = crypto.createHash('md5');
    hash.update(`${type}${font}${text}`);
    const hash_str = hash.digest('hex');
    const srcPath = `${font_src}${font}.ttf`; // 字体源文件
    const outPath = `asset/dynamically/${hash_str}`;
    const destPath = `./${outPath}`; // 输出路径

    const full_path = join(__dirname, '../../', destPath, `${font}.${type}`);
    /** 需要持久化 */
    if (temp !== 'true') {
      try {
        return await fs.readFile(full_path);
      } catch (error) {
        console.log(`开始生成 ${full_path}`,error);
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

    if ('eot' === type) {
      fontmin.use(Fontmin.ttf2eot()); // eot 转换插件
    }
    if ('woff' === type) {
      fontmin.use(Fontmin.ttf2woff()); // eot 转换插件
    }
    if ('svg' === type) {
      fontmin.use(Fontmin.ttf2svg()); // eot 转换插件
    }
    /** 缓存数据 */
    if (temp !== 'true') {
      fontmin.dest(destPath)
    }


    // 执行
    return new Promise((resolve, reject) => {
      fontmin.run(async function(err, files, stream) {
        if (err) {
          // 异常捕捉
          reject(err);
        } else {
          const buffer = files.filter(f =>
            /** 筛选需要的类型 */
            (f.history[f.history.length - 1] as string).endsWith(type),
          )[0]._contents;
          resolve(buffer); // 成功
          /** 存个日志 */
          if (temp !== 'true') {
            const content_path = join(
              __dirname,
              '../../',
              destPath,
              `content.txt`,
            );
            try {
              await fs.appendFile(
                content_path,
                `type:${type}\nfont:${font}\ntext:${text}`,
              );
            } catch (error) {
              console.error(`写 ${content_path} 失败`);
            }
          }
        }
      });
    });
  }
}