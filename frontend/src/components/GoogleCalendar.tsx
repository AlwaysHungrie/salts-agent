"use client";

import { useEffect, useState } from "react";

type Connection = {
  connected: boolean;
  email: string;
  last_error: string;
  connected_at: number;
};

type Status = { connection: Connection; available: boolean };

const actionButton =
  "bg-canvas border-hairline text-ink hover:bg-canvas-soft shrink-0 rounded-xl border px-2 py-1 text-[13px] font-semibold transition disabled:opacity-40";

/** The result Google's redirect left in the query string, read once on load. */
function returned(): { connected: string | null; failed: string | null } {
  if (typeof window === "undefined") return { connected: null, failed: null };
  const params = new URLSearchParams(window.location.search);
  return {
    connected: params.get("gcal_connected"),
    failed: params.get("gcal_error"),
  };
}

/**
 * The Google Calendar capability's connection. Connecting leaves the app for Google's
 * consent screen and comes back to this page with the result in the query string.
 * Tokens stay in the Worker; the browser only learns which account is connected.
 */
export function GoogleCalendar({ agentId }: { agentId: string }) {
  const base = `/api/agents/${encodeURIComponent(agentId)}/google-calendar`;
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => returned().failed);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(base).catch(() => null);
      const body = (await res?.json().catch(() => null)) as
        | (Status & { error?: string })
        | null;
      if (!live) return;
      if (!res?.ok || !body) {
        setError(body?.error ?? "Couldn't load the connection. Refresh the page to try again.");
        return;
      }
      setStatus(body);
    })();
    return () => {
      live = false;
    };
  }, [base]);

  // Tidy the URL once the result has been read, so a refresh does not replay it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("gcal_connected") && !params.has("gcal_error")) return;
    params.delete("gcal_connected");
    params.delete("gcal_error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  const act = async (action: "connect" | "disconnect") => {
    setBusy(true);
    const res = await fetch(`${base}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        action === "connect" ? { return_to: window.location.href } : {},
      ),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      authorize_url?: string;
      connection?: Connection;
      error?: string;
    } | null;
    if (!res?.ok || !body) {
      setBusy(false);
      setError(body?.error ?? "The agent isn't responding. Try again.");
      return;
    }
    setError(null);
    if (body.authorize_url) {
      window.location.href = body.authorize_url;
      return;
    }
    setBusy(false);
    if (body.connection && status) setStatus({ ...status, connection: body.connection });
  };

  if (!status)
    return (
      <p className="text-muted text-xs leading-[1.33]">
        {error ?? "Loading…"}
      </p>
    );

  const { connection, available } = status;
  return (
    <div className="border-hairline rounded-3xl border px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-semibold leading-[1.43]">
            {connection.connected ? "Connected" : "Not connected"}
          </span>
          <span className="text-muted block truncate text-xs font-light leading-[1.33]">
            {connection.connected
              ? connection.email
              : available
                ? "Sign in with Google to let this agent use your calendar."
                : "Google Calendar isn't set up on this deployment yet."}
          </span>
        </div>
        {connection.connected ? (
          <button
            onClick={() => void act("disconnect")}
            disabled={busy}
            className={actionButton}
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => void act("connect")}
            disabled={busy || !available}
            className="bg-ink text-canvas shrink-0 rounded-xl border px-2 py-1 text-[13px] font-semibold transition disabled:opacity-40"
          >
            Connect
          </button>
        )}
      </div>
      {(error || connection.last_error) && (
        <p className="bg-canvas-soft mt-3 rounded-[14px] px-4 py-3 text-xs leading-[1.33]">
          {error ?? connection.last_error}
        </p>
      )}
    </div>
  );
}
