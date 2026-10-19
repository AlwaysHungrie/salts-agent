import { useEffect, useState } from "react";

/**
 * The request for a higher agent limit, as a full screen. It grants nothing: the owner
 * reviews it from the admin CLI, and the copy says so.
 */
export function BusinessRequestDialog({
  email,
  quota,
  onClose,
}: {
  email: string;
  quota: { limit: number; owned: number } | null;
  onClose: () => void;
}) {
  const [increase, setIncrease] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  // Escape closes, and the page behind stops scrolling while this is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const parsed = Number(increase);
  const valid = Number.isInteger(parsed) && parsed > 1 && parsed <= 1000;

  const submit = async () => {
    if (!valid) {
      setError("Cannot be more than 1000");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/business-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ increase: parsed }),
    });
    setBusy(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(
        payload?.error ??
          "That didn't send. Check your connection and try again.",
      );
      return;
    }
    setSent(parsed);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Need more agents"
      className="bg-canvas fixed inset-0 z-50 overflow-y-auto overscroll-contain"
    >
      {/* The one place the accent blue is allowed: a commercial decision, washed down
          from the top the way a tinted capability card washes down its section. */}
      <div className="from-accent/12 pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-linear-to-b to-transparent" />

      <div className="relative mx-auto w-full max-w-2xl px-5 pt-8 pb-20 sm:px-8 sm:pt-12">
        <div className="flex justify-end">
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:bg-white hover:text-ink flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none transition"
          >
            ×
          </button>
        </div>

        {sent !== null ? (
          <RequestSent sent={sent} email={email} onClose={onClose} />
        ) : (
          <div className="pt-6 sm:pt-10">
            <span className="bg-white text-muted inline-flex items-center rounded-[10px] px-3 py-1.5 text-xs font-semibold leading-[1.33]">
              Fleet Account
            </span>
            <h1 className="mt-5 text-[clamp(30px,4.5vw,44px)] leading-[1.08] tracking-[-0.025em]">
              Give your whole community personal agents.
            </h1>
            <p className="text-muted mt-4 max-w-lg text-base font-light leading-[1.4] sm:text-xl">
              Create an agent for everyone in your community. They can share
              your OpenRouter key, each with its own spending limit, so they
              work out of the box.
            </p>

            {/* Three plain statements, not a feature grid. What is being asked for is
                a bigger number; dressing it up as anything else would be a lie. */}
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              {[
                [
                  "One shared key",
                  "Every agent can run on your OpenRouter key, and you decide how much each one can spend.",
                ],
                [
                  "Easier for them",
                  "Choose which settings and capabilities your members see, and hide the rest to keep things simple.",
                ],
                [
                  "Private to each person",
                  "Every agent keeps its own chats, memories and bot. You can't read anyone's conversations.",
                ],
              ].map(([title, body]) => (
                <div key={title} className="rounded-[24px] py-6">
                  <h2 className="text-base font-semibold tracking-[-0.01em]">
                    {title}
                  </h2>
                  <p className="text-muted mt-2 text-sm leading-relaxed">
                    {body}
                  </p>
                </div>
              ))}
            </div>

            <div className="bg-canvas-soft mt-8 rounded-[24px] px-6 py-7 sm:px-8">
              <h2 className="text-xl font-semibold tracking-[-0.01em]">
                Request access.
              </h2>
              <p className="text-muted mt-2 text-sm leading-relaxed">
                Upgrades are free for now. We review every request by hand.
              </p>

              {/* No labels: the email is read-only and the number speaks for itself. */}
              <div className="mt-6 space-y-3">
                <div className="bg-canvas ring-hairline-soft flex h-12 w-full items-center rounded-2xl px-4 text-sm ring-1">
                  <span className="truncate">{email}</span>
                </div>

                <div>
                  <input
                    aria-label="Number of agents to request"
                    type="number"
                    min={1}
                    step={1}
                    value={increase}
                    onChange={(e) => setIncrease(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submit();
                    }}
                    className="bg-canvas ring-hairline-soft placeholder:text-faint h-12 w-full rounded-2xl px-4 text-sm ring-1 outline-none"
                  />
                  {quota && (
                    <span className="text-faint mt-2 block text-xs leading-[1.33]">
                      <span className="text-ink/50">
                        {quota.limit - quota.owned}
                      </span>{" "}
                      agents remaining (current limit: {quota.limit})
                    </span>
                  )}
                </div>
              </div>

              {error && <p className="mt-4 text-xs leading-[1.33]">{error}</p>}

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void submit()}
                  disabled={busy}
                  className="bg-ink text-on-primary h-12 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
                >
                  {busy ? "Sending…" : "Send request"}
                </button>
                <button
                  onClick={onClose}
                  className="text-muted hover:text-ink h-12 rounded-full px-4 text-sm font-semibold transition"
                >
                  Not now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** What the screen says once the request is filed. */
function RequestSent({
  sent,
  email,
  onClose,
}: {
  sent: number;
  email: string;
  onClose: () => void;
}) {
  return (
    <div className="pt-6 sm:pt-10">
      <span className="bg-white text-muted inline-flex items-center rounded-[10px] px-3 py-1.5 text-xs font-semibold leading-[1.33]">
        Request sent
      </span>
      <h1 className="mt-5 text-[clamp(30px,4.5vw,44px)] leading-[1.08] tracking-[-0.025em]">
        We&apos;ve received your request.
      </h1>
      <p className="text-muted mt-4 max-w-lg text-base font-light leading-[1.4] sm:text-xl">
        You asked for {sent} more {sent === 1 ? "agent" : "agents"} on{" "}
        <span className="text-ink font-medium">{email}</span>. We&apos;ll get
        back to you soon.
      </p>

      <div className="ring-hairline-soft mt-10 rounded-[24px] p-7 ring-1">
        <h2 className="text-xl font-semibold tracking-[-0.01em]">
          Once approved
        </h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          You&apos;ll be able to create agents for your community as a
          fleet, and manage them one by one or all together. They can share
          your OpenRouter key, each with its own spending limit, so every
          agent works out of the box.
        </p>
      </div>

      <div className="mt-10">
        <button
          onClick={onClose}
          className="bg-ink text-on-primary h-12 rounded-full px-6 text-sm font-semibold transition hover:opacity-85"
        >
          Back to my agents
        </button>
      </div>
    </div>
  );
}
