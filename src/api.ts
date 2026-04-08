export interface FontInfo {
  name: string;
  dir: string;
}

export interface ServerConfig {
  enableTempUpload: boolean;
  adminUploadEnabled: boolean;
}

export interface UploadResult {
  success: boolean;
  error?: string;
}

export async function fetchFonts(): Promise<FontInfo[]> {
  const res = await fetch("/api/fonts");
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
