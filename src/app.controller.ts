import {
  Controller,
  Get,
  Param,
  Query,
  Response,
  Res,
  Req,
} from '@nestjs/common';
import { AppService } from './app.service';
import { join } from 'path';
import { promises as fs } from 'fs';
import { Request } from 'express';
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 压缩字体 */
  @Get('fontmin')
  font_min(@Query('text') text, @Query('font') font) {
    return this.appService.font_min(text, font);
  }

  /** 返回字体列表 */
  @Get('font_list')
  font_list() {
    const font_dir = join(__dirname, '../../src/font');
    return fs.readdir(font_dir);
  }

  /** 压缩字体 */
  @Get('generate_fonts_dynamically*')
  generate_fonts_dynamically(
    @Req() req:Request,
    @Query('text') text: string,
    @Query('font') font: string,
    @Query('temp') temp: string,
  ) {
    const format=req.url.match(/\.(.*)\?/)[1]
    return this.appService.generate_fonts_dynamically(text, font,temp,format);
  }
}
