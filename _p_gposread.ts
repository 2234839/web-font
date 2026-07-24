import fs from 'node:fs';
const buf = fs.readFileSync('/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const view = new DataView(ab);
const numTables = view.getUint16(4, false);
let gposOff=0,gposLen=0;
for (let i=0;i<numTables;i++){const r=12+i*16;const tag=String.fromCharCode(view.getUint8(r),view.getUint8(r+1),view.getUint8(r+2),view.getUint8(r+3));if(tag==='GPOS'){gposOff=view.getUint32(r+8,false);gposLen=view.getUint32(r+12,false);break;}}
console.log('GPOS',gposOff,gposLen);

function median(a:number[]){return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];}

// 方式A: readBytes 的 slice 方式
const tA:number[]=[];
for(let i=0;i<30;i++){const t0=performance.now();const bytes=new Uint8Array(ab,gposOff,gposLen).slice();tA.push(performance.now()-t0);}
console.log(`slice(${gposLen}): ${median(tA).toFixed(4)}ms`);

// 方式B: new Uint8Array + set
const tB:number[]=[];
for(let i=0;i<30;i++){const t0=performance.now();const b=new Uint8Array(gposLen);b.set(new Uint8Array(ab,gposOff,gposLen));tB.push(performance.now()-t0);}
console.log(`new+set: ${median(tB).toFixed(4)}ms`);

// 方式C: subarray (零拷贝，但要确认后续不改原 buffer)
const tC:number[]=[];
for(let i=0;i<30;i++){const t0=performance.now();const b=new Uint8Array(ab,gposOff,gposLen);tC.push(performance.now()-t0);}
console.log(`subarray(view): ${median(tC).toFixed(4)}ms`);

// 方式D: copyBytesTo (Node 较新)
const tD:number[]=[];
const src=new Uint8Array(ab);
for(let i=0;i<30;i++){const b=new Uint8Array(gposLen);const t0=performance.now();src.copyBytesTo?src.copyBytesTo(b,0,gposOff,gposOff+gposLen):null;tD.push(performance.now()-t0);}
console.log(`copyBytesTo: ${median(tD).toFixed(4)}ms`);
