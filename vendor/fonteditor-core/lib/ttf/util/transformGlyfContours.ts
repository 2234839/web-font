/**
 * @file 转换复合字形的contours，以便于显示
 * @author mengke01(kekee000@gmail.com)
 */

/** 简单字形的 ON_CURVE 位（glyFlag.ONCURVE = 0x01） */
const ON_CURVE = 0x01;

/**
 * 从紧凑格式（_xArr/_yArr/_flags/endPtsOfContours）即时构建扁平 contours。
 *
 * 复合字形的 component 在 subset 阶段（resolveGlyf → compound2simpleglyf → 本函数）
 * 被访问时尚未经过 optimize，simple component 仅解析出紧凑坐标数据而无 contours 字段。
 * 正常 codepoint 子集不会保留无 unicode 的连字 target（compound），故不触发此路径；
 * 当 extraSubsetGids 注入连字 target（如 FiraCode 的 greater_equal.liga）时，
 * 其 component 为紧凑 simple 字形，需在此即时展开为扁平 contours 供仿射变换使用。
 *
 * 扁平格式：contour = [x0,y0,onCurve0, x1,y1,onCurve1, ...]（与 transformAndCeilFlat 一致）。
 */
function buildFlatContoursFromCompact(glyph: any): number[][] {
  const xArr = glyph._xArr;
  const yArr = glyph._yArr;
  const flags = glyph._flags;
  const endPts = glyph.endPtsOfContours;
  if (!xArr || !yArr || !flags || !endPts) {
    return [];
  }
  const contours = new Array<number[]>(endPts.length);
  let ptStart = 0;
  for (let ci = 0, cl = endPts.length; ci < cl; ci++) {
    const ptEnd = endPts[ci];
    const ptCount = ptEnd - ptStart + 1;
    const contour = new Array<number>(ptCount * 3);
    for (let pi = 0; pi < ptCount; pi++) {
      const pIdx = ptStart + pi;
      contour[pi * 3] = xArr[pIdx];
      contour[pi * 3 + 1] = yArr[pIdx];
      contour[pi * 3 + 2] = flags[pIdx] & ON_CURVE ? 1 : 0;
    }
    contours[ci] = contour;
    ptStart = ptEnd + 1;
  }
  return contours;
}

/**
 * 优化15+66+197: 扁平格式单次遍历 pathTransform + pathCeil
 * 优化197: 使用 +0.5|0 替代 Math.round，避免函数调用开销
 */
function transformAndCeilFlat(contour: number[], a: number, b: number, c: number, d: number, e: number, f: number): number[] {
  for (let i = 0, l = contour.length; i < l; i += 3) {
    const x = contour[i];
    const y = contour[i + 1];
    contour[i] = (x * a + y * c + e + 0.5) | 0;
    contour[i + 1] = (x * b + y * d + f + 0.5) | 0;
  }
  return contour;
}

/**
 * 转换复合字形轮廓，结果保存在contoursList中，并返回当前glyf的轮廓
 *
 * @param glyf glyf对象
 * @param ttf ttfObject对象
 * @param contoursList 保存转换中间生成的contours
 * @param glyfIndex glyf对象当前的index
 * @return 转换后的轮廓
 */
export default function transformGlyfContours(glyf: any, ttf: any, contoursList: Record<number, any[]> = {}, glyfIndex?: number): any[] {
  if (!glyf.glyfs) {
    return glyf;
  }
  const compoundContours: any[] = [];
  /* 优化: forEach → for 循环，消除闭包分配 */
  const glyfs = glyf.glyfs;
  for (let gi = 0, gl = glyfs.length; gi < gl; gi++) {
    const g = glyfs[gi];
    const glyph = ttf.glyf[g.glyphIndex];
    if (!glyph || glyph === glyf) {
      continue;
    }

    // 递归转换contours
    if (glyph.compound && !contoursList[g.glyphIndex]) {
      transformGlyfContours(glyph, ttf, contoursList, g.glyphIndex);
    }

    let sourceContours = glyph.compound ? contoursList[g.glyphIndex] || [] : glyph.contours;
    /* 紧凑 simple component（无 contours，仅有 _xArr/_yArr/_flags/endPtsOfContours）：
     * subset 阶段尚未 optimize，连字 target 的 component 需即时展开为扁平 contours。 */
    if (!sourceContours && glyph._xArr) {
      sourceContours = buildFlatContoursFromCompact(glyph);
    }
    /* 优化259: 提升 transform 属性到局部变量，消除每次迭代的属性链查找 */
    const t = g.transform;
    const ta = t.a, tb = t.b, tc = t.c, td = t.d, te = t.e, tf = t.f;

    if (sourceContours.length && typeof sourceContours[0][0] === "number") {
      /* 优化14+15+66: 扁平格式 - 浅拷贝 + 单次遍历 transform+ceil */
      for (let i = 0, l = sourceContours.length; i < l; i++) {
        const contour = sourceContours[i].slice();
        compoundContours.push(transformAndCeilFlat(contour, ta, tb, tc, td, te, tf));
      }
    } else {
      /* 优化265: 浅拷贝 contour 数组 + 内联 transform+ceil，消除 deep clone 开销 */
      for (let i = 0, l = sourceContours.length; i < l; i++) {
        const srcContour = sourceContours[i];
        const newContour = new Array<any>(srcContour.length);
        for (let pi = 0, pl = srcContour.length; pi < pl; pi++) {
          const p = srcContour[pi];
          const px = p.x * ta + p.y * tc + te;
          const py = p.x * tb + p.y * td + tf;
          newContour[pi] = { x: (px + 0.5) | 0, y: (py + 0.5) | 0, onCurve: p.onCurve };
        }
        compoundContours.push(newContour);
      }
    }
  }

  // eslint-disable-next-line eqeqeq
  if (null != glyfIndex) {
    contoursList[glyfIndex] = compoundContours;
  }
  return compoundContours;
}
