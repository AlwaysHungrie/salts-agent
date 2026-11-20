"use client";

import { useEffect } from "react";

/** The only host the beacon reports from. */
const HOST = "app.salts.dev";

/**
 * Cloudflare Web Analytics: cookieless page views. Same site token as the landing
 * page; scripts/visitors.sh separates the two by host.
 *
 * Injected on the client so it loads on app.salts.dev alone. This app also serves
 * salts.dev/guide through the landing site's proxy, plus Vercel previews and
 * localhost, and none of those should count.
 */
export function AnalyticsBeacon() {
  useEffect(() => {
    if (window.location.hostname !== HOST) return;
    const script = document.createElement("script");
    script.defer = true;
    script.src = "https://static.cloudflareinsights.com/beacon.min.js";
    script.dataset.cfBeacon = JSON.stringify({
      token: "baad0908ac1347658a154edfa8fd019b",
    });
    document.body.appendChild(script);
  }, []);
  return null;
}
