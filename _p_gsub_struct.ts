import fs from 'node:fs';
const buf = fs.readFileSync('/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const view = new DataView(ab);
// 找 GSUB
const numTables = view.getUint16(4, false);
let off=0;
for (let i=0;i<numTables;i++){const r=12+i*16;const tag=String.fromCharCode(view.getUint8(r),view.getUint8(r+1),view.getUint8(r+2),view.getUint8(r+3));if(tag==='GSUB'){off=view.getUint32(r+8,false);break;}}
// GSUB: version(u32) scriptListOff(u16) featureListOff(u16) lookupListOff(u16)
const v = view.getUint32(off, false);
const scriptOff = off + view.getUint16(off+4, false);
const featOff = off + view.getUint16(off+6, false);
const lookupOff = off + view.getUint16(off+8, false);
const lookupCount = view.getUint16(lookupOff, false);
console.log('GSUB version:', (v>>>16), '.', (v&0xffff));
console.log('lookupCount:', lookupCount);
for (let i=0;i<lookupCount;i++){
  const lOff = lookupOff + view.getUint16(lookupOff+2+i*2, false);
  const type = view.getUint16(lOff, false);
  const flag = view.getUint16(lOff+2, false);
  const subCount = view.getUint16(lOff+4, false);
  console.log(`  lookup[${i}]: type=${type} flag=${flag} subCount=${subCount}`);
}
