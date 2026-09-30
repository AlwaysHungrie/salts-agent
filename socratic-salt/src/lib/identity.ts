"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";

/**
 * Who the browser is acting as, and how every call it makes says so.
 *
 * There are two ways to be somebody in this app and they do not overlap.
 *
 * **Clerk** is the ordinary one. You sign in, Clerk mints a session token, and the
 * Next server forwards it to the Worker, which verifies the signature. Nothing about
 * that identity passes through this file — the browser never holds the token and
 * never needs to.
 *
 * **Local** is the back door, and it exists for development. Set both keys in
 * localStorage by hand and you are that address as far as the Worker is concerned,
 * with no sign-in and no proof:
 *
 * ```js
 * localStorage.API_SECRET = "<the deployment secret>"
 * localStorage.API_EMAIL  = "whoever@example.com"
 * ```
 *
 * Then reload. It is the fastest way to be a second user, or a user who has not signed
 * up, or the address on an agent's access list you want to test against.
 *
 * Nothing in the app writes either key. There is no screen that asks for them and no
 * code path that sets them, deliberately: devtools is the only way in, so nothing here
 * can be tricked into opening the door for somebody. Both are read at call time rather
 * than held in React state, because they are needed from places that are not
 * components.
 */

/** Where the back door's two halves live. Names chosen to be typed by hand. */
const SECRET_KEY = "API_SECRET";
const EMAIL_KEY = "API_EMAIL";

/** localStorage throws in a few real situations. None of them should be fatal. */
function read(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // A browser that refuses storage cannot hold a local identity. Clerk still works.
  }
}

/** The deployment secret, if this browser was given one. */
export function localSecret(): string {
  return typeof window === "undefined" ? "" : read(SECRET_KEY);
}

/** The address being impersonated, if one has been chosen. */
export function localEmail(): string {
  return typeof window === "undefined" ? "" : read(EMAIL_KEY).toLowerCase();
}

/**
 * The headers that carry a local identity, or nothing at all.
 *
 * Both halves or neither: a secret with no address names nobody, and an address with
 * no secret is a claim the Worker will not take. When this returns nothing the call
 * goes out as itself and the Next server attaches the Clerk session instead.
 */
export function identityHeaders(): Record<string, string> {
  const secret = localSecret();
  const email = localEmail();
  if (!secret || !email) return {};
  return { "x-api-secret": secret, "x-user-email": email };
}

/**
 * `fetch`, plus whoever this browser is acting as.
 *
 * Every call from a component to `/api/*` goes through this rather than through
 * `fetch` directly. In the ordinary Clerk case it adds nothing and is exactly
 * `fetch`; in the local case it is the only thing that makes the call be from anyone.
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const extra = identityHeaders();
  if (!Object.keys(extra).length) return fetch(input, init);
  return fetch(input, {
    ...init,
    headers: { ...((init?.headers as Record<string, string>) ?? {}), ...extra },
  });
}

/**
 * The back door's two values as one string, and a way to be told when they change.
 *
 * `useSyncExternalStore` rather than a read in an effect: localStorage is exactly the
 * external mutable thing it is for, and it gets the server render right by construction
 * — `SERVER` is what SSR and the hydration pass see, so "not read yet" is a state the
 * markup can be built from instead of a flash corrected afterwards.
 */
const SERVER = "\u0000unread";
const listeners = new Set<() => void>();

function snapshot(): string {
  return `${localSecret()}\n${localEmail()}`;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changing the secret should move this one too.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Our own writes do not raise `storage` in the tab that made them. */
function announce() {
  for (const listener of listeners) listener();
}

/**
 * Fetch a URL that a plain `<img src>` or a link could not, and hand back a blob URL.
 *
 * A browser attaches no headers of ours to a subresource it fetches itself, so in the
 * local case an image behind the identity gate would come back 401. Reading it with
 * `api` and pointing the tag at the result is the only way round that which does not
 * put the secret somewhere it would be logged, like a query string.
 *
 * Returns "" while loading and on failure; callers draw nothing either way.
 */
export function useAuthedUrl(url: string | null): string {
  const snap = useSyncExternalStore(subscribe, snapshot, () => SERVER);
  /** Nothing to work around without a local identity: the tag can fetch it itself. */
  const needsFetch = snap !== SERVER && !!identityHeaders()["x-api-secret"];
  const [blob, setBlob] = useState("");

  useEffect(() => {
    if (!url || !needsFetch) return;
    let objectUrl = "";
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch(url);
        if (!res.ok || !live) return;
        const bytes = await res.blob();
        if (!live) return;
        objectUrl = URL.createObjectURL(bytes);
        setBlob(objectUrl);
      } catch {
        // Offline, or the file is gone. The caller draws nothing.
      }
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, needsFetch]);

  if (!url || snap === SERVER) return "";
  return needsFetch ? blob : url;
}

export type Identity = {
  /** False until the browser has been read; nothing should be drawn before it. */
  ready: boolean;
  /** Which of the two worlds this browser is in. */
  mode: "clerk" | "local";
  /** The address in play, lowercased, or "" when nobody is signed in. */
  email: string;
  signedIn: boolean;
  /** Stop being whoever you are: clears both local keys, or ends the Clerk session. */
  signOut: () => void;
};

/**
 * The one hook every surface asks "who is this".
 *
 * Local wins when a secret is present. That is deliberate and it is absolute: a
 * browser holding the deployment secret is a developer's browser, and having it
 * silently fall back to a Clerk session would make the back door unpredictable in
 * exactly the situation it exists for.
 */
export function useIdentity(): Identity {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut: clerkSignOut } = useClerk();

  /** The server has no localStorage, so `SERVER` is what the first render sees. */
  const snap = useSyncExternalStore(subscribe, snapshot, () => SERVER);
  const local =
    snap === SERVER
      ? null
      : { secret: snap.slice(0, snap.indexOf("\n")), email: snap.slice(snap.indexOf("\n") + 1) };

  const signOut = useCallback(() => {
    if (localSecret()) {
      // Both keys, not just the address. Leaving the secret behind would strand the
      // browser between the two worlds: signed out of the back door, with no screen
      // anywhere that could put an address back.
      write(EMAIL_KEY, "");
      write(SECRET_KEY, "");
      announce();
      return;
    }
    void clerkSignOut();
  }, [clerkSignOut]);

  if (local === null) {
    return { ready: false, mode: "clerk", email: "", signedIn: false, signOut };
  }

  if (local.secret) {
    return {
      ready: true,
      mode: "local",
      email: local.email,
      signedIn: !!local.email,
      signOut,
    };
  }

  return {
    ready: isLoaded,
    mode: "clerk",
    email: (user?.primaryEmailAddress?.emailAddress ?? "").trim().toLowerCase(),
    signedIn: !!isSignedIn,
    signOut,
  };
}
