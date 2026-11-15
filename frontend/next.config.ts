import type { NextConfig } from "next";

/**
 * The user guide is read at salts.dev/guide. The landing site (`landing-page/`) proxies
 * these paths to this app:
 *
 *   salts.dev/guide/*      -> app.salts.dev/zone/guide/*
 *   salts.dev/llms.txt     -> app.salts.dev/zone/llms.txt
 *   salts.dev/app-static/* -> app.salts.dev/app-static/*  (this app's JS, CSS, fonts)
 *   salts.dev/guides/*     -> app.salts.dev/guides/*      (screenshots in `public/`)
 *
 * `/zone/...` is the address the proxy uses, so the redirect below (which sends people
 * from app.salts.dev/guide to salts.dev/guide) never sees it and cannot loop.
 */
const SITE = "https://salts.dev";
const APP_HOST = "app.salts.dev";
const onApp = [{ type: "host" as const, value: APP_HOST }];

const nextConfig: NextConfig = {
  // Asset URLs carry a prefix so the landing site can route them back to this app.
  assetPrefix: "/app-static",
  async rewrites() {
    return [
      // Each guide article's raw markdown, for AI agents (see `/llms.txt`).
      { source: "/zone/guide/:slug.md", destination: "/guide-md/:slug" },
      { source: "/guide/:slug.md", destination: "/guide-md/:slug" },
      { source: "/zone/guide", destination: "/guide" },
      { source: "/zone/guide/:path*", destination: "/guide/:path*" },
      { source: "/zone/llms.txt", destination: "/llms.txt" },
    ];
  },
  async redirects() {
    return [
      // The WhatsApp guide moved into the user guide. The settings page still links
      // the old address with `?agent=<id>`, and a redirect keeps the query string.
      { source: "/guides/whatsapp", destination: "/guide/whatsapp", permanent: true },
      // Production only: the guide's home is salts.dev. Staging and local keep theirs.
      { source: "/guide", has: onApp, destination: `${SITE}/guide`, permanent: true },
      { source: "/guide/:path*", has: onApp, destination: `${SITE}/guide/:path*`, permanent: true },
      { source: "/llms.txt", has: onApp, destination: `${SITE}/llms.txt`, permanent: true },
    ];
  },
};

export default nextConfig;
