/**
 * Whether a request came from this app's own pages. Challenges are answered only
 * through the web UI, so the chat routes refuse cross-site callers. Not a hard wall —
 * a script can forge headers — but it keeps other sites from embedding the agent.
 */
export function sameOrigin(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
