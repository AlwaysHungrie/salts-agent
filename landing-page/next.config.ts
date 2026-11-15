import type { NextConfig } from "next";

/**
 * The user guide is read here, at salts.dev/guide, but built and served by the web app
 * (`frontend/`). These rewrites proxy it (Next.js multi-zones). The app serves the guide
 * to us under `/zone/...` and its assets under `/app-static/...`; see
 * `frontend/next.config.ts` for the other half.
 */
const APP = process.env.APP_ORIGIN ?? "https://app.salts.dev";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/guide", destination: `${APP}/zone/guide` },
      { source: "/guide/:path+", destination: `${APP}/zone/guide/:path+` },
      { source: "/llms.txt", destination: `${APP}/zone/llms.txt` },
      { source: "/app-static/:path+", destination: `${APP}/app-static/:path+` },
      // Screenshots in the guide, from the app's `public/guides/`.
      { source: "/guides/:path+", destination: `${APP}/guides/:path+` },
    ];
  },
};

export default nextConfig;
