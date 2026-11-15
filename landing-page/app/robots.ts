import type { MetadataRoute } from "next";

/**
 * Everything on salts.dev is public, AI crawlers included. Two sitemaps: this site's
 * pages, and the user guide's, which the web app generates (the guide is proxied here,
 * see next.config.ts).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: ["https://salts.dev/sitemap.xml", "https://salts.dev/guide/sitemap.xml"],
  };
}
