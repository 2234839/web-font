import { jsonResponse } from "../shared";
import { readdir } from "../interface";
import { fontDirs } from "../config";

/** GET /api/fonts — 列出所有可用字体 */
export async function handleListFonts(req: Request, _res: Response) {
  const allFonts: Array<{ name: string; temporary: boolean }> = [];

  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(entry.name)) {
          allFonts.push({ name: entry.name, temporary: dir === "font/temp" });
        }
      }
    } catch {}
  }

  return { req, res: jsonResponse(allFonts) };
}
