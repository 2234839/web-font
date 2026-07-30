import { ref } from "vue"

export type Locale = "zh" | "en"

/**
 * 检测浏览器语言偏好（仅客户端调用）
 *
 * SSG 构建在 Node 环境执行，没有 localStorage / navigator，
 * 在模块顶层调用会抛 ReferenceError 导致构建崩溃。
 * 因此 locale 初始值固定为 "zh"，客户端在 onMounted 中调用
 * syncLocaleFromStorage() 按用户存储/浏览器语言修正。
 */
function detectLocale(): Locale {
  const saved = localStorage.getItem("webfont-locale") as Locale | null
  if (saved === "zh" || saved === "en") return saved
  const lang = navigator.language.toLowerCase()
  return lang.startsWith("zh") ? "zh" : "en"
}

/** 当前语言（SSG 构建期固定 "zh"，客户端挂载后由 syncLocaleFromStorage 修正） */
export const locale = ref<Locale>("zh")

/**
 * 客户端挂载后同步语言偏好
 *
 * 在页面组件的 onMounted 里调用，从 localStorage / navigator 浏览器偏好
 * 修正 locale，避免 SSG 预渲染阶段访问浏览器 API。
 */
export function syncLocaleFromStorage() {
  locale.value = detectLocale()
}

/** 切换语言 */
export function toggleLocale() {
  locale.value = locale.value === "zh" ? "en" : "zh"
  localStorage.setItem("webfont-locale", locale.value)
}

