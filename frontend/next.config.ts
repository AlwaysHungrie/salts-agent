import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The WhatsApp guide moved into the user guide. The settings page still links
      // the old address with `?agent=<id>`, and a redirect keeps the query string.
      { source: "/guides/whatsapp", destination: "/guide/whatsapp", permanent: true },
    ];
  },
};

export default nextConfig;
