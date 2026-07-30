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
   * 全局并发请求池
   *
   * 字体 @font-face 注入 DOM 后浏览器立即发起请求。
   * 页面同时加载多种字体（如列表页预览）时，短时间内大量请求打满服务端子集化队列。
   * 通过排队控制同时挂载的 @font-face 数量，避免服务端过载。
   *
   * 默认 4：在浏览器同域 6 并发限制内留出余量给其他资源。
   * 用户可通过 WebFont.setMaxConcurrent(n) 调整。
   */
  var maxConcurrent = 4;
  /** 当前正在执行的字体加载任务数 */
  var activeFontLoads = 0;
  /** 待执行的字体加载任务队列（FIFO） */
  var fontLoadQueue = [];

  /**
   * 设置最大并发请求数
   *
   * @param {number} n - 并发数，最小 1
   */
  function setMaxConcurrent(n) {
    maxConcurrent = Math.max(1, n | 0);
  }

  /**
   * 通过并发池执行字体加载
   *
   * @param {function} fn - 实际执行 loadChars 的函数
   */
  function enqueueFontLoad(fn) {
    if (activeFontLoads < maxConcurrent) {
      activeFontLoads++;
      fn(doneFontLoad);
    } else {
      fontLoadQueue.push(fn);
    }
  }

  /** 一个加载完成，唤醒队列中下一个 */
  function doneFontLoad() {
    activeFontLoads--;
    if (fontLoadQueue.length > 0 && activeFontLoads < maxConcurrent) {
      var next = fontLoadQueue.shift();
      activeFontLoads++;
      next(doneFontLoad);
    }
  }

  /**
   * 生成 fontKey，同一字体+family 归入同一组
   */
  function fontKey(fontName, family) {
    return fontName + "|" + family;
  }

  /**
   * 记录已注入 preconnect 的 origin，避免重复注入
   *
   * 跨域字体请求首次握手要付出 ~60ms（TCP+TLS）。
   * preconnect 让浏览器在首个字体请求发出前就提前完成握手，
   * 把首个增量片段的延迟从 ~90ms 降到 ~30ms（只剩 1 个 RTT + 服务端处理）。
   * 同源时 location.origin === baseUrl，无需 preconnect。
   */
  var preconnectedOrigins = {};

  /**
   * 对跨域 baseUrl 注入 <link rel="preconnect">，提前建立 TCP+TLS 连接
   *
   * 仅在跨域且尚未注入时执行一次。浏览器会自行管理连接的生命周期，
   * 即便字体请求迟迟不来，preconnect 的开销也极小（空闲握手）。
   */
  function ensurePreconnect(baseUrl) {
    var origin;
    try {
      origin = new URL(baseUrl, location.href).origin;
    } catch (e) {
      return;
    }
    if (origin === location.origin) return;
    if (preconnectedOrigins[origin]) return;
    preconnectedOrigins[origin] = true;

    var link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    /** crossorigin 必需：字体资源默认匿名请求，preconnect 需匹配否则连接无法复用 */
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  /**
   * 获取或创建对应 fontKey 的加载器
   */
  function getLoader(fontName, baseUrl, family, outType) {
    var key = fontKey(fontName, family);
    if (!loaders[key]) {
      ensurePreconnect(baseUrl);
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
   *
   * 通过并发队列控制：同时挂载的 @font-face 不超过 maxConcurrent，
   * 避免页面同时加载大量字体时打满服务端子集化队列。
   * @param {Object} loader - getLoader 返回的加载器对象
   * @param {string[]} newChars - 待加载的新字符数组
   */
  function loadChars(loader, newChars) {
    if (newChars.length === 0) return;

    enqueueFontLoad(function (done) {
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

      /**
       * 释放并发槽位的策略：
       *
       * 优先用 FontFaceSet API 精确追踪字体加载完成；
       * 不可用时退化为 setTimeout（3 秒兜底窗口，覆盖绝大多数裁剪+传输时间）。
       */
      if (document.fonts && document.fonts.load) {
        document.fonts.load(outType === "woff2" ? "16px \"" + family + "\"" : "16px \"" + family + "\"").then(done, function () { done(); });
      } else {
        setTimeout(done, 3000);
      }
    });
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
      /** 同时收集 value 和 placeholder，确保占位文本的字体也被加载 */
      var val = el.value || "";
      var ph = el.placeholder || "";
      return val + ph;
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

    var disposed = false;

    return {
      update: function (text) {
        if (disposed) return;
        processText(loader, text);
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        /** 移除该 loader 注入的所有 @font-face 样式，避免同名 family 的 CSS 优先级冲突 */
        destroyLoader(fontKey(fontName, family));
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
    disposeAll: disposeAll,
    /** 设置客户端最大并发字体请求数（默认 4） */
    setMaxConcurrent: setMaxConcurrent
  };
})();
