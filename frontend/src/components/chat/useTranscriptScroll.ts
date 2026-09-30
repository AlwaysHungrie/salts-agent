import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatUIMessage } from "@/app/api/sessions/[id]/chat/route";
import type { TranscriptPage } from "@/lib/agent";
import { toUIMessages } from "./transcript";

/**
 * Follow new messages to the bottom, and load older pages when the top is reached. A
 * prepend holds `scrollHeight - scrollTop` so the reader's place stays put.
 */
export function useTranscriptScroll({
  messages,
  setMessages,
  onLoadOlder,
  initialHasOlder,
  initialOffset,
}: {
  messages: ChatUIMessage[];
  setMessages: (update: (current: ChatUIMessage[]) => ChatUIMessage[]) => void;
  onLoadOlder?: (beforeId: string) => Promise<TranscriptPage | null>;
  initialHasOlder: boolean;
  initialOffset: number;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const olderSentinel = useRef<HTMLDivElement>(null);
  /** Whether more transcript sits behind the oldest message drawn. */
  const [hasOlder, setHasOlder] = useState(initialHasOlder);
  /** How many messages precede the oldest one held — what a fork's count is offset by. */
  const [offset, setOffset] = useState(initialOffset);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Set while older messages are spliced in, so the follow effect skips that change. */
  const prepending = useRef(false);

  useEffect(() => {
    if (prepending.current) {
      prepending.current = false;
      return;
    }
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadOlder = useCallback(async () => {
    const box = scroller.current;
    const oldest = messages[0];
    if (!onLoadOlder || !oldest || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      const page = await onLoadOlder(String(oldest.id));
      if (!page) return;
      const fromBottom = box ? box.scrollHeight - box.scrollTop : 0;
      prepending.current = true;
      // A turn that landed between the two reads can shift the window; ids already
      // drawn are skipped so no key is duplicated.
      setMessages((current) => {
        const held = new Set(current.map((m) => m.id));
        const older = toUIMessages(page.messages).filter((m) => !held.has(m.id));
        return [...older, ...current];
      });
      setHasOlder(page.has_more);
      setOffset(page.offset);
      if (box) {
        // After paint, so the new height is the one being corrected against.
        requestAnimationFrame(() => {
          box.scrollTop = box.scrollHeight - fromBottom;
        });
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [onLoadOlder, messages, loadingOlder, hasOlder, setMessages]);

  useEffect(() => {
    const node = olderSentinel.current;
    if (!node || !hasOlder) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadOlder();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder]);

  return { bottom, scroller, olderSentinel, hasOlder, offset, loadingOlder };
}
