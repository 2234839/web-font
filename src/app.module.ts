import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
console.log( join(__dirname, '..'));

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..'),
    }),
    ServeStaticModule.forRoot({
      rootPath:  join(__dirname, '../../asset'),
      serveRoot: '/asset',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
