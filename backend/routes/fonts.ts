import { jsonResponse, fontDirListing } from "../shared";

/** GET /api/fonts — 列出所有可用字体（走共享目录清单缓存） */
export async function handleListFonts(req: Request, _res: Response) {
  const entries = await fontDirListing();
  const allFonts = entries.map((e) => ({ name: e.name, temporary: e.dir === "font/temp" }));
  return { req, res: jsonResponse(allFonts) };
}
