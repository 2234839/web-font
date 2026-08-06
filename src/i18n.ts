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
    /** 所有字体入口 */
    browseFonts: "所有字体",

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
    uploadWarning: "⚠ 切勿上传非商用授权或付费字体，本平台仅用于分享免费可商用字体",
    guestUpload: "游客上传",
    guestUploadDesc: "临时文件，最多保留 10 个，总大小限制 200MB，超时未使用将自动删除",
    adminUpload: "管理员上传",
    adminUploadDesc: "永久保存，需要 API Key 认证",
    selectFile: "选择文件",
    noFile: "未选择文件",
    upload: "上传",
    uploadSuccess: "上传成功",
    uploadFailed: "上传失败",
    /** 离线裁剪导航链接 */
    offlineSubsetLink: "🔒 离线裁剪（字体不上传服务器）",

    // StatsPanel.vue
    serverStatus: "服务状态",
    uptime: "运行",
    requests: "请求",
    times: "次",
    subset: "裁剪",
    chars: "文字",
    charUnit: "字",
    cacheHit: "缓存命中",
    offlineSubset: "离线裁剪",
    offlineDownload: "离线下载",

    // 企业服务板块
    enterpriseTitle: "企业技术支持与服务",
    enterpriseValue: "中文字体动辄 5～20MB，用户首屏要白等好几秒。裁剪后只剩页面实际用到的几十 KB，为你的业务带来实实在在的价值：",
    enterprisePoint1: "💰 省流量费：字体体积减少 95%+，高流量站点的 CDN / 带宽成本大幅下降",
    enterprisePoint2: "⚡ 首屏秒开：字体不再阻塞渲染，告别文字闪烁（FOIT/FOUT），移动端体验大幅提升",
    enterprisePoint3: "📈 提升转化：加载更快 → 跳出率更低 → 留存与转化随之提升",
    enterpriseDesc: "本项目免费开源，同时提供付费的企业级支持，助力你的业务稳定落地：",
    enterpriseItem1: "私有部署 / 企业内网部署与调优",
    enterpriseItem2: "字体子集化方案定制与授权合规咨询",
    enterpriseItem3: "SDK 集成、性能优化与故障排查技术支持",
    enterpriseItem4: "功能定制开发",
    enterpriseContact: "联系崮生洽谈",
    enterpriseEmailHint: "或发邮件至",

    // 文档页 / 首页文档入口
    docsTitle: "SDK 集成文档",
    docsSubtitle: "为你的网站接入中文字体按需加载",
    docsEntryTitle: "接入你的网站：",
    docsEntryText: "支持 @font-face 与 JS SDK 增量加载，只加载页面用到的字符。",
    docsEntryLink: "查看集成文档 →",
    inputHintIncremental: "输入即时触发增量加载，只裁剪用到的字符，非全量下载。",

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
    /** All fonts entry */
    browseFonts: "All Fonts",

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
    uploadWarning: "⚠ Do NOT upload non-commercial or paid fonts. This platform is for free commercial-use fonts only.",
    guestUpload: "Guest Upload",
    guestUploadDesc: "Temporary files, max 10 files, 200MB total. Auto-deleted if unused beyond retention period.",
    adminUpload: "Admin Upload",
    adminUploadDesc: "Permanent storage, requires API Key",
    selectFile: "Choose file",
    noFile: "No file selected",
    upload: "Upload",
    uploadSuccess: "Upload successful",
    uploadFailed: "Upload failed",
    /** 离线裁剪导航链接 */
    offlineSubsetLink: "🔒 Offline Subsetting (no upload)",

    // StatsPanel.vue
    serverStatus: "Server Status",
    uptime: "Uptime",
    requests: "Requests",
    times: "",
    subset: "Subset",
    chars: "Chars",
    charUnit: "chars",
    cacheHit: "Cache Hit",
    offlineSubset: "Offline Subset",
    offlineDownload: "Offline Download",

    // Enterprise services section
    enterpriseTitle: "Enterprise Support & Services",
    enterpriseValue: "Chinese fonts are often 5–20MB, forcing users to wait seconds on a blank first screen. After subsetting, only the tens of KB actually used remain — bringing real value to your business:",
    enterprisePoint1: "💰 Cut bandwidth costs: 95%+ smaller fonts dramatically reduce CDN / traffic bills for high-traffic sites",
    enterprisePoint2: "⚡ Instant first paint: fonts no longer block rendering — no FOIT/FOUT flash, far better mobile UX",
    enterprisePoint3: "📈 Boost conversion: faster load → lower bounce → higher retention & conversion",
    enterpriseDesc: "This project is free and open source. Paid enterprise-grade support is also available to help your business land smoothly:",
    enterpriseItem1: "Private / intranet deployment and tuning",
    enterpriseItem2: "Font subsetting solution customization & license compliance consulting",
    enterpriseItem3: "SDK integration, performance optimization & troubleshooting",
    enterpriseItem4: "Custom feature development",
    enterpriseContact: "Contact Gushsheng",
    enterpriseEmailHint: "or email",

    // Docs page / home docs entry
    docsTitle: "SDK Integration Docs",
    docsSubtitle: "Add on-demand Chinese font loading to your site",
    docsEntryTitle: "Integrate into your site: ",
    docsEntryText: "Supports @font-face and JS SDK incremental loading — only the characters used on the page are loaded.",
    docsEntryLink: "View integration docs →",
    inputHintIncremental: "Typing triggers incremental loading — only the characters used are subset, not the full font.",

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
