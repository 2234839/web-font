import { clone } from "../common/lang";
import empty from "./data/empty";
import def from "./data/default";

/**
 * @file 获取空的ttf对象
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 获取空的ttf对象
 *
 * @return {Object} ttf对象
 */
export default function getEmpty() {
  const ttf = clone(empty);
  Object.assign(ttf.name, def.name);
  ttf.head.created = ttf.head.modified = Date.now();
  return ttf;
}
