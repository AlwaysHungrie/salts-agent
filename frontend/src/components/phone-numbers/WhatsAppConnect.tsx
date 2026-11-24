"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { shownNumber } from "./PhoneNumbersPanel";
import type { BusinessNumber } from "./BusinessNumberPicker";

/** Where the agent's number is in joining WhatsApp for Business, as the Worker says. */
type Setup = {
  number: { id: string; number: string; kind: "own" | "bought" } | null;
  stage: "" | "account" | "ready" | "sender";
  status: string;
  code: string;
  owner: boolean;
  signup: { app_id: string; config_id: string; solution_id: string };
};

/** The Graph API version Facebook's SDK is started with. */
const GRAPH_VERSION = "v23.0";
/** How often the card asks again while waiting on a code or on Twilio. */
const POLL_MS = 4000;

type FacebookSdk = {
  init: (opts: Record<string, unknown>) => void;
  login: (cb: (res: unknown) => void, opts: Record<string, unknown>) => void;
};
declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

/** Facebook's JS SDK, loaded once and started with the deployment's Meta app. */
function loadSdk(appId: string): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION });
      resolve(window.FB!);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdk = null;
      reject(new Error("Couldn't load Facebook's signup."));
    };
    document.body.appendChild(script);
  });
  return sdk;
}

/** What Meta's signup window posts back about how it ended. */
type SignupMessage =
  | { ended: "finish"; waba_id: string }
  | { ended: "cancel" }
  | { ended: "error"; message: string };

function signupMessage(event: MessageEvent): SignupMessage | null {
  if (!event.origin.endsWith("facebook.com")) return null;
  let data: { type?: string; event?: string; data?: Record<string, string> };
  try {
    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  } catch {
    return null;
  }
  if (data?.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (data.event?.startsWith("FINISH") && data.data?.waba_id) {
    return { ended: "finish", waba_id: data.data.waba_id };
  }
  if (data.event === "CANCEL") return { ended: "cancel" };
  if (data.event === "ERROR") {
    return { ended: "error", message: data.data?.error_message ?? "Meta's signup failed." };
  }
  return null;
}

const STATUS_TEXT: Record<string, string> = {
  ONLINE: "Live on WhatsApp.",
  OFFLINE: "Offline on WhatsApp. Contact support to bring it back.",
};

async function call(agentId: string, step = "", body?: unknown) {
  const res = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/whatsapp-business${step ? `/${step}` : ""}`,
    step
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }
      : { cache: "no-store" },
  );
  const read = (await res.json().catch(() => null)) as (Setup & { error?: string }) | null;
  if (!res.ok || !read) throw new Error(read?.error ?? "Something went wrong. Try again.");
  return read;
}

/**
 * Connects the agent's number to WhatsApp for Business: Meta's signup window makes (or
 * picks) the business's WhatsApp Business account and verifies the number, then the
 * Worker registers the number there. A bought number's verification code is shown here,
 * since Meta texts it to a number only Salts can read.
 */
export function WhatsAppConnect({
  agentId,
  number,
}: {
  agentId: string;
  number: BusinessNumber;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(false);

  const read = useCallback(
    () =>
      call(agentId).then(
        (next) => ({ next, error: null }),
        (err: Error) => ({ next: null, error: err.message }),
      ),
    [agentId],
  );
  const apply = useCallback((r: { next: Setup | null; error: string | null }) => {
    if (r.next) setSetup(r.next);
    else setError(r.error);
  }, []);
  const load = useCallback(async () => apply(await read()), [apply, read]);

  // Read again whenever the agent's number changes.
  const numberId = number?.id;
  useEffect(() => {
    void read().then(apply);
  }, [read, apply, numberId]);

  // Poll while a code may arrive, or while Twilio is still registering the number.
  const waiting =
    signingUp ||
    (setup?.stage === "sender" && !STATUS_TEXT[setup.status]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const signup = async () => {
    if (!setup) return;
    const displayName = name.trim();
    if (!displayName) {
      setError("Enter your business's display name first.");
      return;
    }
    setBusy(true);
    setError(null);
    finished.current = false;
    try {
      setSetup(await call(agentId, "prepare"));
      const FB = await loadSdk(setup.signup.app_id);
      setSigningUp(true);

      const onMessage = async (event: MessageEvent) => {
        const msg = signupMessage(event);
        if (!msg) return;
        finished.current = true;
        window.removeEventListener("message", onMessage);
        setSigningUp(false);
        if (msg.ended === "finish") {
          try {
            setSetup(await call(agentId, "connect", { waba_id: msg.waba_id, display_name: displayName }));
          } catch (err) {
            setError((err as Error).message);
          }
        } else if (msg.ended === "error") {
          setError(msg.message);
        }
        setBusy(false);
      };
      window.addEventListener("message", onMessage);

      FB.login(
        () => {
          // The window closed. Meta posts how signup ended just before; if it never
          // did, the user closed it part way.
          setTimeout(() => {
            if (finished.current) return;
            window.removeEventListener("message", onMessage);
            setSigningUp(false);
            setBusy(false);
          }, 1500);
        },
        {
          config_id: setup.signup.config_id,
          auth_type: "rerequest",
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: { solutionID: setup.signup.solution_id } },
        },
      );
    } catch (err) {
      setError((err as Error).message);
      setSigningUp(false);
      setBusy(false);
    }
  };

  if (!setup?.number) return null;
  const { signup: ids, stage, status, code, owner } = setup;
  const shown = shownNumber(setup.number.number);
  const bought = setup.number.kind === "bought";

  return (
    <div className="mb-4">
      <p className="mb-2 text-sm font-semibold leading-[1.43]">WhatsApp</p>

      {stage === "sender" ? (
        <p className="bg-field rounded-2xl px-4 py-3 text-sm">
          {STATUS_TEXT[status] ?? `Registering ${shown} with WhatsApp…`}
        </p>
      ) : !(ids.app_id && ids.config_id && ids.solution_id) ? (
        <p className="text-muted text-xs font-light leading-[1.33]">
          Connecting numbers to WhatsApp isn&apos;t open yet.
        </p>
      ) : !owner ? (
        <p className="text-muted text-xs font-light leading-[1.33]">
          Only the owner of {shown} can connect it to WhatsApp.
        </p>
      ) : (
        <>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Business display name"
            aria-label="Business display name"
            maxLength={255}
            disabled={busy}
            className="bg-field text-ink focus:ring-ink mb-2 w-full rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2"
          />
          <p className="text-muted mb-3 text-xs font-light leading-[1.33]">
            Use the same name you give Meta in the next step. Customers see it on WhatsApp.
          </p>
          <button
            onClick={() => void signup()}
            disabled={busy}
            className="bg-ink text-canvas inline-flex items-center rounded-full px-4 py-2 text-xs font-semibold leading-[1.33] transition hover:opacity-90 disabled:opacity-50"
          >
            {signingUp ? "Finish in the Meta window…" : busy ? "Connecting…" : "Connect to WhatsApp"}
          </button>
          {signingUp && (
            <p className="text-muted mt-3 text-xs font-light leading-[1.33]">
              {bought
                ? code
                  ? `Meta's code for ${shown}: `
                  : `When Meta asks for the code sent to ${shown}, it will appear here.`
                : `Meta will send a code to ${shown}. Enter it in the Meta window.`}
              {bought && code && (
                <span className="text-ink font-mono text-sm font-semibold">{code}</span>
              )}
            </p>
          )}
        </>
      )}

      {error && <p className="mt-2 text-xs leading-[1.33]">{error}</p>}
    </div>
  );
}
