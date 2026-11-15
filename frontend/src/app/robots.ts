import type { MetadataRoute } from "next";

/**
 * app.salts.dev is the signed-in app. Its public face is the sign-in page; agents,
 * callbacks and API routes are nobody's search result. `/zone/` is the copy of the
 * guide the landing site proxies to salts.dev/guide, which is the address to index.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/a/",
        "/api/",
        "/zone/",
        "/sso-callback",
        "/openrouter-callback",
        "/salts-tools/",
      ],
    },
    sitemap: "https://salts.dev/guide/sitemap.xml",
  };
}
