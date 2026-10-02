"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { MAX_MESSAGES, messageProblem } from "@/lib/rules";
import { readFrames } from "@/lib/sse";

type Message = { id: string; role: "user" | "assistant"; content: string };
type ChatState = { sent: number; limit: number; messages: Message[] };

async function fetchChat(base: string): Promise<ChatState> {
  const res = await fetch(base, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Partial<ChatState> & { error?: string };
  if (!res.ok) throw new Error(body.error || "Your chat didn’t load. Refresh the page to try again.");
  return { sent: body.sent ?? 0, limit: body.limit ?? MAX_MESSAGES, messages: body.messages ?? [] };
}

/** Ways to open a conversation; each fills the box for the user to finish. */
const STARTERS = [
  { label: "I’m hiring", text: "I’m hiring for a " },
  { label: "I’m looking for a role", text: "I’m looking for a role as a " },
  { label: "Who should I meet?", text: "Which candidates have experience with " },
];

/** Messages used, one tick each, like holes punched in a wristband. */
function Meter({ sent, limit }: { sent: number; limit: number }) {
  const left = Math.max(0, limit - sent);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        role="meter"
        aria-label="Messages used"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={sent}
        className="flex gap-[3px]"
      >
        {Array.from({ length: limit }, (_, i) => (
          <span
            key={i}
            className={`h-3.5 w-1.5 rounded-full transition-colors ${i < sent ? "bg-marigold" : "bg-line"}`}
          />
        ))}
      </div>
      <span className="tnum text-xs text-ink-2">
        {left === 1 ? "1 message left" : `${left} messages left`}
      </span>
    </div>
  );
}

