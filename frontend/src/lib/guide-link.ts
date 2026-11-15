/**
 * Where the user guide is read.
 *
 * In production the guide lives at salts.dev/guide: the landing site proxies it from
 * this app (see `next.config.ts`), and app.salts.dev/guide redirects there. Links from
 * the app go straight to salts.dev so they skip the redirect. Anywhere else (staging,
 * local) the guide stays on the app's own host.
 */
export const GUIDE_ORIGIN =
  process.env.NEXT_PUBLIC_VERCEL_ENV === "production" ? "https://salts.dev" : "";

/**
 * The app's home, from a guide page. A plain address, not a `<Link>`: on salts.dev the
 * guide is a different zone, and a soft navigation to `/` would draw the app's home
 * under the landing site's address.
 */
export const APP_HOME = GUIDE_ORIGIN ? "https://app.salts.dev" : "/";

/** The guide index, or one article when `slug` is given. */
export function guideHref(slug?: string): string {
  return `${GUIDE_ORIGIN}/guide${slug ? `/${slug}` : ""}`;
}