const messages = {
  zh: {
    // App.vue
    slogan: "如清风似闪电，超级快的字体子集化裁剪",
    inputLabel: "输入文本预览效果",
    inputPlaceholder: "在此输入文本...",
    cssLabel: "CSS 代码",
    downloadFont: "下载字体",
    copyCss: "复制 CSS",
    copied: "已复制",
    copyFailed: "复制失败",
    principle: "原理：",
    principleText: "服务端根据 text 参数裁剪字体，只返回所需字符的子集。相同 URL 的请求会被浏览器自动缓存。",
    basicUsage: "基础用法：",
    basicUsageText: "将 CSS 复制到你的页面，修改 text 参数中的文字即可：",
    jsSdk: "JS SDK（推荐）：",
    jsSdkText: "增量加载字体片段，按需请求，不会出现全量字体闪烁。",
    downloadSdk: "下载 SDK",
    sdkModes: "还支持",
    observeFont: "（MutationObserver 事件驱动）和",
    loadText: "（手动传文本）两种方式，多种方式可同时使用，SDK 内部自动按字体去重增量加载。",
    thanks: "感谢",
    thanksText: "收录本项目",
    buyCoffee: "觉得好用？",
    buyCoffeeAction: "请作者喝杯咖啡",
    buyCoffeeSuffix: "，支持持续开发",
    viewSkill: "查看 AI Chinese Font Skill →",
    sponsor: "赞助支持",
    agentSkillDemo: "Agent Skill Demo",

    // FontSelector.vue
    selectFont: "选择字体",
    pleaseSelect: "-- 请选择 --",
    /** 搜索框占位提示 */
    searchFontPlaceholder: "搜索字体（支持拼音）...",
    /** 无搜索结果提示 */
    noFontFound: "未找到匹配的字体",
    outputFormat: "输出格式",
    woff2Label: "WOFF2 体积更小",
    ttfLabel: "TTF 速度更快",
    woff2Desc: "约压缩 50%，适合生产",
    ttfDesc: "无编码开销，适合开发",

    // UploadSection.vue
    uploadTip: "支持 .ttf 和 .otf 格式，建议上传 .ttf 字体文件以获得最佳兼容性",
    uploadFont: "上传字体",
    guestUpload: "游客上传",
    guestUploadDesc: "临时文件，最多保留 10 个，总大小限制 200MB，超出后自动删除最早上传的",
    adminUpload: "管理员上传",
    adminUploadDesc: "永久保存，需要 API Key 认证",
    selectFile: "选择文件",
    noFile: "未选择文件",
    upload: "上传",
    uploadSuccess: "上传成功",
    uploadFailed: "上传失败",

    // StatsPanel.vue
    serverStatus: "服务状态",
    uptime: "运行",
    requests: "请求",
    times: "次",
    subset: "裁剪",
    chars: "文字",
    charUnit: "字",
    cacheHit: "缓存命中",

    // TypographyDemo.vue
    demoSlogan: "字体不同，体验天壤之别",
    viewSkillLink: "查看 Skill →",
    back: "← 返回",
    beforeLabel: "Before: 默认字体",
    afterLabel: "After: AI 使用 Skill 后可调用特殊字体",
  },
  en: {
    // App.vue
    slogan: "Lightning-fast Chinese font subsetting",
    inputLabel: "Preview with your text",
    inputPlaceholder: "Type text here...",
    cssLabel: "CSS Code",
    downloadFont: "Download",
    copyCss: "Copy CSS",
    copied: "Copied!",
    copyFailed: "Failed",
    principle: "How it works: ",
    principleText: "The server subsets fonts based on the text parameter, returning only the glyphs needed. Identical URLs are cached by the browser.",
    basicUsage: "Basic usage: ",
    basicUsageText: "Copy the CSS to your page and modify the text parameter:",
    jsSdk: "JS SDK (Recommended): ",
    jsSdkText: "Incremental font loading, on-demand requests, no full-font flicker.",
    downloadSdk: "Download SDK",
    sdkModes: "Also supports ",
    observeFont: " (MutationObserver-driven) and ",
    loadText: " (manual text). Multiple modes can be used simultaneously with automatic deduplication.",
    thanks: "Thanks to ",
    thanksText: " for featuring this project",
    buyCoffee: "Find it useful? ",
    buyCoffeeAction: "Buy the author a coffee",
    buyCoffeeSuffix: " to support development",
    viewSkill: "View AI Chinese Font Skill →",
    sponsor: "Sponsor",
    agentSkillDemo: "Agent Skill Demo",

    // FontSelector.vue
    selectFont: "Select font",
    pleaseSelect: "-- Select --",
    /** Search placeholder */
    searchFontPlaceholder: "Search font (pinyin supported)...",
    /** No search results */
    noFontFound: "No matching font found",
    outputFormat: "Format",
    woff2Label: "WOFF2 Smaller",
    ttfLabel: "TTF Faster",
    woff2Desc: "~50% smaller, for production",
    ttfDesc: "No encoding overhead, for dev",

    // UploadSection.vue
    uploadTip: "Supports .ttf and .otf. .ttf recommended for best compatibility",
    uploadFont: "Upload Font",
    guestUpload: "Guest Upload",
    guestUploadDesc: "Temporary files, max 10 files, 200MB total. Oldest deleted when full.",
    adminUpload: "Admin Upload",
    adminUploadDesc: "Permanent storage, requires API Key",
    selectFile: "Choose file",
    noFile: "No file selected",
    upload: "Upload",
    uploadSuccess: "Upload successful",
    uploadFailed: "Upload failed",

    // StatsPanel.vue
    serverStatus: "Server Status",
    uptime: "Uptime",
    requests: "Requests",
    times: "",
    subset: "Subset",
    chars: "Chars",
    charUnit: "chars",
    cacheHit: "Cache Hit",

    // TypographyDemo.vue
    demoSlogan: "Same content, different fonts, completely different feel",
    viewSkillLink: "View Skill →",
    back: "← Back",
    beforeLabel: "Before: Default Font",
    afterLabel: "After: AI with Skill can use custom fonts",
  },
} as const

export type MessageKey = keyof typeof messages.zh

/** 翻译函数 */
export function t(key: MessageKey): string {
  return messages[locale.value][key] ?? key
}
