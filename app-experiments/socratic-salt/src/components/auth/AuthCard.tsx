"use client";

import { useEffect, useRef, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/nextjs";

/**
 * Sign-in and sign-up, drawn in our own chrome.
 *
 * Clerk's prebuilt <SignIn>/<SignUp> bring their own design system with them; this
 * is the same two flows built on the Core 3 custom-flow hooks so the surfaces obey
 * DESIGN.md instead — ink on canvas, pill actions, tint-filled fields, no shadows.
 *
 * Two ways in and no others: Google, and an emailed six-digit code. There is no
 * password field anywhere on purpose — a code is one less secret for the user to
 * keep and one less thing for us to reset.
 */

export type AuthMode = "sign-in" | "sign-up";

/** Where Clerk sends the browser back to after Google has had its say. */
const SSO_CALLBACK = "/sso-callback";

export function AuthCard({
  mode: initialMode,
  redirectUrl = "/",
  onDone,
}: {
  mode: AuthMode;
  /** Where to land once a session exists. */
  redirectUrl?: string;
  /** Called after the session is set — closes the modal, when there is one. */
  onDone?: () => void;
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  /** Which half of the flow is on screen: ask for the address, or for the code. */
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "email") emailField.current?.focus();
    else codeField.current?.focus();
  }, [step]);

  // Switching between the two flows starts over: the sign-up you abandoned has no
  // bearing on the sign-in you are now attempting.
  const switchMode = () => {
    setMode(mode === "sign-in" ? "sign-up" : "sign-in");
    setStep("email");
    setCode("");
    setError(null);
  };

  /**
   * Clerk hands back a machine-stable `code` and a message written for developers.
   * Only the cases a user can actually act on are worth rewording; everything else
   * falls through to Clerk's own wording, which is at least accurate.
   */
  const describe = (err: {
    code: string;
    message: string;
    longMessage?: string;
  }) => {
    if (err.code === "form_identifier_not_found") {
      return "No account with that email. Create one instead.";
    }
    if (err.code === "form_identifier_exists") {
      return "That email already has an account. Sign in instead.";
    }
    if (err.code === "form_code_incorrect") {
      return "That code isn't right. Check it and try again.";
    }
    return err.longMessage ?? err.message;
  };

  const google = async () => {
    setBusy(true);
    setError(null);
    // A Google account that has never been here signs up, and one that has signs
    // in; Clerk transfers between the two itself once the redirect comes back.
    const params = {
      strategy: "oauth_google" as const,
      redirectUrl,
      redirectCallbackUrl: SSO_CALLBACK,
    };
    const { error: err } =
      mode === "sign-in" ? await signIn.sso(params) : await signUp.sso(params);
    if (err) {
      setError(describe(err));
      setBusy(false);
    }
    // On success the browser leaves for Google, so there is nothing to reset.
  };

  const sendCode = async () => {
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    setError(null);

    const { error: err } =
      mode === "sign-in"
        ? await signIn.emailCode.sendCode({ emailAddress: address })
        : await (async () => {
            const created = await signUp.create({ emailAddress: address });
            if (created.error) return created;
            return signUp.verifications.sendEmailCode();
          })();

    setBusy(false);
    if (err) {
      setError(describe(err));
      return;
    }
    setStep("code");
  };

  const verify = async () => {
    const entered = code.trim();
    if (!entered || busy) return;
    setBusy(true);
    setError(null);

    const { error: err } =
      mode === "sign-in"
        ? await signIn.emailCode.verifyCode({ code: entered })
        : await signUp.verifications.verifyEmailCode({ code: entered });

    if (err) {
      setError(describe(err));
      setBusy(false);
      return;
    }

    // Verified is not yet signed in: finalize is what makes the new session active.
    const { error: finalErr } =
      mode === "sign-in" ? await signIn.finalize() : await signUp.finalize();
    setBusy(false);
    if (finalErr) {
      setError(describe(finalErr));
      return;
    }
    onDone?.();
  };

  const signingIn = mode === "sign-in";

  return (
    <div className="w-full max-w-sm">
      <h2 className="text-[32px] font-[650] leading-[1.13]">
        {step === "code"
          ? "Check email."
          : signingIn
            ? "Welcome."
            : "Create account."}
      </h2>
      <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
        {step === "code"
          ? `We sent a six-digit code to ${email.trim()}`
          : signingIn
            ? "Sign in, your agents are waiting on you"
            : "Personal, always accessible AI agents"}
      </p>

      {step === "email" && (
        <>
          <button
            type="button"
            onClick={() => void google()}
            disabled={busy}
            className="border-hairline text-ink hover:bg-canvas-soft mt-8 flex h-12 w-full cursor-pointer items-center justify-center gap-3 rounded-full border text-base font-semibold transition disabled:opacity-40"
          >
            <GoogleMark />
            Continue with Google
          </button>

          <div className="mt-6 flex items-center gap-3">
            <span className="bg-hairline-soft h-px flex-1" />
            <span className="text-faint text-xs leading-[1.33]">or</span>
            <span className="bg-hairline-soft h-px flex-1" />
          </div>

          <label className="mt-6 block">
            <span className="block text-sm font-semibold leading-[1.43]">
              Email
            </span>
            <input
              ref={emailField}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendCode();
              }}
              placeholder="you@example.com"
              className="bg-field placeholder:text-faint focus:ring-ink mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2"
            />
          </label>
        </>
      )}

      {step === "code" && (
        <label className="mt-8 block">
          <span className="block text-sm font-semibold leading-[1.43]">
            Verification code
          </span>
          <input
            ref={codeField}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void verify();
            }}
            placeholder="123456"
            className="bg-field placeholder:text-faint focus:ring-ink tnum mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2"
          />
        </label>
      )}

      {/* Clerk's bot check renders itself here when the instance asks for one. */}
      <div id="clerk-captcha" className="mt-4 empty:mt-0" />

      {error && (
        <p className="text-muted mt-3 text-xs leading-[1.33]">{error}</p>
      )}

      <button
        type="button"
        onClick={() => void (step === "email" ? sendCode() : verify())}
        disabled={busy || (step === "email" ? !email.trim() : !code.trim())}
        className="bg-ink text-on-primary mt-4 h-12 w-full cursor-pointer rounded-full text-base font-semibold transition hover:opacity-85 disabled:opacity-40"
      >
        {busy ? "Working…" : step === "email" ? "Continue" : "Verify"}
      </button>

      {step === "code" ? (
        <button
          type="button"
          onClick={() => {
            setStep("email");
            setCode("");
            setError(null);
          }}
          className="text-muted hover:text-ink mt-4 w-full cursor-pointer text-sm leading-[1.43] transition"
        >
          Use a different email
        </button>
      ) : (
        <p className="text-muted mt-4 text-center text-sm leading-[1.43]">
          {signingIn ? "No account yet? " : "Already have an account? "}
          <button
            type="button"
            onClick={switchMode}
            className="text-ink cursor-pointer font-semibold hover:underline"
          >
            {signingIn ? "Create one" : "Sign in"}
          </button>
        </p>
      )}
    </div>
  );
}

/** Google's mark, inlined so the button needs no network round trip to draw. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
