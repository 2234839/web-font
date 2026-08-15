/**
 * 主站 API 适配层 —— 基于官方 SDK 客户端（webfont-sdk/api）的薄封装
 *
 * 所有类型与请求逻辑统一走 webfont-sdk：接口变更只改 SDK 一处，
 * 主站（dogfooding）、leafer 插件 demo、npm 用户共享同一实现。
 *
 * 保留原有的函数签名与旧类型别名（FontInfo / FontMeta / ...），
 * 组件层零改动即可切换；新代码建议直接 import SDK 类型。
 *
 * baseUrl 说明：主站与后端同源（dev 走 vite proxy /api → 8087），
 * 传空串 baseUrl 后客户端拼出相对路径 "/api/..."，同源与代理都正确。
 */
import {
  createWebFontApi,
  type IApiFontInfo,
  type IApiFontMeta,
  type IApiServerConfig,
  type IApiServerStats,
  type IApiUploadResult,
} from "webfont-sdk/api";

const api = createWebFontApi({ baseUrl: "" });

/** 字体列表项（旧名兼容；新代码用 IApiFontInfo） */
export type FontInfo = IApiFontInfo & {
  /** 旧字段（后端实际不返回，恒 undefined），dev 预览页模板引用，保留可选 */
  dir?: string;
};

/** 字体元数据（旧名兼容；新代码用 IApiFontMeta） */
export type FontMeta = IApiFontMeta;

/** 服务公开配置（旧名兼容；新代码用 IApiServerConfig） */
export type ServerConfig = IApiServerConfig;

/** 上传结果（旧名兼容；新代码用 IApiUploadResult） */
export type UploadResult = IApiUploadResult;

/** 运行统计（旧名兼容；新代码用 IApiServerStats） */
export type ServerStats = IApiServerStats;

export { type IApiCharsetCoverage as CharsetCoverage, type IApiFontUserConfig as FontUserConfig } from "webfont-sdk/api";

export async function fetchFonts(): Promise<FontInfo[]> {
  return api.fonts();
}

export async function fetchFontMeta(fontName: string): Promise<FontMeta> {
  return api.fontMeta(fontName);
}

export async function fetchConfig(): Promise<ServerConfig> {
  return api.config();
}

export async function fetchStats(): Promise<ServerStats> {
  return api.stats();
}

/**
 * 上传字体（临时 / 管理员）
 *
 * SDK 客户端用 FormData 上传，主站调用方传的是 File —— 直接透传，
 * FormData.append(name, File) 会自动带上 filename。
 */
export async function uploadFont(
  file: File,
  mode: "temp" | "admin",
  apiKey?: string,
): Promise<UploadResult> {
  return api.upload({ data: file, filename: file.name, mode, apiKey });
}

/**
 * 离线裁剪匿名事件上报 —— 透传 SDK 实现
 * （sendBeacon 优先，页面卸载也能送达；只发事件类型，无内容数据）
 */
export function reportOfflineEvent(event: "offline_subset" | "offline_download"): void {
  api.reportEvent(event);
}
