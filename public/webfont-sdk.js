/**
 * WebFont SDK — 按需增量加载字体片段，无闪烁
 * 用法：WebFont.loadFont({ fontName, selector, baseUrl, family })
 */
var WebFont = (function () {
  /** 按 selector 索引的活跃任务，重复调用同一选择器时自动清理旧任务 */
  var tasks = {};

  /**
   * @param {Object} options
   * @param {string} options.fontName - 字体文件名（如 "思源黑体.ttf"）
   * @param {string} options.selector - CSS 选择器（如 ".title"）
   * @param {string} [options.baseUrl] - API 基础地址，默认当前域名
   * @param {string} [options.family] - font-family 名称，默认 fontName 去掉扩展名
   */
  function loadFont(options) {
    var selector = options.selector;
    var fontName = options.fontName;
    var baseUrl = options.baseUrl || location.origin;
    var family = options.family || fontName.replace(/\.[^.]+$/, "");

    /** 清理同一选择器的旧任务 */
    if (tasks[selector]) {
      clearInterval(tasks[selector].timer);
      /** 移除旧任务注入的 style 标签 */
      var oldStyles = tasks[selector].styles;
      for (var s = 0; s < oldStyles.length; s++) {
        oldStyles[s].remove();
      }
    }

    var loadedChars = {};
    var injectedStyles = [];
    var applied = false;

    /** 获取元素的文本内容 */
    function getText(el) {
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return el.value || "";
      }
      return el.textContent || "";
    }

    function collectChars() {
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

    function loadNewChars() {
      var current = collectChars();
      var newChars = [];
      for (var c in current) {
        if (!loadedChars[c]) {
          newChars.push(c);
        }
      }
      if (newChars.length === 0) return;

      for (var k = 0; k < newChars.length; k++) {
        loadedChars[newChars[k]] = true;
      }

      var text = newChars.join("");
      var url = baseUrl + "/api?font=" + encodeURIComponent(fontName) + "&text=" + encodeURIComponent(text);
      var unicodeRanges = newChars
        .map(function (c) { return "U+" + c.codePointAt(0).toString(16).padStart(4, "0"); })
        .join(", ");

      var style = document.createElement("style");
      style.textContent =
        '@font-face {\n' +
        '  font-family: "' + family + '";\n' +
        '  src: url("' + url + '") format("truetype");\n' +
        '  unicode-range: ' + unicodeRanges + ';\n' +
        '}\n';
      document.head.appendChild(style);
      injectedStyles.push(style);

      if (!applied) {
        applied = true;
        var elements = document.querySelectorAll(selector);
        for (var i = 0; i < elements.length; i++) {
          elements[i].style.fontFamily = '"' + family + '", sans-serif';
        }
      }
    }

    loadNewChars();
    var timer = setInterval(loadNewChars, 1000);

    tasks[selector] = { timer: timer, styles: injectedStyles };
  }

  return { loadFont: loadFont };
})();
