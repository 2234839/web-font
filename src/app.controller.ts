import {
  Controller,
  Get,
  Param,
  Query,
  Response,
  Res,
  Req,
  Post,
  Body,
} from '@nestjs/common';
import { AppService } from './app.service';
import { join } from 'path';
import { promises as fs } from 'fs';
import { Request } from 'express';
import { Stream } from 'stream';
import { req_par } from './req.decorator';
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 压缩字体 */
  @Get('fontmin')
  font_min(@Query('text') text, @Query('font') font,@req_par('host_url') host_url:string) {

    return this.appService.font_min(text, font,host_url);
  }
  @Post('fontmin')
  font_min_post(@Body() body: { text: string; font: string }[],@req_par('host_url') host_url:string) {
    const res = body.map(par => {
      return new Promise((resolve, reject) => {
        this.appService
          .font_min(par.text, par.font,host_url)
          .then(r => {
            resolve({
              font: par.font,
              css:r,
              status: 'success',
            });
          })
          .catch(e => {
            resolve({
              font: par.font,
              status: 'failure',
            });
          });
      });
    });
    return Promise.all(res);
  }

  /** 返回字体列表 */
  @Get('font_list')
  font_list() {
    return this.appService.font_list();
  }

  /** 压缩字体 */
  @Get('generate_fonts_dynamically*')
  async generate_fonts_dynamically(
    @Req() req: Request,
    @Res() res,
    @Query('text') text: string,
    @Query('font') font: string,
    @Query('temp') temp: string,
  ) {
    const type = req.url.match(/\.(.*)\?/)[1];
    res.set({
      'Content-Type': `font/${type}`,
    });
    if (!text) return ' ';
    const file = await this.appService.generate_fonts_dynamically(
      text,
      font,
      temp,
      type,
    );

    const bufferStream = new Stream.PassThrough();
    bufferStream.end(file);
    bufferStream.pipe(res);
  }
}

function promise_execute_all<T>(params: Promise<T>[]) {}
