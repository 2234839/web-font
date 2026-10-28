/**
 * @file ttf `name`编码表
 * @author mengke01(kekee000@gmail.com)
 */

/** nameId 到名称的基础映射，并附带 names 反转映射 */
const nameId: Record<number, string> & { names: Record<string, number> } = {
  0: 'copyright',
  1: 'fontFamily',
  2: 'fontSubFamily',
  3: 'uniqueSubFamily',
  4: 'fullName',
  5: 'version',
  6: 'postScriptName',
  7: 'tradeMark',
  8: 'manufacturer',
  9: 'designer',
  10: 'description',
  11: 'urlOfFontVendor',
  12: 'urlOfFontDesigner',
  13: 'licence',
  14: 'urlOfLicence',
  16: 'preferredFamily',
  17: 'preferredSubFamily',
  18: 'compatibleFull',
  19: 'sampleText',
  names: {},
};

// 反转names
const nameIdHash: Record<string, number> = {};
Object.keys(nameId).forEach(function (id) {
  if (id !== 'names') {
    nameIdHash[nameId[+id]] = +id;
  }
});
nameId.names = nameIdHash;

export default nameId;
