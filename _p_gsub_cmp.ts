import fs from 'node:fs';
import { Font } from './vendor/fonteditor-core/lib/ttf/font.js';
import { subsetGSUB } from './backend/font_util/gsub-subset.js';
import crypto from 'node:crypto';

const cases: [string, string, string][] = [
  ['初夏纯标点', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '，。！？、；：“”‘’'],
  ['初夏汉字', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '你好，世界！今天天气不错。'],
  ['思源8字', './font/思源黑体.ttf', '天地玄黄宇宙洪荒'],
  ['令东千字', './font/令东齐伋复刻体.ttf', '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈'],
  ['FiraCode', '/mnt/d/字体资源/FiraCode/FiraCode-Medium.ttf', '=> !== >= <= ==='],
];
for (const [name, p, text] of cases) {
  if (!fs.existsSync(p)) { console.log(`${name}: 跳过(文件不存在)`); continue; }
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
  const cps = Array.from(text).map(c => c.codePointAt(0)!);
  const font = Font.create(ab, { type: 'ttf', subset: cps as any, kerning: true });
  const ttf = font.get();
  const subsetGids: number[] = ttf.subsetGids ?? [];
  const origToNew = new Map<number, number>();
  for (let i = 0; i < subsetGids.length; i++) origToNew.set(subsetGids[i], i);
  const gsub = ttf.GSUB;
  if (!gsub) { console.log(`${name}: 无 GSUB`); continue; }
  const b = gsub instanceof Uint8Array ? gsub : new Uint8Array(gsub);
  const out = subsetGSUB(b, origToNew);
  const hash = crypto.createHash('sha256').update(out).digest('hex').slice(0,16);
  console.log(`${name}: gsubOut=${out.length}B hash=${hash}`);
}
