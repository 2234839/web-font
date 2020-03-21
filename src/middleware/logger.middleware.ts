import { Response, Request } from 'express';

const NS_PER_SEC = 1e9;
export async function logger(req: Request, res: Response, next) {
  const time = process.hrtime();
  next();
  res.once('finish', () => {
    const diff = process.hrtime(time);
    console.log(
      `[${req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.remoteAddress}][${(diff[0] * NS_PER_SEC + diff[1]) /
        1000000}]`,
      decodeURI_catch(req.url),
    );
  });
}

function decodeURI_catch(url: string) {
  try {
    return decodeURI(url);
  } catch (error) {
    return url;
  }
}
