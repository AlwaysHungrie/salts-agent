"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import type { ChatUIMessage, MetaData } from "@/app/api/sessions/[id]/chat/route";
import type { StoredMessage, TranscriptPage } from "@/lib/agent";
import { identityHeaders } from "@/lib/identity";
import { Bubble } from "./chat/Bubble";
import { ChannelFooter, type ContinueAt } from "./chat/ChannelFooter";
import { Composer } from "./chat/Composer";
import { SystemNotice, Thinking } from "./chat/MessageParts";
import { forkAt, toUIMessages } from "./chat/transcript";
import { useComposerLimits } from "./chat/useComposerLimits";
import { useRecorder } from "./chat/useRecorder";
import { useTranscriptScroll } from "./chat/useTranscriptScroll";
import { useUploads } from "./chat/useUploads";

export function Chat({
  sessionId,
  initialMessages,
  initialHasOlder = false,
  initialOffset = 0,
  onLoadOlder,
  onTurnEnd,
  onFork,
  initialInput = "",
  continueAt = null,
}: {
  sessionId: string;
  /** The newest page of the transcript. Older ones are fetched as it is scrolled. */
  initialMessages: StoredMessage[];
  /** Whether anything precedes `initialMessages`. */
  initialHasOlder?: boolean;
  /** How many messages precede `initialMessages` in the full transcript. */
  initialOffset?: number;
  /** The page before the oldest message held, or null when it cannot be read. */
  onLoadOlder?: (beforeId: string) => Promise<TranscriptPage | null>;
  onTurnEnd: () => void;
  /**
   * Branch the conversation: the first `count` messages (counted from the start of the
   * whole transcript) become a new session, and `draft` is the dropped question.
   */
  onFork: (count: number, draft: string) => void;
  /** Text the composer opens with — a forked question waiting to be re-asked. */
  initialInput?: string;
  /** A conversation that lives on a chat channel: readable here, answered there. */
  continueAt?: ContinueAt | null;
}) {
  const [input, setInput] = useState(initialInput);
  const { ready, limits } = useComposerLimits(sessionId);
  const uploads = useUploads(sessionId, limits);
  const recorder = useRecorder({
    limits,
    upload: uploads.upload,
    setUploadError: uploads.setUploadError,
  });
  // A streamed message has no stored timestamp, so its arrival time is recorded once.
  // A plain map, not state: writing it must not cause a render.
  const [seen] = useState(() => new Map<string, number>());
  /** Held while a send is in flight, so a second Return finds the door shut. */
  const sending = useRef(false);

  // What the reconnect names, so the agent knows whether a turn finished meanwhile.
  const lastReply =
    initialMessages[initialMessages.length - 1]?.role === "assistant"
      ? String(initialMessages[initialMessages.length - 1].id)
      : "";

  const { messages, setMessages, sendMessage, regenerate, stop, status, error } =
    useChat<ChatUIMessage>({
      id: sessionId,
      messages: toUIMessages(initialMessages),
      transport: new DefaultChatTransport({
        api: `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        // Read at send time, so a change of address mid-session applies next turn.
        headers: identityHeaders,
        // Reconnecting is a GET to the same route, not to `<api>/<id>/stream`.
        prepareReconnectToStreamRequest: ({ api }) => ({
          api: `${api}?has=${encodeURIComponent(lastReply)}`,
          headers: identityHeaders(),
        }),
      }),
      // A reload does not stop the turn, so the reply is picked up where it got to.
      resume: true,
      onFinish: onTurnEnd,
    });
  const streaming = status === "streaming" || status === "submitted";

  const { bottom, scroller, olderSentinel, hasOlder, offset, loadingOlder } =
    useTranscriptScroll({
      messages,
      setMessages,
      onLoadOlder,
      initialHasOlder,
      initialOffset,
    });

  useEffect(() => {
    const now = Date.now();
    for (const m of messages) if (!seen.has(m.id)) seen.set(m.id, now);
  }, [messages, seen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (streaming) return;
    // A file still uploading belongs to this message, so the message waits for it.
    if (uploads.uploading || uploads.ghosts.length > 0) return;
    // An attachment on its own is a valid turn.
    if (!input.trim() && uploads.attachments.length === 0) return;
    // `streaming` has not flipped yet during the awaits below; the ref closes that gap.
    if (sending.current) return;
    sending.current = true;

    // Fixed at the moment of sending, not whatever the composer holds later.
    const text = input;
    const files = uploads.attachments;
    setInput("");
    uploads.setAttachments([]);
    uploads.setUploadError(null);

    try {
      // The Worker sends every file it holds, so strays must go before the message.
      await uploads.reconcileIfNeeded(files.map((a) => a.id));
      // The files ride along only so the sent bubble can draw them at once.
      sendMessage({
        role: "user",
        parts: [
          ...(files.length
            ? [{ type: "data-files" as const, data: { attachments: files } }]
            : []),
          { type: "text" as const, text },
        ],
      });
    } finally {
      sending.current = false;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="flex-1 space-y-6 overflow-y-auto px-4 py-6 md:px-8 md:py-10"
      >
        {hasOlder && (
          <div
            ref={olderSentinel}
            className="text-faint py-2 text-center text-xs leading-[1.33]"
          >
            {loadingOlder ? "Loading earlier messages…" : ""}
          </div>
        )}
        {messages.length === 0 && (
          <p className="text-muted mx-auto max-w-md text-center text-xl font-light leading-[1.38]">
            Session Connected. Send a message.
          </p>
        )}
        {messages.map((m, i) => {
          const stored = m.parts.find((p) => p.type === "data-meta") as
            | { type: "data-meta"; data: MetaData }
            | undefined;
          const at = stored?.data.ts ?? seen.get(m.id) ?? null;
          const last = i === messages.length - 1;
          return (
            <Bubble
              key={m.id}
              message={m}
              sessionId={sessionId}
              at={streaming && last ? null : at}
              pending={streaming && last && m.role === "assistant"}
              // A fork replays everything before the question; the question returns
              // to the composer, ready to be edited.
              onFork={
                m.role === "assistant" && !streaming
                  ? () => onFork(...forkAt(messages, i, offset))
                  : undefined
              }
              onRetry={
                m.role === "assistant" && last && !streaming
                  ? () => void regenerate()
                  : undefined
              }
            />
          );
        })}
        {/* The reply has been asked for but the assistant message has not arrived yet. */}
        {streaming && messages[messages.length - 1]?.role === "user" && (
          <div className="flex justify-start">
            <div className="bg-canvas border-hairline-soft rounded-3xl border px-6 py-5">
              <Thinking />
            </div>
          </div>
        )}
        {error && <SystemNotice text={error.message} />}
        <div ref={bottom} />
      </div>

      {continueAt ? (
        <ChannelFooter continueAt={continueAt} />
      ) : (
        <Composer
          sessionId={sessionId}
          ready={ready}
          limits={limits}
          uploads={uploads}
          recorder={recorder}
          input={input}
          setInput={setInput}
          streaming={streaming}
          onSubmit={(e) => void submit(e)}
          onStop={() => {
            stop();
            onTurnEnd();
          }}
        />
      )}
    </div>
  );
}
