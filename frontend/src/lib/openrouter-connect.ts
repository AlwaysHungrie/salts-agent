/**
 * "Connect OpenRouter": OpenRouter's PKCE flow, which hands back a key from the
 * caller's own OpenRouter account without them copying it.
 *
 * `startConnect` sends the browser to OpenRouter with a code challenge; OpenRouter
 * sends it back to `CALLBACK_PATH` with a code, and `finishConnect` trades that code
 * and the verifier for the key. The verifier and the page to return to wait in
 * sessionStorage across the round trip.
 */

/** Where OpenRouter sends the browser back to. */
export const CALLBACK_PATH = "/openrouter-callback";

const STORAGE_KEY = "openrouter-connect";

type Pending = { verifier: string; back: string };

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send the browser to OpenRouter to approve a key, coming back to this page after. */
export async function startConnect(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const pending: Pending = {
    verifier,
    back: window.location.pathname + window.location.search,
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));

  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", window.location.origin + CALLBACK_PATH);
  url.searchParams.set("code_challenge", base64url(new Uint8Array(digest)));
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
}

/**
 * Trade the code OpenRouter came back with for a key. Resolves to the key and the page
 * to return to, or an error to show.
 */
export async function finishConnect(
  code: string,
): Promise<{ key: string; back: string } | { error: string }> {
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    pending = null;
  }
  sessionStorage.removeItem(STORAGE_KEY);
  if (!pending?.verifier) {
    return { error: "This connection expired. Start again from your wallet." };
  }

  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: pending.verifier,
      code_challenge_method: "S256",
    }),
  }).catch(() => null);
  if (!res?.ok) return { error: "OpenRouter didn't hand over a key." };
  const { key } = (await res.json()) as { key?: string };
  if (!key) return { error: "OpenRouter didn't hand over a key." };
  return { key, back: pending.back };
}
