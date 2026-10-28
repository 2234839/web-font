import parseParams from "./parseParams";

/**
 * @file 解析transform参数
 * @author mengke01(kekee000@gmail.com)
 */

const TRANSFORM_REGEX = /(\w+)\s*\(([\d-.,\s]*)\)/g;

/**
 * 解析transform参数
 *
 * @param str 参数字符串
 * @return transform数组, 格式如下：
 *     [
 *         {
 *             name: 'scale',
 *             params: []
 *         }
 *     ]
 */
export default function parseTransform(str: string): any[] | false {
  if (!str) {
    return false;
  }
  TRANSFORM_REGEX.lastIndex = 0;
  const transforms: any[] = [];
  let match: RegExpExecArray | null;
  while ((match = TRANSFORM_REGEX.exec(str))) {
    transforms.push({
      name: match[1],
      params: parseParams(match[2])
    });
  }
  return transforms;
}
