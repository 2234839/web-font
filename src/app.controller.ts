import {
  Controller,
  Get,
  Param,
  Query,
  Response,
  Res,
  Req,
  Request,
} from '@nestjs/common';
import { AppService } from './app.service';
import { join } from 'path';
import { promises as fs  } from "fs";
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // @Get()
  // getHello(): string {
  //   return this.appService.getHello();
  // }

  /** 压缩字体 */
  @Get('fontmin')
  font_min(@Query('text') text, @Query('font') font) {
    return this.appService.font_min(text, font);
  }
  /** 返回字体列表 */
  @Get('font_list')
  font_list() {
    const font_dir= join(__dirname, '../../src/font')
    return fs.readdir(font_dir)
  }

}
