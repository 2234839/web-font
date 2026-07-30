<script setup lang="ts">
/**
 * 轻量代码块组件
 *
 * 内置简单语法高亮（0 依赖），通过分词器把源码拆成 token 数组，
 * 每个 token 渲染为带颜色的 <span>，避免正则反复替换导致互相干扰。
 *
 * 支持 CSS / HTML / JS 三种语言的关键词着色。
 */
import { computed } from "vue";

const props = withDefaults(defineProps<{
  code: string;
  lang?: "css" | "html" | "js" | "auto";
}>(), {
  lang: "auto",
});

/** token 类型 → 颜色 */
const COLORS: Record<string, string> = {
  comment: "#999",
  tag: "#e45649",
  attr: "#4078f2",
  string: "#50a14f",
  keyword: "#a626a4",
  property: "#4078f2",
  number: "#c18401",
  function: "#4078f2",
  atrule: "#a626a4",
  plain: "#333",
};

interface Token {
  type: keyof typeof COLORS;
  value: string;
}

/**
 * CSS 分词器
 *
 * 状态机：逐字符扫描，区分注释 / 字符串 / @规则 / 属性名 / 属性值 / 选择器
 */
function tokenizeCss(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    /** 注释 /* ... *\/ */
    if (code[i] === "/" && code[i + 1] === "*") {
      let j = i + 2;
      while (j < len && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(j + 2, len);
      tokens.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** 字符串 "..." 或 '...' */
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      let j = i + 1;
      while (j < len && code[j] !== quote) j++;
      j = Math.min(j + 1, len);
      tokens.push({ type: "string", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** @规则 */
    if (code[i] === "@") {
      let j = i + 1;
      while (j < len && /[\w-]/.test(code[j])) j++;
      tokens.push({ type: "atrule", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** 属性名: （行首缩进后，单词+冒号） */
    const propMatch = /^(\s*)([\w-]+)(\s*:)/.exec(code.slice(i));
    if (propMatch && (i === 0 || code[i - 1] === "\n")) {
      if (propMatch[1]) tokens.push({ type: "plain", value: propMatch[1] });
      tokens.push({ type: "property", value: propMatch[2] });
      tokens.push({ type: "plain", value: propMatch[3] });
      i += propMatch[0].length;
      continue;
    }
    /** url( 等函数 */
    const funcMatch = /^([\w-]+)\s*\(/.exec(code.slice(i));
    if (funcMatch) {
      tokens.push({ type: "function", value: funcMatch[1] });
      i += funcMatch[1].length;
      continue;
    }
    /** 数字+单位 */
    const numMatch = /^(\d+(\.\d+)?)(px|em|rem|%|s|ms|pt|deg|vh|vw)?/.exec(code.slice(i));
    if (numMatch && numMatch[1] && /^\d/.test(numMatch[0])) {
      tokens.push({ type: "number", value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }
    /** 其他字符原样输出 */
    tokens.push({ type: "plain", value: code[i] });
    i++;
  }
  return tokens;
}

/**
 * HTML 分词器
 *
 * 状态机：区分文本 / 标签 / 属性 / 字符串 / 注释
 */
function tokenizeHtml(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    /** 注释 <!-- ... --> */
    if (code.slice(i, i + 4) === "<!--") {
      let j = code.indexOf("-->", i);
      j = j === -1 ? len : j + 3;
      tokens.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** 标签区域 <tag ...> 或 </tag> */
    if (code[i] === "<") {
      let j = i + 1;
      /** 闭合标签的 / */
      const closing = code[j] === "/";
      if (closing) j++;
      /** 标签名 */
      let tagName = "";
      while (j < len && /[\w-]/.test(code[j])) {
        tagName += code[j];
        j++;
      }
      if (tagName) {
        tokens.push({ type: "plain", value: "<" + (closing ? "/" : "") });
        tokens.push({ type: "tag", value: tagName });
        i = j;
        /** 扫描属性直到 > */
        while (i < len && code[i] !== ">") {
          /** 属性间的空白 */
          const ws = /^\s+/.exec(code.slice(i));
          if (ws) {
            tokens.push({ type: "plain", value: ws[0] });
            i += ws[0].length;
            continue;
          }
          /** 属性名 */
          const attrMatch = /^([\w-]+)/.exec(code.slice(i));
          if (attrMatch && code[i] !== '"' && code[i] !== "'") {
            tokens.push({ type: "attr", value: attrMatch[1] });
            i += attrMatch[1].length;
            continue;
          }
          /** 字符串值="..." */
          if (code[i] === "=") {
            tokens.push({ type: "plain", value: "=" });
            i++;
            continue;
          }
          if (code[i] === '"' || code[i] === "'") {
            const quote = code[i];
            let k = i + 1;
            while (k < len && code[k] !== quote) k++;
            k = Math.min(k + 1, len);
            tokens.push({ type: "string", value: code.slice(i, k) });
            i = k;
            continue;
          }
          /** 其他字符 */
          tokens.push({ type: "plain", value: code[i] });
          i++;
        }
        /** 闭合 > 或 /> */
        if (i < len && code[i] === ">") {
          const selfClose = code[i - 1] === "/";
          if (selfClose) {
            /** 把上一个 / 改为 plain */
            tokens.push({ type: "plain", value: ">" });
          } else {
            tokens.push({ type: "plain", value: ">" });
          }
          i++;
        }
        continue;
      }
    }
    /** 普通文本（到下一个 < 为止） */
    let j = code.indexOf("<", i);
    if (j === -1) j = len;
    tokens.push({ type: "plain", value: code.slice(i, j) });
    i = j;
  }
  return tokens;
}

/**
 * JS 分词器
 */
const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "new", "if", "else",
  "for", "while", "true", "false", "null", "undefined", "async", "await",
  "import", "export", "from", "default", "class", "extends", "this",
  "typeof", "instanceof", "try", "catch", "throw", "break", "continue",
]);

function tokenizeJs(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    /** 注释 // ... */
    if (code[i] === "/" && code[i + 1] === "/") {
      let j = code.indexOf("\n", i);
      j = j === -1 ? len : j;
      tokens.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** 注释 /* ... *\/ */
    if (code[i] === "/" && code[i + 1] === "*") {
      let j = i + 2;
      while (j < len && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(j + 2, len);
      tokens.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** 字符串 */
    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const quote = code[i];
      let j = i + 1;
      while (j < len && code[j] !== quote) {
        if (code[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, len);
      tokens.push({ type: "string", value: code.slice(i, j) });
      i = j;
      continue;
    }
    /** 标识符（关键词 / 函数名 / 普通变量） */
    const idMatch = /^[$\w]+/.exec(code.slice(i));
    if (idMatch) {
      const word = idMatch[0];
      if (JS_KEYWORDS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (code[i + word.length] === "(") {
        tokens.push({ type: "function", value: word });
      } else {
        tokens.push({ type: "plain", value: word });
      }
      i += word.length;
      continue;
    }
    /** 数字 */
    const numMatch = /^\d+(\.\d+)?/.exec(code.slice(i));
    if (numMatch) {
      tokens.push({ type: "number", value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }
    /** 其他字符 */
    tokens.push({ type: "plain", value: code[i] });
    i++;
  }
  return tokens;
}

/**
 * 自动检测语言
 */
function detectLang(code: string): "css" | "html" | "js" {
  if (/<\/?\w/.test(code)) return "html";
  if (/@font-face|@import|@media|^\s*[.#]?[\w-]+\s*\{/m.test(code)) return "css";
  if (/\b(function|const|let|var|=>|WebFont\.)\b/.test(code)) return "js";
  return "css";
}

/** HTML 转义 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 分词结果 */
const tokens = computed<Token[]>(() => {
  const lang = props.lang === "auto" ? detectLang(props.code) : props.lang;
  switch (lang) {
    case "css": return tokenizeCss(props.code);
    case "html": return tokenizeHtml(props.code);
    case "js": return tokenizeJs(props.code);
    default: return [{ type: "plain", value: props.code }];
  }
});
</script>

<template>
  <pre style="background: #f7f7f8; padding: 16px; border-radius: 6px; font-size: 13px; font-family: 'SF Mono', Menlo, Consolas, monospace; overflow: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; margin: 0"><code><span
    v-for="(token, idx) in tokens"
    :key="idx"
    :style="{ color: COLORS[token.type] }"
  >{{ token.value }}</span></code></pre>
</template>
