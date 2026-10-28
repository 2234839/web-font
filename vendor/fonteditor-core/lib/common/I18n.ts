/**
 * @file 用于国际化的字符串管理类
 * @author mengke01(kekee000@gmail.com)
 */

/** 语言字符串表 */
type LangObject = Record<string, any>;

/** 语言列表条目：[语言名称, 语言字符串表] */
type LanguageEntry = [string, LangObject];

/** 语言名称 → 语言字符串表 的仓库 */
type LangStore = Record<string, LangObject>;

/**
 * 合并语言列表到仓库
 */
function appendLanguage(store: LangStore, languageList: LanguageEntry[]): LangStore {
  languageList.forEach(function (item) {
    const language = item[0];
    store[language] = Object.assign(store[language] || {}, item[1]);
  });
  return store;
}

/**
 * 管理国际化字符，根据lang切换语言版本
 *
 * languageList = [
 *     'en-us', // 语言名称
 *     langObject // 语言字符串列表
 * ]
 */
class I18n {
  /** 语言字符串仓库 */
  store: LangStore;
  /** 当前语言字符串表 */
  lang: LangObject;
  /** 当前语言名称 */
  language: string;

  /**
   * 构造实例并设置默认语言
   */
  constructor(languageList: LanguageEntry[], defaultLanguage?: string) {
    this.store = appendLanguage({}, languageList);
    let language =
      defaultLanguage ||
      (typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase()) ||
      'en-us';
    if (!this.store[language]) {
      language = 'en-us';
    }
    this.language = language;
    this.lang = this.store[language];
  }

  /**
   * 设置语言，语言不存在时回退到 en-us
   */
  setLanguage(language: string): this {
    if (!this.store[language]) {
      language = 'en-us';
    }
    this.language = language;
    this.lang = this.store[language];
    return this;
  }

  /**
   * 添加一个语言字符串
   */
  addLanguage(language: string, langObject: LangObject): this {
    appendLanguage(this.store, [[language, langObject]]);
    return this;
  }

  /**
   * 获取当前语言字符串（按 `.` 分隔的路径取值，取不到返回空字符串）
   */
  get(path: string): any {
    const ref = path.split('.');
    let refObject: any = this.lang;
    let level: string | undefined;
    while (refObject != null && (level = ref.shift())) {
      refObject = refObject[level];
    }
    return refObject != null ? refObject : '';
  }
}

export default I18n;
