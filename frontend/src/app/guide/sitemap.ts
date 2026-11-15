import type { MetadataRoute } from "next";

import { allGuides } from "@/lib/guide";

/**
 * `/guide/sitemap.xml`: every article, at its salts.dev address (where the landing
 * site serves the guide; salts.dev/robots.txt lists this file).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return allGuides().map((guide) => ({ url: `https://salts.dev/guide/${guide.slug}` }));
}
