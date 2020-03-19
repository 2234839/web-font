import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import serveStatic from 'serve-static';
import { Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);


  await app.listen(3000);
}
bootstrap();

