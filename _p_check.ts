import fs from 'node:fs';
import { Font } from './vendor/fonteditor-core/lib/ttf/font.js';
const buf = fs.readFileSync('/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const cps = Array.from('，。！？、；：“”‘’');
const font = Font.create(ab, { type: 'ttf', subset: cps as any, kerning: true });
const opt = (font as any).optimize();
const ttf = opt.get();
console.log('GPOS present:', !!ttf.GPOS, 'len:', ttf.GPOS && ttf.GPOS.length);
console.log('GSUB present:', !!ttf.GSUB);
console.log('numGlyphs:', ttf.glyf.length);
const ttfBuf = opt.write({ type: 'ttf', hinting: false } as any);
console.log('ttfBuf type:', ttfBuf.constructor.name, 'len:', ttfBuf.length);
// 完整 woff2 via font.write
const woff2 = opt.write({ type: 'woff2', hinting: false } as any);
console.log('woff2 (font.write):', woff2.length, 'type:', woff2.constructor.name);
