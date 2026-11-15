import type { MetadataRoute } from "next";

/** This site's own pages. The guide's articles are in /guide/sitemap.xml. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://salts.dev", priority: 1 },
    { url: "https://salts.dev/guide", priority: 0.8 },
    { url: "https://salts.dev/privacy", priority: 0.2 },
    { url: "https://salts.dev/terms", priority: 0.2 },
  ];
}
