import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Each guide article's raw markdown, for AI agents (see `/llms.txt`).
    return [{ source: "/guide/:slug.md", destination: "/guide-md/:slug" }];
  },
  async redirects() {
    return [
      // The WhatsApp guide moved into the user guide. The settings page still links
      // the old address with `?agent=<id>`, and a redirect keeps the query string.
      { source: "/guides/whatsapp", destination: "/guide/whatsapp", permanent: true },
    ];
  },
};

export default nextConfig;