export function Chat({ userId }: { userId: string }) {
  const base = `/api/users/${encodeURIComponent(userId)}/chat`;
  const [messages, setMessages] = useState<Message[]>([]);
  const [sent, setSent] = useState(0);
  const [limit, setLimit] = useState(MAX_MESSAGES);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    fetchChat(base)
      .then((state) => {
        if (!live) return;
        setMessages(state.messages);
        setSent(state.sent);
        setLimit(state.limit);
      })
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [base]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, tool]);

  const full = sent >= limit;
  const problem = draft.trim() ? messageProblem(draft) : null;

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (busy || full || messageProblem(text)) return;
    const replyId = `reply-${Date.now()}`;
    setDraft("");
    setError("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      { id: `mine-${Date.now()}`, role: "user", content: text },
      { id: replyId, role: "assistant", content: "" },
    ]);
    const appendReply = (delta: string) =>
      setMessages((m) => m.map((msg) => (msg.id === replyId ? { ...msg, content: msg.content + delta } : msg)));

    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 409) setSent(limit);
        setMessages((m) => m.slice(0, -2));
        setDraft(text);
        throw new Error(body.error ?? "Your message wasn’t sent. Try again.");
      }
      setSent((n) => n + 1);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const { events, rest } = readFrames(buffer + value);
        buffer = rest;
        for (const event of events) {
          if (event.type === "delta") {
            setTool("");
            appendReply(event.text);
          } else if (event.type === "tool") setTool(event.name);
          else if (event.type === "tool_done") setTool("");
          else if (event.type === "error") throw new Error(event.error);
        }
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The reply was cut off. Send your message again.");
    } finally {
      setTool("");
      setBusy(false);
    }
  }

  async function clear() {
    if (busy || !confirm("Clear this chat? The conversation will be deleted and your 25 messages reset.")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(base, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
      setMessages([]);
      setSent(0);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The chat wasn’t cleared. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function start(text: string) {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  const empty = !loading && messages.length === 0;

  return (
    <section
      aria-label="Matchmaker chat"
      className="flex min-h-[75vh] flex-col overflow-hidden rounded-[28px] bg-card shadow-panel lg:min-h-0"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-4 sm:px-7">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">Matchmaker</h2>
          <p className="text-sm text-ink-2">Post a job, or ask who&rsquo;s worth meeting.</p>
        </div>
        <div className="flex items-center gap-5">
          <Meter sent={sent} limit={limit} />
          <button
            type="button"
            onClick={clear}
            disabled={busy || (messages.length === 0 && sent === 0)}
            className="rounded-full border border-line px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:border-raspberry hover:text-raspberry disabled:pointer-events-none disabled:opacity-40"
          >
            Clear chat
          </button>
        </div>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-6 sm:px-7" aria-live="polite">
        {loading ? (
          <div className="dots flex gap-1.5 text-violet" aria-label="Loading your chat">
            <span className="size-2 rounded-full bg-current" />
            <span className="size-2 rounded-full bg-current" />
            <span className="size-2 rounded-full bg-current" />
          </div>
        ) : empty ? (
          <div className="flex h-full flex-col justify-end gap-5 pb-2">
            <p className="max-w-[20ch] font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
              What brings you to the job board?
            </p>
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => start(s.text)}
                  className="rounded-full bg-violet-soft px-4 py-2 text-sm font-medium text-violet-deep transition-colors hover:bg-violet hover:text-white"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-5">
            {messages.map((m) =>
              m.role === "user" ? (
                <li
                  key={m.id}
                  className="max-w-[80%] self-end rounded-[20px] rounded-br-md bg-violet px-4 py-2.5 whitespace-pre-wrap text-white"
                >
                  {m.content}
                </li>
              ) : (
                <li key={m.id} className="flex max-w-[92%] gap-3 self-start">
                  <span
                    aria-hidden
                    className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-marigold font-display text-sm font-bold text-ink"
                  >
                    M
                  </span>
                  <div className="min-w-0 pt-0.5">
                    {m.content && <Markdown>{m.content}</Markdown>}
                    {(!m.content || tool) &&
                      busy &&
                      m.id === messages[messages.length - 1].id && (
                        <span className="flex items-center gap-2 text-sm text-ink-2">
                          <span className="dots flex gap-1 text-violet">
                            <span className="size-1.5 rounded-full bg-current" />
                            <span className="size-1.5 rounded-full bg-current" />
                            <span className="size-1.5 rounded-full bg-current" />
                          </span>
                          {tool ? "Searching" : "Thinking"}
                        </span>
                      )}
                  </div>
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      <div className="border-t border-line px-5 py-4 sm:px-7">
        {error && (
          <p role="alert" className="mx-auto mb-3 max-w-3xl text-sm text-raspberry">
            {error}
          </p>
        )}
        {full ? (
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-2xl bg-marigold-soft px-5 py-4">
            <p className="text-sm">
              You&rsquo;ve used all {limit} messages in this chat. Clear it to start a new one.
            </p>
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-violet-deep disabled:opacity-50"
            >
              Clear chat
            </button>
          </div>
        ) : (
          <form onSubmit={send} className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-[22px] border-2 border-transparent bg-paper p-1.5 pl-4 transition-colors focus-within:border-violet">
              <label htmlFor="chat-box" className="sr-only">
                Message the matchmaker
              </label>
              <textarea
                ref={box}
                id="chat-box"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="Describe a role, or who you’re looking for"
                aria-invalid={!!problem}
                className="max-h-48 flex-1 resize-none bg-transparent py-2 outline-none placeholder:text-ink-2/70 focus-visible:outline-none"
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={busy || !draft.trim() || !!problem}
                className="grid size-11 shrink-0 place-items-center rounded-full bg-violet text-white transition-colors hover:bg-violet-deep disabled:bg-line disabled:text-ink-2"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                  <path d="M9 15V3M4 8l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <p className={`mt-2 px-1 text-xs ${problem ? "text-raspberry" : "text-ink-2"}`}>
              {problem ?? "Enter to send, Shift + Enter for a new line"}
            </p>
          </form>
        )}
      </div>
    </section>
  );
}
