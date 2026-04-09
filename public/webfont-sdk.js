/**
 * WebFont SDK — 按需增量加载字体片段，无闪烁
 *
 * 架构：核心增量引擎 + 多种触发方式
 *   - 核心：FontLoader 按 fontKey 管理已加载字符集，只生成增量 CSS
 *   - 触发器：loadFont（轮询）、observeFont（DOM 事件）、loadText（手动传文本）
 *   - 同一 fontKey 下所有触发器共享字符集，绝不会重复请求
 *
 * 用法：
 *   // 轮询模式
 *   WebFont.loadFont({ fontName, selector, family, interval });
 *
 *   // 事件驱动模式
 *   var obs = WebFont.observeFont({ fontName, selector, family });
 *   obs.dispose();
 *
 *   // 直接传文本模式
 *   var loader = WebFont.loadText({ fontName, text: "你好世界", family });
 *   loader.update("追加文字");
 *   loader.dispose();
 *
 *   // 清理全部
 *   WebFont.disposeAll();
 */
var WebFont = (function () {
  /* ============================================================
   * 核心增量引擎 — 按 fontKey 管理已加载字符集，生成增量 CSS
   * ============================================================ */

  /** @type {Object.<string, { loadedChars: Object.<string,boolean>, injectedStyles: Element[], applied: boolean, fontName: string, family: string, baseUrl: string }>} */
  var loaders = {};

  /**
   * 生成 fontKey，同一字体+family 归入同一组
   */
  function fontKey(fontName, family) {
    return fontName + "|" + family;
  }

  /**
   * 获取或创建对应 fontKey 的加载器
   */
  function getLoader(fontName, baseUrl, family, outType) {
    var key = fontKey(fontName, family);
    if (!loaders[key]) {
      loaders[key] = {
        loadedChars: {},
        injectedStyles: [],
        applied: false,
        fontName: fontName,
        family: family,
        baseUrl: baseUrl,
        outType: outType || "woff2"
      };
    }
    return loaders[key];
  }

  /**
   * 差量加载新字符，生成 unicode-range CSS 并注入
   * @param {Object} loader - getLoader 返回的加载器对象
   * @param {string[]} newChars - 待加载的新字符数组
   */
  function loadChars(loader, newChars) {
    if (newChars.length === 0) return;

    var fontName = loader.fontName;
    var family = loader.family;
    var baseUrl = loader.baseUrl;
    var loadedChars = loader.loadedChars;

    var text = newChars.join("");
    var outType = loader.outType || "woff2";
    var url = baseUrl + "/api?font=" + encodeURIComponent(fontName) + "&text=" + encodeURIComponent(text) + "&outType=" + outType;
    var formatStr = outType === "woff2" ? "woff2" : "truetype";
    var unicodeRanges = newChars
      .map(function (c) { return "U+" + c.codePointAt(0).toString(16).padStart(4, "0"); })
      .join(", ");

    var style = document.createElement("style");
    style.textContent =
      '@font-face {\n' +
      '  font-family: "' + family + '";\n' +
      '  src: url("' + url + '") format("' + formatStr + '");\n' +
      '  unicode-range: ' + unicodeRanges + ';\n' +
      '}\n';
    document.head.appendChild(style);
    loader.injectedStyles.push(style);
  }

  /**
   * 从字符集中过滤出未加载的新字符，标记为已加载，并生成 CSS
   * @param {Object} loader - getLoader 返回的加载器对象
   * @param {Object.<string,boolean>} charSet - 待检查的字符集
   * @returns {boolean} 是否有新字符被加载
   */
  function processChars(loader, charSet) {
    var loadedChars = loader.loadedChars;
    var newChars = [];
    for (var c in charSet) {
      if (!loadedChars[c]) {
        loadedChars[c] = true;
        newChars.push(c);
      }
    }
    loadChars(loader, newChars);
    return newChars.length > 0;
  }

  /**
   * 从字符串中过滤出未加载的新字符，标记为已加载，并生成 CSS
   * @param {Object} loader - getLoader 返回的加载器对象
   * @param {string} text - 待检查的文本
   * @returns {boolean} 是否有新字符被加载
   */
  function processText(loader, text) {
    var loadedChars = loader.loadedChars;
    var newChars = [];
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (!loadedChars[c]) {
        loadedChars[c] = true;
        newChars.push(c);
      }
    }
    loadChars(loader, newChars);
    return newChars.length > 0;
  }

  /**
   * 销毁加载器及其所有注入的样式
   */
  function destroyLoader(key) {
    var loader = loaders[key];
    if (!loader) return;
    for (var i = 0; i < loader.injectedStyles.length; i++) {
      loader.injectedStyles[i].remove();
    }
    delete loaders[key];
  }

  /* ============================================================
   * 辅助函数
   * ============================================================ */

  /**
   * 获取元素的文本内容
   */
  function getText(el) {
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return el.value || "";
    }
    return el.textContent || "";
  }

  /**
   * 收集选择器匹配元素中的所有字符
   */
  function collectChars(selector) {
    var charSet = {};
    var elements = document.querySelectorAll(selector);
    for (var i = 0; i < elements.length; i++) {
      var text = getText(elements[i]);
      for (var j = 0; j < text.length; j++) {
        charSet[text[j]] = true;
      }
    }
    return charSet;
  }

  /**
   * 应用字体到元素
   */
  function applyFamily(selector, family) {
    var elements = document.querySelectorAll(selector);
    for (var i = 0; i < elements.length; i++) {
      elements[i].style.fontFamily = '"' + family + '", sans-serif';
    }
  }

  /* ============================================================
   * 任务管理 — 各触发器的清理
   * ============================================================ */

  /** 按 selector 索引的 loadFont 任务 */
  var pollTasks = {};

  /** 按选择器索引的 observeFont 任务 */
  var observeTasks = {};

  /* ============================================================
   * 1. loadFont — 定时器轮询模式
   * ============================================================ */

  /**
   * @param {Object} options
   * @param {string} options.fontName
   * @param {string} options.selector
   * @param {string} [options.baseUrl]
   * @param {string} [options.family]
   * @param {number} [options.interval=1000] - 轮询间隔（ms）
   */
  function loadFont(options) {
    var selector = options.selector;
    var fontName = options.fontName;
    var baseUrl = options.baseUrl || location.origin;
    var family = options.family || fontName.replace(/\.[^.]+$/, "");
    var interval = options.interval || 1000;

    /* 清理同一选择器的旧任务 */
    if (pollTasks[selector]) {
      clearInterval(pollTasks[selector].timer);
    }

    var outType = options.outType || "woff2";
    var loader = getLoader(fontName, baseUrl, family, outType);
    var applied = false;

    function tick() {
      var current = collectChars(selector);
      if (processChars(loader, current) && !applied) {
        applied = true;
        applyFamily(selector, family);
      }
    }

    tick();
    var timer = setInterval(tick, interval);
    pollTasks[selector] = { timer: timer };
  }

  /* ============================================================
   * 2. observeFont — MutationObserver 事件驱动模式
   * ============================================================ */

  /**
   * @param {Object} options
   * @param {string} options.fontName
   * @param {string} options.selector
   * @param {string} [options.baseUrl]
   * @param {string} [options.family]
   * @param {number} [options.debounceMs=50] - 防抖间隔（ms）
   * @returns {{ dispose: function }}
   */
  function observeFont(options) {
    var selector = options.selector;
    var fontName = options.fontName;
    var baseUrl = options.baseUrl || location.origin;
    var family = options.family || fontName.replace(/\.[^.]+$/, "");
    var debounceMs = options.debounceMs || 50;

    /* 清理同一选择器的旧任务 */
    if (observeTasks[selector]) {
      observeTasks[selector].dispose();
    }

    var outType = options.outType || "woff2";
    var loader = getLoader(fontName, baseUrl, family, outType);
    var applied = false;
    var debounceTimer = null;

    function doLoad() {
      var current = collectChars(selector);
      if (processChars(loader, current) && !applied) {
        applied = true;
        applyFamily(selector, family);
      }
    }

    function debouncedLoad() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(doLoad, debounceMs);
    }

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].type === "childList" || mutations[i].type === "characterData") {
          debouncedLoad();
          return;
        }
      }
    });

    var inputHandler = function () { debouncedLoad(); };

    var elements = document.querySelectorAll(selector);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.addEventListener("input", inputHandler);
      }
    }

    doLoad();

    var disposed = false;

    var task = {
      dispose: function () {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        for (var j = 0; j < elements.length; j++) {
          var el2 = elements[j];
          if (el2.tagName === "INPUT" || el2.tagName === "TEXTAREA") {
            el2.removeEventListener("input", inputHandler);
          }
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        delete observeTasks[selector];
      }
    };

    observeTasks[selector] = task;
    return task;
  }

  /* ============================================================
   * 3. loadText — 直接传文本模式
   * ============================================================ */

  /**
   * @param {Object} options
   * @param {string} options.fontName
   * @param {string} options.text
   * @param {string} [options.baseUrl]
   * @param {string} [options.family]
   * @returns {{ update: function(string): void, dispose: function(): void }}
   */
  function loadText(options) {
    var fontName = options.fontName;
    var baseUrl = options.baseUrl || location.origin;
    var family = options.family || fontName.replace(/\.[^.]+$/, "");

    var outType = options.outType || "woff2";
    var loader = getLoader(fontName, baseUrl, family, outType);

    processText(loader, options.text);

    return {
      update: function (text) {
        processText(loader, text);
      },
      dispose: function () {
        /* loadText 不独占样式，样式由 loader 统一管理 */
      }
    };
  }

  /* ============================================================
   * 公共 API
   * ============================================================ */

  /**
   * 清理所有任务和加载器（页面卸载时调用）
   */
  function disposeAll() {
    for (var sel in pollTasks) {
      clearInterval(pollTasks[sel].timer);
    }
    for (var oid in observeTasks) {
      observeTasks[oid].dispose();
    }
    pollTasks = {};
    observeTasks = {};

    for (var key in loaders) {
      destroyLoader(key);
    }
  }

  return {
    loadFont: loadFont,
    observeFont: observeFont,
    loadText: loadText,
    disposeAll: disposeAll
  };
})();
