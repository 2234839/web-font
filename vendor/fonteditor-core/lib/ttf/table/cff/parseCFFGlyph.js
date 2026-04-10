"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = parseCFFCharstring;
/**
 * @file 解析cff字形
 * @author mengke01(kekee000@gmail.com)
 *
 * 优化157: stack.shift → 索引指针，消除 O(n) 数组移位
 * 优化158: 内联 lineTo/curveTo/newContour，减少函数调用开销
 * 优化159: contours.map → 内联闭合点检测，消除二次遍历
 * 优化178: contour 使用扁平数组 [x, y, flag, ...]，消除对象分配
 */

/** onCurve 标志位 */
var ON_CURVE = 1;

function parseCFFCharstring(code, font, index) {
  var contours = [];
  var contour = [];
  /** 优化170: 预分配 stack 为 48 元素数组，避免动态扩容 */
  var stack = new Array(48);
  var glyfs = [];
  var nStems = 0;
  var haveWidth = false;
  var width = font.defaultWidthX;
  var open = false;
  var x = 0;
  var y = 0;

  /**
   * 优化179: 模块级 closeContour，避免闭包捕获
   */
  function closeContour(arr) {
    var cLen = arr.length;
    if (cLen >= 6 && arr[0] === arr[cLen - 3] && arr[1] === arr[cLen - 2]) {
      arr.length = cLen - 3;
    }
    contours.push(arr);
  }
  function startContour(px, py) {
    if (open) closeContour(contour);
    contour = [px, py, ON_CURVE];
    open = true;
  }

  /**
   * 优化157: 用 sp (stack pointer) 和 si (stack index) 替代 shift/pop
   * push → stack[sp++] = val
   * pop  → stack[--sp]
   * shift → stack[si++] (读取后 si 追赶 sp)
   * stack.length → sp - si (有效元素数)
   */
  function parse(code) {
    var b1;
    var b2;
    var b3;
    var b4;
    var codeIndex;
    var subrCode;
    var jpx;
    var jpy;
    var c1x;
    var c1y;
    var c2x;
    var c2y;
    var c3x;
    var c3y;
    var c4x;
    var c4y;
    var i = 0;
    /** 索引指针替代 shift/pop */
    var sp = 0;
    var si = 0;
    while (i < code.length) {
      var v = code[i];
      i += 1;
      switch (v) {
        case 1:
        // hstem
        case 3:
        // vstem
        case 18:
        // hstemhm
        case 23:
          // vstemhm
          {
            /** parseStems 内联 */
            var sLen = sp - si;
            if (sLen & 1 && !haveWidth) {
              width = stack[si++] + font.nominalWidthX;
              sLen--;
            }
            nStems += sLen >> 1;
            sp = si = 0;
            haveWidth = true;
          }
          break;
        case 4:
          // vmoveto
          if (sp - si > 1 && !haveWidth) {
            width = stack[si++] + font.nominalWidthX;
            haveWidth = true;
          }
          y += stack[--sp];
          si = sp;
          startContour(x, y);
          break;
        case 5:
          // rlineto
          while (sp - si > 0) {
            x += stack[si++];
            y += stack[si++];
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 6:
          // hlineto
          while (sp - si > 0) {
            x += stack[si++];
            contour.push(x, y, ON_CURVE);
            if (sp - si === 0) break;
            y += stack[si++];
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 7:
          // vlineto
          while (sp - si > 0) {
            y += stack[si++];
            contour.push(x, y, ON_CURVE);
            if (sp - si === 0) break;
            x += stack[si++];
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 8:
          // rrcurveto
          while (sp - si > 0) {
            c1x = x + stack[si++];
            c1y = y + stack[si++];
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            x = c2x + stack[si++];
            y = c2y + stack[si++];
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 10:
          // callsubr
          codeIndex = stack[--sp] + font.subrsBias;
          subrCode = font.subrs[codeIndex];
          if (subrCode) {
            parse(subrCode);
          }
          si = sp;
          break;
        case 11:
          // return
          return;
        case 12:
          // flex operators
          v = code[i];
          i += 1;
          switch (v) {
            case 35:
              // flex
              c1x = x + stack[si++];
              c1y = y + stack[si++];
              c2x = c1x + stack[si++];
              c2y = c1y + stack[si++];
              jpx = c2x + stack[si++];
              jpy = c2y + stack[si++];
              c3x = jpx + stack[si++];
              c3y = jpy + stack[si++];
              c4x = c3x + stack[si++];
              c4y = c3y + stack[si++];
              x = c4x + stack[si++];
              y = c4y + stack[si++];
              si++;
              contour.push(c1x, c1y, 0);
              contour.push(c2x, c2y, 0);
              contour.push(jpx, jpy, ON_CURVE);
              contour.push(c3x, c3y, 0);
              contour.push(c4x, c4y, 0);
              contour.push(x, y, ON_CURVE);
              break;
            case 34:
              // hflex
              c1x = x + stack[si++];
              c1y = y;
              c2x = c1x + stack[si++];
              c2y = c1y + stack[si++];
              jpx = c2x + stack[si++];
              jpy = c2y;
              c3x = jpx + stack[si++];
              c3y = c2y;
              c4x = c3x + stack[si++];
              c4y = y;
              x = c4x + stack[si++];
              contour.push(c1x, c1y, 0);
              contour.push(c2x, c2y, 0);
              contour.push(jpx, jpy, ON_CURVE);
              contour.push(c3x, c3y, 0);
              contour.push(c4x, c4y, 0);
              contour.push(x, y, ON_CURVE);
              break;
            case 36:
              // hflex1
              c1x = x + stack[si++];
              c1y = y + stack[si++];
              c2x = c1x + stack[si++];
              c2y = c1y + stack[si++];
              jpx = c2x + stack[si++];
              jpy = c2y;
              c3x = jpx + stack[si++];
              c3y = c2y;
              c4x = c3x + stack[si++];
              c4y = c3y + stack[si++];
              x = c4x + stack[si++];
              contour.push(c1x, c1y, 0);
              contour.push(c2x, c2y, 0);
              contour.push(jpx, jpy, ON_CURVE);
              contour.push(c3x, c3y, 0);
              contour.push(c4x, c4y, 0);
              contour.push(x, y, ON_CURVE);
              break;
            case 37:
              // flex1
              c1x = x + stack[si++];
              c1y = y + stack[si++];
              c2x = c1x + stack[si++];
              c2y = c1y + stack[si++];
              jpx = c2x + stack[si++];
              jpy = c2y + stack[si++];
              c3x = jpx + stack[si++];
              c3y = jpy + stack[si++];
              c4x = c3x + stack[si++];
              c4y = c3y + stack[si++];
              if (c4x - x > 0 ? c4x - x > -(c4y - y) : -(c4x - x) < c4y - y) {
                x = c4x + stack[si++];
              } else {
                y = c4y + stack[si++];
              }
              contour.push(c1x, c1y, 0);
              contour.push(c2x, c2y, 0);
              contour.push(jpx, jpy, ON_CURVE);
              contour.push(c3x, c3y, 0);
              contour.push(c4x, c4y, 0);
              contour.push(x, y, ON_CURVE);
              break;
            default:
              console.warn('Glyph ' + index + ': unknown operator ' + (1200 + v));
          }
          sp = si = 0;
          break;
        case 14:
          // endchar
          if (sp - si === 1 && !haveWidth) {
            width = stack[si++] + font.nominalWidthX;
            haveWidth = true;
          } else if (sp - si === 4) {
            glyfs[1] = {
              glyphIndex: font.charset.indexOf(font.encoding[stack[--sp]]),
              transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
            };
            glyfs[0] = {
              glyphIndex: font.charset.indexOf(font.encoding[stack[--sp]]),
              transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
            };
            glyfs[1].transform.f = stack[--sp];
            glyfs[1].transform.e = stack[--sp];
          } else if (sp - si === 5) {
            if (!haveWidth) {
              width = stack[si++] + font.nominalWidthX;
            }
            haveWidth = true;
            glyfs[1] = {
              glyphIndex: font.charset.indexOf(font.encoding[stack[--sp]]),
              transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
            };
            glyfs[0] = {
              glyphIndex: font.charset.indexOf(font.encoding[stack[--sp]]),
              transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
            };
            glyfs[1].transform.f = stack[--sp];
            glyfs[1].transform.e = stack[--sp];
          }
          if (open) {
            closeContour(contour);
            open = false;
          }
          sp = si = 0;
          break;
        case 19: // hintmask
        case 20:
          // cntrmask
          {
            var sLen2 = sp - si;
            if (sLen2 & 1 && !haveWidth) {
              width = stack[si++] + font.nominalWidthX;
              sLen2--;
            }
            nStems += sLen2 >> 1;
            sp = si = 0;
            haveWidth = true;
            i += nStems + 7 >> 3;
          }
          break;
        case 21:
          // rmoveto
          if (sp - si > 2 && !haveWidth) {
            width = stack[si++] + font.nominalWidthX;
            haveWidth = true;
          }
          y += stack[--sp];
          x += stack[--sp];
          si = sp;
          startContour(x, y);
          break;
        case 22:
          // hmoveto
          if (sp - si > 1 && !haveWidth) {
            width = stack[si++] + font.nominalWidthX;
            haveWidth = true;
          }
          x += stack[--sp];
          si = sp;
          startContour(x, y);
          break;
        case 24:
          // rcurveline
          while (sp - si > 2) {
            c1x = x + stack[si++];
            c1y = y + stack[si++];
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            x = c2x + stack[si++];
            y = c2y + stack[si++];
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
          }
          x += stack[si++];
          y += stack[si++];
          contour.push(x, y, ON_CURVE);
          sp = si = 0;
          break;
        case 25:
          // rlinecurve
          while (sp - si > 6) {
            x += stack[si++];
            y += stack[si++];
            contour.push(x, y, ON_CURVE);
          }
          c1x = x + stack[si++];
          c1y = y + stack[si++];
          c2x = c1x + stack[si++];
          c2y = c1y + stack[si++];
          x = c2x + stack[si++];
          y = c2y + stack[si++];
          contour.push(c1x, c1y, 0);
          contour.push(c2x, c2y, 0);
          contour.push(x, y, ON_CURVE);
          sp = si = 0;
          break;
        case 26:
          // vvcurveto
          if ((sp - si) & 1) {
            x += stack[si++];
          }
          while (sp - si > 0) {
            c1x = x;
            c1y = y + stack[si++];
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            x = c2x;
            y = c2y + stack[si++];
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 27:
          // hhcurveto
          if ((sp - si) & 1) {
            y += stack[si++];
          }
          while (sp - si > 0) {
            c1x = x + stack[si++];
            c1y = y;
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            x = c2x + stack[si++];
            y = c2y;
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 28:
          // shortint
          b1 = code[i];
          b2 = code[i + 1];
          stack[sp++] = (b1 << 24 | b2 << 16) >> 16;
          i += 2;
          break;
        case 29:
          // callgsubr
          codeIndex = stack[--sp] + font.gsubrsBias;
          subrCode = font.gsubrs[codeIndex];
          if (subrCode) {
            parse(subrCode);
          }
          si = sp;
          break;
        case 30:
          // vhcurveto
          while (sp - si > 0) {
            c1x = x;
            c1y = y + stack[si++];
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            x = c2x + stack[si++];
            y = c2y + (sp - si === 1 ? stack[si++] : 0);
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
            if (sp - si === 0) break;
            c1x = x + stack[si++];
            c1y = y;
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            y = c2y + stack[si++];
            x = c2x + (sp - si === 1 ? stack[si++] : 0);
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        case 31:
          // hvcurveto
          while (sp - si > 0) {
            c1x = x + stack[si++];
            c1y = y;
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            y = c2y + stack[si++];
            x = c2x + (sp - si === 1 ? stack[si++] : 0);
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
            if (sp - si === 0) break;
            c1x = x;
            c1y = y + stack[si++];
            c2x = c1x + stack[si++];
            c2y = c1y + stack[si++];
            x = c2x + stack[si++];
            y = c2y + (sp - si === 1 ? stack[si++] : 0);
            contour.push(c1x, c1y, 0);
            contour.push(c2x, c2y, 0);
            contour.push(x, y, ON_CURVE);
          }
          sp = si = 0;
          break;
        default:
          if (v < 32) {
            console.warn('Glyph ' + index + ': unknown operator ' + v);
          } else if (v < 247) {
            stack[sp++] = v - 139;
          } else if (v < 251) {
            b1 = code[i];
            i += 1;
            stack[sp++] = (v - 247) * 256 + b1 + 108;
          } else if (v < 255) {
            b1 = code[i];
            i += 1;
            stack[sp++] = -(v - 251) * 256 - b1 - 108;
          } else {
            b1 = code[i];
            b2 = code[i + 1];
            b3 = code[i + 2];
            b4 = code[i + 3];
            i += 4;
            stack[sp++] = (b1 << 24 | b2 << 16 | b3 << 8 | b4) / 65536;
          }
      }
    }
  }
  parse(code);
  var glyf = {
    contours: contours,
    advanceWidth: width,
    _flatContours: true
  };
  if (glyfs.length) {
    glyf.compound = true;
    glyf.glyfs = glyfs;
  }
  return glyf;
}
