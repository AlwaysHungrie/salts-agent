"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MAX_ART_PASS_BYTES, passArt } from "@/lib/pass-art";
import type { Profile } from "@/lib/profile";

/** A chosen ticket's logo, as an object URL, and its art colours: the upload box shows them. */
type TicketArt = {
  logo: string;
  background: string | null;
  foreground: string | null;
  label: string | null;
};

async function ticketArt(file: File): Promise<TicketArt | null> {
  if (file.size > MAX_ART_PASS_BYTES) return null;
  const art = passArt(new Uint8Array(await file.arrayBuffer()));
  if (!art?.logo) return null;
  const logo = URL.createObjectURL(
    new Blob([art.logo.slice()], { type: "image/png" }),
  );
  return { ...art, logo };
}

/** Local storage key holding the admin key; set it by hand in the browser's console. */
const ADMIN_STORAGE_KEY = "HUMANS_ADMIN_KEY";

function storedAdminKey(): string | null {
  try {
    return localStorage.getItem(ADMIN_STORAGE_KEY);
  } catch {
    return null;
  }
}

// Read once on the client; set the key, then reload the page.
const noSubscribe = () => () => {};

/** Set up the new user's agent; 409 means another tab is setting it up, so wait for it. */
async function setUpAgent(): Promise<void> {
  for (let tries = 0; ; tries++) {
    const res = await fetch("/api/agent", { method: "PUT" });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status !== 409 || tries >= 20)
      throw new Error(
        body.error || "Your agent couldn’t be set up. Try again.",
      );
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function answer(res: Response): Promise<Profile> {
  const data = (await res.json().catch(() => ({}))) as {
    name?: string;
    email?: string;
    error?: string;
  };
  if (!res.ok || !data.name || !data.email)
    throw new Error(data.error || "Something went wrong. Try again.");
  return { name: data.name, email: data.email };
}

/**
 * Signing in, inside the Enter dialog: the Devcon ticket's .pkpass, and, in admin mode
 * (`admin`: this browser's session is an admin's, or its local storage has HUMANS_ADMIN_KEY,
 * which the server checks against its own), any email with no ticket. Once signed in, the user's agent is set up
 * here, before `onSignedIn`, so the dialog shows each step rather than closing at once.
 */
export function SignInPanel({
  admin,
  onSignedIn,
}: {
  admin: boolean;
  onSignedIn: (profile: Profile) => void;
}) {
  const adminKey = useSyncExternalStore(
    noSubscribe,
    storedAdminKey,
    () => null,
  );
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [art, setArt] = useState<TicketArt | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [adminError, setAdminError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Who signed in, while their agent is being set up. */
  const [signedIn, setSignedIn] = useState<Profile | null>(null);
  const [setupError, setSetupError] = useState("");

  async function finish(profile: Profile) {
    setSignedIn(profile);
    setSetupError("");
    try {
      await setUpAgent();
      onSignedIn(profile);
    } catch (err) {
      setSetupError(
        err instanceof Error
          ? err.message
          : "Your agent couldn’t be set up. Try again.",
      );
    }
  }

  function pick(next: File | null) {
    if (input.current) input.current.value = "";
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".pkpass")) {
      setError(
        "That isn’t a .pkpass file. Use the one that came with your ticket.",
      );
      return;
    }
    setFile(next);
    setError("");
    setArt(null);
    // Only dresses the box: a pass whose artwork cannot be read is still sent to be checked.
    void ticketArt(next)
      .then(setArt)
      .catch(() => setArt(null));
  }

  // Each chosen ticket's images are released once another replaces them, or the dialog closes.
  useEffect(
    () => () => {
      if (art) URL.revokeObjectURL(art.logo);
    },
    [art],
  );

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose your .pkpass file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("pass", file);
      await finish(
        await answer(await fetch("/api/badge", { method: "POST", body })),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
      setBusy(false);
    }
  }

  async function bypass(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAdminError("");
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-humans-admin-key": adminKey ?? "",
        },
        body: JSON.stringify({ email }),
      });
      if (res.status === 404) throw new Error("Admin mode is not on for this browser.");
      await finish(await answer(res));
    } catch (err) {
      setAdminError(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
      setBusy(false);
    }
  }

  if (signedIn)
    return (
      <div className="mx-auto max-w-[52rem]">
        <h2 className="font-orbitron text-4xl font-black uppercase leading-[0.95] text-white sm:text-5xl">
          Humans
        </h2>
        <div
          className="terminal-text mt-10 space-y-3 text-2xl"
          aria-live="polite"
        >
          <p>&gt; TICKET VERIFIED</p>
          <p className="truncate opacity-80">&gt; {signedIn.email}</p>
          {setupError ? (
            <p className="text-[#ff7a9a] [text-shadow:none]">
              &gt; {setupError}
            </p>
          ) : (
            <p>
              &gt; SETTING UP YOUR AGENT
              <span className="terminal-cursor" aria-hidden />
            </p>
          )}
        </div>
        {setupError && (
          <button
            type="button"
            onClick={() => void finish(signedIn)}
            className="mt-8 h-12 w-full rounded-full bg-white font-orbitron text-xs font-bold uppercase tracking-[0.2em] text-black transition-opacity duration-300 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
          >
            Try again
          </button>
        )}
      </div>
    );

  return (
    <div className="mx-auto max-w-[52rem]">
      <h2 className="font-orbitron text-4xl font-black uppercase leading-[0.95] text-white sm:text-5xl">
        Humans
      </h2>
      <p className="mt-5 font-orbitron text-[0.65rem] font-medium uppercase tracking-[0.42em] text-white/50">
        at Devcon VIII
      </p>

      <p className="mt-10 max-w-[40rem] text-xl leading-relaxed text-white/85">
        Humans is a terminal for finding and staying in touch with the best
        people at Devcon. Ask about anything and create your own profile so
        people can find you.
      </p>

      <form
        onSubmit={verify}
        noValidate
        className="mt-12 grid gap-10 sm:grid-cols-2"
      >
        <div>
          {/* No `accept`: the iOS picker knows no type for .pkpass and greys the file out. `pick` checks the name. */}
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              pick(e.dataTransfer.files[0] ?? null);
            }}
            disabled={busy}
            style={
              art ? { background: art.background ?? "#f4f5fd" } : undefined
            }
            className={`relative flex min-h-36 w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border px-4 py-8 text-center transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 ${
              art
                ? "border-transparent"
                : over || file
                  ? "border-dashed border-white/60 bg-white/[0.06]"
                  : "border-dashed border-white/20 hover:border-white/40"
            }`}
          >
            {art ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL from the chosen file */}
                <img
                  src={art.logo}
                  alt=""
                  className="max-h-20 w-auto max-w-[80%] object-contain"
                />
                <span
                  className="mt-2 text-sm"
                  style={{ color: art.label ?? art.foreground ?? "#594d73" }}
                >
                  Ready. Click to change.
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-white">
                  {file ? file.name : "Add your .pkpass ticket"}
                </span>
                <span className="text-sm text-white/50">
                  {file
                    ? "Ready. Click to change."
                    : "It will be in your inbox"}
                </span>
              </>
            )}
          </button>
          {error && (
            <p role="alert" className="mt-3 text-sm text-[#ff7a9a]">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !file}
            className="mt-6 h-12 w-full rounded-full bg-white font-orbitron text-xs font-bold uppercase tracking-[0.2em] text-black transition-opacity duration-300 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
          >
            {busy ? "Checking…" : "Enter terminal"}
          </button>
        </div>
        <div className="space-y-4 text-base leading-[1.75] text-white/70 sm:border-l sm:border-white/15 sm:pl-10">
          <p>
            <strong className="font-semibold text-white">
              Please present your ticket
            </strong>
          </p>
          <p>
            Your <strong className="font-semibold text-white">.pkpass</strong>{" "}
            ticket is used to authenticate your email address. It is checked
            only once and never stored anywhere or shared with anyone.
          </p>
          <p>
            Even then your ticket{" "}
            <strong className="font-semibold text-white">CANNOT</strong> be
            misused, as it requires 2FA at the venue.
          </p>
        </div>
      </form>

      {(admin || adminKey) && (
        <form onSubmit={bypass} noValidate className="mt-14">
          <div className="mb-6 flex items-center gap-4">
            <span className="font-orbitron text-[0.6rem] font-bold uppercase tracking-[0.35em] text-white/40">
              Admin
            </span>
            <span className="h-px flex-1 bg-white/15" />
          </div>
          <label htmlFor="admin-email" className="block text-sm text-white/70">
            Sign in as any email, no ticket
          </label>
          <div className="mt-3 flex gap-2">
            <input
              id="admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
              className="h-12 min-w-0 flex-1 rounded-full border border-white/20 bg-transparent px-5 text-white placeholder:text-white/30 focus:border-white/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="h-12 shrink-0 rounded-full border border-white/30 px-5 font-orbitron text-xs font-bold uppercase tracking-[0.2em] text-white transition-colors duration-300 hover:border-white/60 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
            >
              Go
            </button>
          </div>
          {adminError && (
            <p role="alert" className="mt-3 text-sm text-[#ff7a9a]">
              {adminError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
