import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import serveStatic from 'serve-static';
import { Response } from 'express';
import { logger } from './middleware/logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.use(logger);

  await app.listen(3000);
}
bootstrap();

