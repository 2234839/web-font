/**
 * 服务端 REST API 客户端 —— webfont 子集化服务公开接口的封装
 *
 * 与增量加载引擎（主入口 index.ts）完全独立，按需从子路径导入：
 *   import { createWebFontApi } from 'webfont-sdk/api'
 *
 * 覆盖的接口（与后端 routes 一一对应）：
 *   - GET  /api/fonts        → api.fonts()            字体列表
 *   - GET  /api/font-meta    → api.fontMeta(name)     字体元数据（覆盖率 / codepoint 区间 / name 表）
 *   - GET  /api/config       → api.config()           服务公开配置
 *   - GET  /api/stats        → api.stats()            运行统计
 *   - POST /api/upload       → api.upload({...})      上传字体（临时 / 管理员）
 *   - POST /api/stats/event  → api.reportEvent(...)   离线裁剪匿名事件上报
 */

/** 字体列表项（GET /api/fonts） */
export interface IApiFontInfo {
  /** 字体文件名（子集 API 查询用，如 '令东齐伋复刻体.ttf'） */
  name: string
  /** 是否为临时上传字体（到期自动清理，列表展示时可过滤） */
  temporary: boolean
}

/** 字符集覆盖率项（fontMeta 返回） */
export interface IApiCharsetCoverage {
  /** 字符集标识，如 'ascii'、'cjkBasic' */
  key: string
  /** 字符集名称（中文） */
  name: string
  /** 该字符集总字符数 */
  total: number
  /** 字体覆盖的字符数 */
  covered: number
  /** 覆盖率百分比（0~100，保留一位小数） */
  percent: number
}

/** OpenType name 表信息（版权 / 作者 / 许可等，fontMeta 返回） */
export interface IApiFontNameInfo {
  copyright?: string
  family?: string
  subfamily?: string
  uniqueId?: string
  fullName?: string
  version?: string
  postScript?: string
  trademark?: string
  manufacturer?: string
  designer?: string
  description?: string
  vendorUrl?: string
  designerUrl?: string
  license?: string
  licenseUrl?: string
}

/** 人工配置项（服务端 font-config.json，由站长维护，fontMeta 返回） */
export interface IApiFontUserConfig {
  /** 显示名称（优先于文件名） */
  displayName?: string
  /** 描述 / 简介 */
  description?: string
  /** 标签列表 */
  tags?: string[]
  /** 开源仓库地址 */
  homepage?: string
  /** 默认预览文字 */
  previewText?: string
  /** 详情页正文标题 */
  bodyTitle?: string
  /** 详情页正文段落 */
  bodyText?: string
  /** 详情页字符预览行 */
  charsetPreview?: string
}

/** 字体元数据（GET /api/font-meta） */
export interface IApiFontMeta {
  /** 元数据版本指纹（算法变更后 bump） */
  metaVersion: number
  /** 字体支持的 codepoint 总数 */
  totalCodePoints: number
  /** 各标准字符集覆盖率 */
  coverage: IApiCharsetCoverage[]
  /** 支持的 codepoint 区间（紧凑表示，如 [[0x20, 0x7e], [0x4e00, 0x9fff]]） */
  ranges: Array<[number, number]>
  /** name 表基本信息 */
  info: IApiFontNameInfo
  /** 人工配置（服务端配置了才有） */
  config?: IApiFontUserConfig
}

/** 服务公开配置（GET /api/config） */
export interface IApiServerConfig {
  /** 是否启用临时字体上传 */
  enableTempUpload: boolean
  /** 是否启用管理员上传（服务端配置了 API Key） */
  adminUploadEnabled: boolean
  /** 支持的子集输出格式 */
  supportedOutTypes: Array<'woff2' | 'ttf'>
  /** 临时字体保留时限（秒） */
  tempRetentionSeconds: number
  /** 字体子集化最大并发数 */
  subsetConcurrency: number
  /** 队列等待超时（秒） */
  subsetQueueTimeoutSeconds: number
}

