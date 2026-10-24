"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { messageProblem } from "@/lib/rules";
import { readFrames } from "@/lib/sse";

type Message = { id: string; role: "user" | "assistant"; content: string };

/** Ways to open a conversation; each fills the box for the user to finish. */
const STARTERS = [
  { label: "Find someone", text: "Who here can " },
  { label: "Add me", text: "Add me to the directory. I’m " },
  { label: "My profile", text: "What does my profile say right now?" },
];

/**
 * The chat with the user's own agent. Every time it opens (and on "New chat") the server
 * starts a fresh session and deletes the last one, so the conversation lives on this page only.
 */
export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState("");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const startOver = useCallback(async () => {
    setReady(false);
    setError("");
    setMessages([]);
    try {
      // 409: the agent is being set up by another tab; wait for it rather than fail.
      for (let tries = 0; ; tries++) {
        const res = await fetch("/api/chat", { method: "PUT" });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.ok) break;
        if (res.status !== 409 || tries >= 20)
          throw new Error(body.error || "Your chat didn’t start. Refresh the page to try again.");
        await new Promise((r) => setTimeout(r, 3000));
      }
      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your chat didn’t start. Refresh the page to try again.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starting the session is the effect
    void startOver();
  }, [startOver]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, tool]);

  const problem = draft.trim() ? messageProblem(draft) : null;

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (busy || !ready || messageProblem(text)) return;
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
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessages((m) => m.slice(0, -2));
        setDraft(text);
        throw new Error(body.error ?? "Your message wasn’t sent. Try again.");
      }
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

  function start(text: string) {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  return (
    <section
      aria-label="Devcon Humans chat"
      className="flex h-[calc(100dvh-6rem)] min-h-[28rem] flex-col overflow-hidden rounded-[28px] bg-card shadow-panel"
    >
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-7 sm:py-4">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold tracking-tight">Your agent</h2>
          <p className="text-sm text-ink-2">Find people by what they do, or tell it about yourself.</p>
        </div>
        <button
          type="button"
          onClick={() => void startOver()}
          disabled={busy || !ready || messages.length === 0}
          className="shrink-0 rounded-full border border-line px-4 py-1.5 text-sm font-medium transition-colors hover:border-violet hover:text-violet-deep disabled:pointer-events-none disabled:opacity-40"
        >
          New chat
        </button>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-7" aria-live="polite">
        {!ready && !error ? (
          <div role="status" className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="dots flex gap-1.5 text-violet" aria-hidden>
              <span className="size-2.5 rounded-full bg-current" />
              <span className="size-2.5 rounded-full bg-current" />
              <span className="size-2.5 rounded-full bg-current" />
            </div>
            <p className="font-display text-2xl font-semibold tracking-tight">Getting your agent ready</p>
            <p className="max-w-[36ch] text-sm text-ink-2">
              The first time, this sets up an agent of your own. It takes a few seconds.
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-5 pb-2">
            <p className="max-w-[20ch] font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
              Who are you looking for?
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
                <li key={m.id} className="flex max-w-full gap-3 self-start sm:max-w-[92%]">
                  <span
                    aria-hidden
                    className="mt-0.5 hidden size-7 shrink-0 place-items-center rounded-full bg-marigold font-display text-sm font-bold text-ink sm:grid"
                  >
                    H
                  </span>
                  <div className="min-w-0 pt-0.5">
                    {m.content && <Markdown>{m.content}</Markdown>}
                    {(!m.content || tool) && busy && m.id === messages[messages.length - 1].id && (
                      <span className="flex items-center gap-2 text-sm text-ink-2">
                        <span className="dots flex gap-1 text-violet">
                          <span className="size-1.5 rounded-full bg-current" />
                          <span className="size-1.5 rounded-full bg-current" />
                          <span className="size-1.5 rounded-full bg-current" />
                        </span>
                        {tool ? "Looking" : "Thinking"}
                      </span>
                    )}
                  </div>
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      <div className="border-t border-line px-4 py-4 sm:px-7">
        {error && (
          <p role="alert" className="mx-auto mb-3 max-w-3xl text-sm text-raspberry">
            {error}
          </p>
        )}
        <form onSubmit={send} className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-[22px] border-2 border-transparent bg-paper p-1.5 pl-4 transition-colors focus-within:border-violet">
            <label htmlFor="chat-box" className="sr-only">
              Message your agent
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
              enterKeyHint="send"
              placeholder="Who builds AI agents? Who runs brand deals?"
              aria-invalid={!!problem}
              className="max-h-48 flex-1 resize-none bg-transparent py-2 outline-none placeholder:text-ink-2/70 focus-visible:outline-none"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={busy || !ready || !draft.trim() || !!problem}
              className="grid size-11 shrink-0 place-items-center rounded-full bg-violet text-white transition-colors hover:bg-violet-deep disabled:bg-line disabled:text-ink-2"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <path d="M9 15V3M4 8l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <p className={`mt-2 px-1 text-xs ${problem ? "text-raspberry" : "hidden text-ink-2 sm:block"}`}>
            {problem ?? "Enter to send, Shift + Enter for a new line"}
          </p>
        </form>
      </div>
    </section>
  );
}
