import path2contours from "./path2contours";
import oval2contour from "./oval2contour";
import polygon2contour from "./polygon2contour";
import rect2contour from "./rect2contour";
import parseTransform from "./parseTransform";
import contoursTransform from "./contoursTransform";

/**
 * @file svg节点转字形轮廓
 * @author mengke01(kekee000@gmail.com)
 */

// 支持的解析器集合
const support: Record<string, { parse: (...args: any[]) => any; params: string[]; contours?: boolean }> = {
  path: {
    parse: path2contours,
    // 解析器
    params: ["d"],
    // 参数列表
    contours: true // 是否是多个轮廓
  },
  circle: {
    parse: oval2contour,
    params: ["cx", "cy", "r"]
  },
  ellipse: {
    parse: oval2contour,
    params: ["cx", "cy", "rx", "ry"]
  },
  rect: {
    parse: rect2contour,
    params: ["x", "y", "width", "height"]
  },
  polygon: {
    parse: polygon2contour,
    params: ["points"]
  },
  polyline: {
    parse: polygon2contour,
    params: ["points"]
  }
};

/**
 * svg节点转字形轮廓
 *
 * @param xmlNodes xml节点集合
 * @return 轮廓数组
 */
export default function svgnode2contours(xmlNodes: ArrayLike<any>): any[] | false {
  let i: number;
  let length: number;
  let j: number;
  let jlength: number;
  let segment: any; // 当前指令
  const parsedSegments: any[] = []; // 解析后的指令

  if (xmlNodes.length) {
    for (i = 0, length = xmlNodes.length; i < length; i++) {
      const node = xmlNodes[i];
      const name = node.tagName;
      if (support[name]) {
        const supportParams = support[name].params;
        const params: string[] = [];
        for (j = 0, jlength = supportParams.length; j < jlength; j++) {
          params.push(node.getAttribute(supportParams[j]));
        }
        segment = {
          name: name,
          params: params,
          transform: parseTransform(node.getAttribute("transform"))
        };
        if (node.parentNode) {
          let curNode = node.parentNode;
          const transforms = segment.transform || [];
          let transAttr: string | null;
          const iterator = (t: any) => {
            transforms.unshift(t);
          };
          while (curNode !== null && curNode.tagName !== "svg") {
            transAttr = curNode.getAttribute("transform");
            if (transAttr) {
              const parentTransforms = parseTransform(transAttr);
              if (parentTransforms) {
                parentTransforms.reverse().forEach(iterator);
              }
            }
            curNode = curNode.parentNode;
          }
          segment.transform = transforms.length ? transforms : null;
        }
        parsedSegments.push(segment);
      }
    }
  }
  if (parsedSegments.length) {
    const result: any[] = [];
    for (i = 0, length = parsedSegments.length; i < length; i++) {
      segment = parsedSegments[i];
      const parser = support[segment.name];
      const contour = parser.parse.apply(null, segment.params);
      if (contour && contour.length) {
        const contours = parser.contours ? contour : [contour];

        // 如果有变换则应用变换规则
        let finalContours = contours;
        if (segment.transform) {
          finalContours = contoursTransform(contours, segment.transform);
        }
        for (j = 0, jlength = finalContours.length; j < jlength; j++) {
          result.push(finalContours[j]);
        }
      }
    }
    return result;
  }
  return false;
}
