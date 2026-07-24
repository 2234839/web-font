import fs from 'node:fs';
import * as TTFReaderNS from './vendor/fonteditor-core/lib/ttf/ttfreader.js';
const TTFReader: any = TTFReaderNS.default.default ?? TTFReaderNS.default;

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }

for (const [name, p, text] of [
  ['初夏标点', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '，。！？、；：“”‘’'],
] as const) {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
  const cps = Array.from(text).map(c => c.codePointAt(0)!);
  console.log(`\n=== ${name} (字体 ${ (buf.length/1024/1024).toFixed(1)}MB) ===`);

  // 读 directory 拿各表大小
  const view = new DataView(ab);
  const numTables = view.getUint16(4, false);
  const tables: {name:string; offset:number; length:number}[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i*16;
    const tag = String.fromCharCode(view.getUint8(rec), view.getUint8(rec+1), view.getUint8(rec+2), view.getUint8(rec+3));
    const off = view.getUint32(rec+8, false);
    const len = view.getUint32(rec+12, false);
    tables.push({name: tag, offset: off, length: len});
  }
  tables.sort((a,b)=>b.length-a.length);
  console.log('表大小 TOP:');
  for (const t of tables.slice(0,12)) console.log(`  ${t.name}: ${(t.length/1024).toFixed(0)}KB`);
}
