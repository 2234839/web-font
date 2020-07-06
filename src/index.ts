import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Server } from '@webserverless/fc-express';
import express from 'express';
import { AppModule } from './app.module';

const app = express();

let p = (async () => {
  const adapter = new ExpressAdapter(app);
  const app2 = await NestFactory.create(AppModule, adapter);
  app2.enableCors();
  await app2.init();
})();
app.use(function(req, res, next) {
  console.log(`▩▩▩[time:${Date.now()} [url:${req.url}]]`);
  p.then(() => next());
});

const server = new Server(app);

module.exports.handler = function(req, res, context) {
  server.httpProxy(req, res, context);
};
