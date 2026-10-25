/**
 * Who is signed in on this browser, kept in local storage for the front page to show
 * ("Profile found" on the vending machine's small screen). Only the name and email: the
 * session itself stays in its http-only cookie, out of reach of page scripts.
 */
export type Profile = { name: string; email: string };

const STORAGE_KEY = "HUMANS_PROFILE";
const CHANGED = "humans-profile";

/** The stored profile as raw JSON, so `useSyncExternalStore` sees a stable value. */
export function storedProfile(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function parseProfile(raw: string | null): Profile | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Profile>;
    return typeof p.name === "string" && typeof p.email === "string" ? { name: p.name, email: p.email } : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: Profile | null): void {
  try {
    if (profile) localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the screen just shows nothing.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Calls `onChange` when the profile changes, in this tab or another. */
export function subscribeProfile(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}
