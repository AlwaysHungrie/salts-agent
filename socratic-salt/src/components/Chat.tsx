"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { AlertCircle, MessagesSquare, RotateCcw, Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bubble, Thinking, toUIMessages } from "./Messages";
import { identityHeaders } from "@/lib/identity";
import { MAX_MESSAGE, type ChatUIMessage } from "@/lib/chat";
import type { StoredMessage } from "@/lib/challenges";
import { latestStance } from "@/lib/stance";
import { useSetStance } from "./Stance";

export function Chat({
  challengeId,
  name,
  initial,
  openers,
}: {
  challengeId: string;
  name: string;
  initial: StoredMessage[];
  openers: string[];
}) {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const initialMessages = useMemo(() => toUIMessages(initial), [initial]);
  const lastReply = initial.at(-1)?.role === "assistant" ? initial.at(-1)!.id : "";

  const { messages, setMessages, sendMessage, regenerate, stop, status, error, clearError } =
    useChat<ChatUIMessage>({
      id: challengeId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: `/api/c/${challengeId}/chat`,
        // Read at send time, as in frontend/, so the local back door works here too.
        headers: identityHeaders,
        // The Worker keeps the transcript; only the new message travels.
        prepareSendMessagesRequest: ({ messages, trigger }) => {
          const last = [...messages].reverse().find((m) => m.role === "user");
          const message =
            last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
          return { body: { message, retry: trigger === "regenerate-message" } };
        },
        prepareReconnectToStreamRequest: ({ api }) => ({
          api: `${api}?has=${encodeURIComponent(lastReply)}`,
          headers: identityHeaders(),
        }),
      }),
      resume: initial.length > 0,
    });

  const busy = status === "streaming" || status === "submitted";
  const setStance = useSetStance();

  // Once a reply has landed, the brief pane shows where the debate now stands.
  useEffect(() => {
    if (busy) return;
    const replies = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    setStance(latestStance(replies));
  }, [messages, busy, setStance]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function send() {
    const text = draft.trim();
    if (!text || busy) return;
    clearError();
    setDraft("");
    void sendMessage({ text });
  }

  async function startOver() {
    if (!confirm("Start a new conversation? This one will be deleted.")) return;
    stop();
    await fetch(`/api/c/${challengeId}/session`, { method: "DELETE", headers: identityHeaders() });
    clearError();
    setMessages([]);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline-soft flex h-12 shrink-0 items-center gap-2 border-b px-4 md:px-8">
        <MessagesSquare className="text-muted size-4" strokeWidth={1.75} />
        <p className="min-w-0 truncate text-sm font-semibold">Discussion with {name}</p>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={startOver}
            className="border-hairline text-muted hover:text-ink hover:bg-canvas-soft ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition"
          >
            <RotateCcw className="size-3.5" /> Start over
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {messages.length === 0 ? (
          <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center py-6">
            <h2 className="text-[28px] leading-[1.15] font-[650] tracking-[-0.02em]">
              Work out the decision together.
            </h2>
            <p className="text-muted mt-3 text-base leading-[1.5] font-light">
              {name} was set up to argue one side of the decision in the brief. Test it. It
              concedes what is true, shows where things stand after every reply, and changes its
              recommendation when your case outweighs its own.
            </p>
            <ol className="mt-6 space-y-3 text-[15px] leading-[1.45]">
              {[
                "Make one argument per message.",
                "Bring what it cannot know: customer conversations, plans, decisions. It takes them as true.",
                "Ask for a conclusion whenever you are ready.",
              ].map((step, i) => (
                <li key={step} className="flex gap-3">
                  <span className="bg-canvas-soft grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-faint mt-5 text-[13px]">
              The person who set up this challenge can read this conversation.
            </p>
            {openers.length > 0 && (
              <div className="mt-8 space-y-2">
                <p className="text-muted text-xs font-semibold tracking-[0.08em] uppercase">
                  Ways to start
                </p>
                {openers.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => {
                      setDraft(o);
                      box.current?.focus();
                    }}
                    className="bg-canvas-soft hover:bg-canvas-soft/60 w-full rounded-2xl px-5 py-4 text-left text-[15px] leading-[1.4] transition"
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.map((m, i) => (
              <Bubble
                key={m.id}
                message={m}
                pending={busy && i === messages.length - 1 && m.role === "assistant"}
              />
            ))}
            {status === "submitted" && messages.at(-1)?.role === "user" && (
              <div className="flex justify-start">
                <div className="border-hairline-soft rounded-3xl border px-6 py-5">
                  <Thinking />
                </div>
              </div>
            )}
            {error && (
              <div className="flex justify-center">
                <div className="border-hairline-soft text-muted flex max-w-md items-center gap-2.5 rounded-full border px-4 py-2 text-[13px] leading-[1.35]">
                  <AlertCircle className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0">{error.message || "Something went wrong."}</span>
                  <button
                    type="button"
                    onClick={() => void regenerate()}
                    className="text-ink shrink-0 font-semibold"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form
        className="shrink-0 px-4 pt-2 pb-4 md:px-8 md:pb-6"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2 md:gap-3">
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            maxLength={MAX_MESSAGE}
            placeholder="Your argument…"
            aria-label="Your argument"
            className="bg-field placeholder:text-faint text-ink focus:ring-ink field-sizing-content max-h-48 min-h-12 min-w-0 flex-1 resize-none rounded-2xl px-4 py-3 text-base leading-[1.4] outline-none focus:ring-2"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="border-hairline text-ink hover:bg-canvas-soft flex h-12 shrink-0 items-center gap-2 rounded-full border px-5 text-base font-semibold transition"
            >
              <Square className="size-3.5 fill-current" /> <span className="hidden md:inline">Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className="bg-ink text-on-primary h-12 min-w-12 shrink-0 rounded-full text-base font-semibold transition hover:opacity-85 disabled:opacity-30"
            >
              <span className="hidden px-6 md:block">Send</span>
              <span className="flex w-12 items-center justify-center md:hidden">
                <Send className="size-[18px]" />
              </span>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