/** 运行统计（GET /api/stats） */
export interface IApiServerStats {
  /** 服务运行秒数 */
  uptime: number
  /** 总请求数 */
  totalRequests: number
  /** 子集化请求数 */
  subsetRequests: number
  /** 子集缓存命中数 */
  subsetCacheHits: number
  /** 累计裁剪字符数 */
  totalChars: number
  /** 临时字体上传次数 */
  tempUploads: number
  /** 离线裁剪完成次数 */
  offlineSubsets: number
  /** 离线裁剪字体下载次数 */
  offlineDownloads: number
  /** 子集结果缓存条目数 */
  subsetCacheEntries: number
  /** 字体二进制缓存条目数 */
  fontBufferCacheEntries: number
}

/** 上传结果（POST /api/upload；失败是业务预期，不抛错由调用方判断 success） */
export interface IApiUploadResult {
  success: boolean
  error?: string
}

/** 客户端配置 */
export interface IWebFontApiOptions {
  /** 服务基地址，默认官方在线服务 */
  baseUrl?: string
  /** 自定义 fetch 实现（老版本 Node / 测试注入用，默认全局 fetch） */
  fetchImpl?: typeof fetch
}

/** 上传参数 */
export interface IApiUploadInput {
  /** 字体二进制内容 */
  data: Blob
  /** 保存到服务端的文件名（如 '我的字体.ttf'） */
  filename: string
  /** 上传模式：temp 临时字体（默认，到期自动清理）/ admin 管理员字体（需 apiKey） */
  mode?: 'temp' | 'admin'
  /** admin 模式的 API Key */
  apiKey?: string
}

/** API 客户端实例 */
export interface IWebFontApi {
  /** 字体列表 */
  fonts(): Promise<IApiFontInfo[]>
  /** 字体元数据（覆盖率 / codepoint 区间 / name 表 / 人工配置） */
  fontMeta(fontName: string): Promise<IApiFontMeta>
  /** 服务公开配置 */
  config(): Promise<IApiServerConfig>
  /** 运行统计 */
  stats(): Promise<IApiServerStats>
  /** 上传字体（失败返回 { success: false, error }，不抛错） */
  upload(input: IApiUploadInput): Promise<IApiUploadResult>
  /** 离线裁剪匿名事件上报（只发事件类型，不含任何内容数据；页面卸载也能送达） */
  reportEvent(event: 'offline_subset' | 'offline_download'): void
}

/**
 * 创建服务端 API 客户端
 *
 * GET 类接口对非 2xx 响应直接抛 Error（fail fast，错误信息含状态码与响应体）；
 * upload 例外——服务端用 4xx + { success: false, error } 表达业务失败，原样返回。
 */
export function createWebFontApi(options: IWebFontApiOptions = {}): IWebFontApi {
  /** 去掉末尾斜杠，避免拼出双斜杠 */
  const baseUrl = (options.baseUrl ?? 'https://webfont.shenzilong.cn').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetchImpl(baseUrl + path)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`webfont-sdk/api GET ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    return res.json() as Promise<T>
  }

  return {
    fonts: () => getJson<IApiFontInfo[]>('/api/fonts'),
    fontMeta: (fontName) => getJson<IApiFontMeta>(`/api/font-meta?font=${encodeURIComponent(fontName)}`),
    config: () => getJson<IApiServerConfig>('/api/config'),
    stats: () => getJson<IApiServerStats>('/api/stats'),

    upload: async ({ data, filename, mode = 'temp', apiKey }: IApiUploadInput) => {
      const form = new FormData()
      form.append('font', data, filename)
      /** 仅 admin 模式需要鉴权头 */
      const headers: Record<string, string> = {}
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const res = await fetchImpl(`${baseUrl}/api/upload?mode=${mode}`, {
        method: 'POST',
        body: form,
        headers,
      })
      return res.json() as Promise<IApiUploadResult>
    },

    reportEvent: (event) => {
      const body = JSON.stringify({ event })
      /** sendBeacon 优先：页面卸载时也能送达；失败静默降级 fetch keepalive——统计不干扰主流程 */
      const nav = (globalThis as { navigator?: Navigator }).navigator
      if (nav?.sendBeacon?.(`${baseUrl}/api/stats/event`, new Blob([body], { type: 'application/json' }))) return
      fetchImpl(`${baseUrl}/api/stats/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    },
  }
}
