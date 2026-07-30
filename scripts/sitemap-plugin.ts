import type { Plugin } from "vite";
import { SITE_URL } from "../src/seo";

/**
 * Sitemap 条目（路由 + SEO 元信息）
 *
 * 由 vite.config.ts 传入，插件据此生成 sitemap.xml。
 * 新增页面时在 vite.config.ts 的 sitemapRoutes 数组里追加一项即可。
 */
export interface SitemapEntry {
  /** 路由路径，如 "/"、"/demo"、"/blog/hello" */
  path: string;
  /** 更新频率 */
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  /** 优先级 0-1 */
  priority?: number;
}

/**
 * Vite 插件：构建时自动生成 sitemap.xml 和 robots.txt 到输出目录
 *
 * - sitemap.xml：从 sitemapRoutes 生成，搜索引擎据此发现所有可索引页面
 * - robots.txt：声明允许抓取的范围 + 指向 sitemap
 *
 * 这两个文件是构建产物，不纳入 git（已在 .gitignore 的 dist 范围内）。
 */
export function sitemapPlugin(routes: SitemapEntry[]): Plugin {
  return {
    name: "webfont-sitemap",
    /** 构建产物写入完成后生成 SEO 文件 */
    writeBundle() {
      const entries = routes.length > 0 ? routes : [{ path: "/" }];

      const sitemap = generateSitemap(entries);
      const robots = generateRobots();

      // 直接写入磁盘 —— 此时 Vite 已完成 dist 目录写入
      import("node:fs").then((fs) => {
        import("node:path").then((path) => {
          const distDir = path.resolve(process.cwd(), "dist");
          fs.writeFileSync(path.join(distDir, "sitemap.xml"), sitemap, "utf8");
          fs.writeFileSync(path.join(distDir, "robots.txt"), robots, "utf8");
          console.log(`[sitemap] 已生成 sitemap.xml (${entries.length} 条路由) 和 robots.txt`);
        });
      });
    },
  };
}

/** 生成 sitemap.xml 内容 */
function generateSitemap(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const loc = `${SITE_URL}${entry.path === "/" ? "" : entry.path}`;
      const changefreq = entry.changefreq ?? "weekly";
      const priority = entry.priority ?? 0.8;
      return `  <url>
    <loc>${loc}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

/** 生成 robots.txt 内容 */
function generateRobots(): string {
  return `# 允许所有爬虫抓取
User-agent: *
Allow: /

# API 接口不需要索引
Disallow: /api/

# 站点地图
Sitemap: ${SITE_URL}/sitemap.xml
`;
}
