export interface FontInfo {
  name: string;
  dir?: string;
  /** 是否为临时上传的字体 */
  temporary?: boolean;
}

export interface ServerConfig {
  enableTempUpload: boolean;
  adminUploadEnabled: boolean;
  supportedOutTypes: ("woff2" | "ttf")[];
  /** 临时字体保留时限（秒） */
  tempRetentionSeconds?: number;
  /** 字体子集化最大并发数 */
  subsetConcurrency?: number;
  /** 队列等待超时（秒） */
  subsetQueueTimeoutSeconds?: number;
}

export interface UploadResult {
  success: boolean;
  error?: string;
}

export interface ServerStats {
  uptime: number;
  totalRequests: number;
  subsetRequests: number;
  subsetCacheHits: number;
  totalChars: number;
  subsetCacheEntries: number;
  fontBufferCacheEntries: number;
  /** 临时文件上传次数 */
  tempUploads?: number;
  /** 离线裁剪完成次数 */
  offlineSubsets?: number;
  /** 离线裁剪字体下载次数 */
  offlineDownloads?: number;
}

/** 字符集覆盖率 */
export interface CharsetCoverage {
  /** 字符集标识，如 "ascii"、"cjkBasic" */
  key: string;
  name: string;
  total: number;
  covered: number;
  percent: number;
}

/** 字体基本信息（来自 OpenType name 表） */
export interface FontInfo {
  copyright?: string;
  family?: string;
  subfamily?: string;
  uniqueId?: string;
  fullName?: string;
  version?: string;
  postScript?: string;
  trademark?: string;
  manufacturer?: string;
  designer?: string;
  description?: string;
  vendorUrl?: string;
  designerUrl?: string;
  license?: string;
  licenseUrl?: string;
}

/** 人工配置项（来自 font-config.json，由用户维护） */
export interface FontUserConfig {
  /** 显示名称（优先于文件名） */
  displayName?: string;
  /** 描述/简介 */
  description?: string;
  /** 标签列表 */
  tags?: string[];
  /** 开源仓库地址（如 GitHub URL） */
  homepage?: string;
  /** 默认预览文字 */
  previewText?: string;
  /** 详情页正文标题 */
  bodyTitle?: string;
  /** 详情页正文段落 */
  bodyText?: string;
  /** 详情页字符预览行 */
  charsetPreview?: string;
}

/** 字体元数据 */
export interface FontMeta {
  totalCodePoints: number;
  coverage: CharsetCoverage[];
  ranges: Array<[number, number]>;
  /** 字体基本信息（版权、作者等） */
  info: FontInfo;
  /** 人工配置（来自 font-config.json） */
  config?: FontUserConfig;
}

export async function fetchFonts(): Promise<FontInfo[]> {
  const res = await fetch("/api/fonts");
  return res.json();
}

export async function fetchFontMeta(fontName: string): Promise<FontMeta> {
  const res = await fetch(`/api/font-meta?font=${encodeURIComponent(fontName)}`);
  return res.json();
}

export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch("/api/config");
  return res.json();
}

export async function uploadFont(
  file: File,
  mode: "temp" | "admin",
  apiKey?: string,
): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("font", file);

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`/api/upload?mode=${mode}`, {
    method: "POST",
    body: formData,
    headers,
  });
  return res.json();
}

export async function fetchStats(): Promise<ServerStats> {
  const res = await fetch("/api/stats");
  return res.json();
}

/**
 * 离线裁剪匿名事件上报
 *
 * 只发送事件类型（裁剪完成 / 下载），不包含字体、文字等任何内容数据。
 * 用 sendBeacon 优先（页面卸载时也能送达），失败静默——统计不干扰主流程。
 */
export function reportOfflineEvent(event: "offline_subset" | "offline_download"): void {
  const body = JSON.stringify({ event });
  if (navigator.sendBeacon?.("/api/stats/event", new Blob([body], { type: "application/json" }))) return;
  fetch("/api/stats/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}
