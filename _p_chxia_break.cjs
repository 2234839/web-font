const fs = require('fs');
const path = require('path');
const ttf2woff2 = require('./vendor/fonteditor-core/lib/ttf2woff2.js');

const fontBuf = fs.readFileSync('./backend/font_util/标点测试字体/初夏明朝.ttf');
const text = '，。！？、：；';

// 复刻 fontSubset 的关键阶段
const { fontSubset } = require('./backend-ts-compiled.cjs');
