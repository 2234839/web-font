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
  /** 子集化内存水位阈值（MB），RSS 超此值时排队 */
  subsetMemSoftLimitMB?: number;
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
