"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { Chat } from "@/components/Chat";
import { SessionHeader } from "@/components/SessionHeader";
import { Sidebar } from "@/components/Sidebar";
import { Welcome } from "@/components/Welcome";
import {
  telegramLink,
  whatsappLink,
  type AgentRow,
  type SessionPage,
  type SessionRow,
  type StoredMessage,
  type Summary,
  type TranscriptPage,
} from "@/lib/agent";
import { cached, forget, keys, remember } from "@/lib/cache";
import { PageNotice } from "@/components/PageNotice";

/** What `/api/agents/:id/config` answers with, as far as this page reads it. */
type ConfigPayload = {
  agent?: AgentRow;
  config?: { cap_telegram?: number; telegram_bot_username?: string };
};

/** The bot's handle, or "" while Telegram is off or unconfigured. */
function botOf(payload: ConfigPayload | undefined): string {
  return payload?.config?.cap_telegram
    ? (payload.config.telegram_bot_username ?? "")
    : "";
}

function fromPage(page: TranscriptPage) {
  return {
    messages: page.messages,
    hasOlder: page.has_more,
    offset: page.offset,
  };
}

/** Whether a fresh read says the same as the transcript on screen. */
function sameTranscript(
  shown: { messages: StoredMessage[]; offset: number },
  page: TranscriptPage,
): boolean {
  const a = shown.messages;
  const b = page.messages;
  return (
    a.length === b.length &&
    shown.offset === page.offset &&
    String(a[a.length - 1]?.id) === String(b[b.length - 1]?.id)
  );
}

/**
 * One agent: its sessions, its settings, its bot. Everything on this page is scoped
 * to the agent in the URL — there is no way to reach another agent's anything from
 * here, which is the point of the split.
 */
export default function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  // Everything below starts from what was last read for this agent, so coming back
  // from capabilities or settings redraws the page as it was instead of from empty.
  const held = cached<ConfigPayload>(keys.config(agentId));
  const heldSessions = cached<{
    sessions: SessionRow[];
    cursor: string;
    more: boolean;
  }>(keys.sessions(agentId));
  const heldSelected = cached<string | null>(keys.selected(agentId)) ?? null;
  const [agent, setAgent] = useState<AgentRow | null>(held?.agent ?? null);
  /** No agent behind this id, for any of the three reasons a 404 covers. */
  const [missing, setMissing] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>(
    heldSessions?.sessions ?? [],
  );
  /**
   * Where the session list has been read up to: the cursor for the next page, and
   * whether there is one. Empty cursor with `more` false means the list is whole.
   */
  const [sessionCursor, setSessionCursor] = useState<{
    cursor: string;
    more: boolean;
  }>({
    cursor: heldSessions?.cursor ?? "",
    more: heldSessions?.more ?? false,
  });
  const [selected, setSelected] = useState<string | null>(heldSelected);
  // Keyed by session so switching sessions shows a loader instead of the previous
  // session's transcript, without having to null it out on every selection change.
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    messages: StoredMessage[];
    /** Whether older messages remain unread behind the ones held here. */
    hasOlder: boolean;
    /** How many messages precede the oldest one held. A fork's count is absolute. */
    offset: number;
    /**
     * Bumped when a fresh read replaces a transcript drawn from the cache, so the
     * chat restarts from the fresh one — it only reads its messages on mount.
     */
    rev: number;
  } | null>(() => {
    const transcript = heldSelected
      ? cached<TranscriptPage>(keys.transcript(heldSelected))
      : undefined;
    return heldSelected && transcript
      ? { sessionId: heldSelected, ...fromPage(transcript), rev: 0 }
      : null;
  });
  const [summary, setSummary] = useState<Summary | null>(() =>
    heldSelected ? (cached<Summary>(keys.summary(heldSelected)) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * The bot's handle, so a Telegram session can link back to the conversation — and
   * so the zero state can offer Telegram only once it actually works. Empty while
   * the capability is off or unconfigured.
   */
  const [botUsername, setBotUsername] = useState(() => botOf(held));
  /** A forked question handed to one session's composer, waiting to be edited. */
  const [draft, setDraft] = useState<{
    sessionId: string;
    text: string;
  } | null>(null);
  /** Whether the sidebar drawer is showing. Only used below the md breakpoint. */
  /**
   * Whether the drawer is showing. Only means anything below the md breakpoint,
   * where the sidebar is a drawer over the page rather than a column beside it.
   *
   * Open to begin with: this page opens on the welcome screen with no session
   * selected, and the sessions are what there is to do here. Landing on a phone with
   * the list hidden behind a button makes an agent that has been used for months
   * look like one that has never been used at all.
   */
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /** Reads a proxy response, surfacing the Worker-unreachable message as an error. */
  const readJson = useCallback(async <T,>(res: Response): Promise<T | null> => {
    const payload = (await res.json().catch(() => null)) as
      | (T & { error?: string })
      | null;
    if (!res.ok || !payload) {
      setError(payload?.error ?? `Request failed with ${res.status}.`);
      return null;
    }
    setError(null);
    return payload;
  }, []);

  // Read once: the agent's name for the sidebar, and the bot handle for the links.
  useEffect(() => {
    void fetch(`/api/agents/${encodeURIComponent(agentId)}/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: ConfigPayload | null) => {
        // No agent behind this id: it was deleted, the link is stale, or it belongs
        // to somebody else — the Worker answers all three with a 404, on purpose, so
        // that an id cannot be probed for existence. The page says so and stays put.
        if (!payload) {
          forget(keys.config(agentId));
          setMissing(true);
          return;
        }
        remember(keys.config(agentId), payload);
        setAgent(payload.agent ?? null);
        setBotUsername(botOf(payload));
      })
      .catch(() => setBotUsername(""));
  }, [agentId]);

  // Kept current as the page changes them, so the next visit starts from here.
  useEffect(() => {
    remember(keys.sessions(agentId), {
      sessions,
      cursor: sessionCursor.cursor,
      more: sessionCursor.more,
    });
  }, [agentId, sessions, sessionCursor]);

  useEffect(() => {
    remember(keys.selected(agentId), selected);
  }, [agentId, selected]);

  /**
   * The newest page of sessions, replacing whatever was held.
   *
   * Called after anything that reorders the list — a new session, a rename, the end
   * of a turn — so it deliberately drops pages that were scrolled into: keeping them
   * across a reorder would show rows twice. The scroll starts again from the top,
   * which is where the list has just changed anyway.
   */
  const loadSessions = useCallback(async () => {
    const payload = await readJson<SessionPage>(
      await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/sessions`,
      ),
    );
    setSessions(payload?.sessions ?? []);
    setSessionCursor({
      cursor: payload?.cursor ?? "",
      more: payload?.has_more ?? false,
    });
    return payload?.sessions ?? [];
  }, [readJson, agentId]);

  /** The page after the one the sidebar is showing, appended to it. */
  const loadMoreSessions = useCallback(async () => {
    if (!sessionCursor.more || !sessionCursor.cursor) return;
    const payload = await readJson<SessionPage>(
      await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/sessions` +
          `?cursor=${encodeURIComponent(sessionCursor.cursor)}`,
      ),
    );
    if (!payload) return;
    // A session touched between the two reads can arrive on both pages; keying by id
    // keeps the first copy rather than drawing it twice.
    setSessions((current) => {
      const seen = new Set(current.map((s) => s.id));
      return [...current, ...payload.sessions.filter((s) => !seen.has(s.id))];
    });
    setSessionCursor({ cursor: payload.cursor, more: payload.has_more });
  }, [readJson, agentId, sessionCursor]);

  const loadSummary = useCallback(
    async (id: string) => {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/summary`,
      );
      const payload = await readJson<Summary>(res);
      if (payload) remember(keys.summary(id), payload);
      setSummary(payload);
    },
    [readJson],
  );

  // The list, and only the list. Opening the page used to open the newest session with
  // it, which wakes that session's Durable Object and reconnects its stream for
  // somebody who may only have come to read the sidebar. Choosing a session is now
  // something you do.
  useEffect(() => {
    void (async () => {
      await loadSessions();
    })();
  }, [loadSessions]);

  // Loading history and metrics is what makes a session's Durable Object wake up.
  // A session read before opens from that read at once; the fresh one replaces it
  // only if the conversation moved on in between.
  useEffect(() => {
    if (!selected) return;
    const heldTranscript = cached<TranscriptPage>(keys.transcript(selected));
    void (async () => {
      if (heldTranscript) {
        setLoaded((current) =>
          current?.sessionId === selected
            ? current
            : { sessionId: selected, ...fromPage(heldTranscript), rev: 0 },
        );
        setSummary(cached<Summary>(keys.summary(selected)) ?? null);
      }
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(selected)}/messages`,
      );
      const payload = await readJson<TranscriptPage>(res);
      if (!payload) return;
      remember(keys.transcript(selected), payload);
      setLoaded((current) => {
        if (current?.sessionId === selected && sameTranscript(current, payload)) {
          return current;
        }
        return {
          sessionId: selected,
          ...fromPage(payload),
          rev: current?.sessionId === selected ? current.rev + 1 : 0,
        };
      });
      await loadSummary(selected);
    })();
  }, [selected, loadSummary, readJson]);

  /**
   * The window of transcript before `beforeId`, handed to the chat to prepend. The
   * page owns the fetch so the chat does not have to know the route; the chat owns
   * where the messages land, because it is the one holding them.
   */
  const loadOlderMessages = useCallback(
    async (beforeId: string): Promise<TranscriptPage | null> => {
      if (!selected) return null;
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(selected)}/messages` +
          `?before=${encodeURIComponent(beforeId)}`,
      );
      return await readJson<TranscriptPage>(res);
    },
    [selected, readJson],
  );

  const createSession = async () => {
    // No title: the session is called "New session" until the agent names it from
    // the first exchange.
    const res = await fetch(
      `/api/agents/${encodeURIComponent(agentId)}/sessions`,
      { method: "POST" },
    );
    const row = await readJson<SessionRow>(res);
    if (!row) return;
    // The row the Worker just created is the whole story for the list's new top
    // entry — reloading the page to get it back is a second round trip for
    // nothing the response didn't already say.
    setSessions((current) => [row, ...current]);
    setSelected(row.id);
  };

  /**
   * Branch a conversation: the first `count` messages are copied into a fresh
   * session, which then opens. The original is left exactly as it was.
   */
  const forkSession = async (id: string, count: number, draft: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count }),
    });
    const row = await readJson<SessionRow>(res);
    if (!row) return;
    await loadSessions();
    // The question the fork dropped waits in the new session's composer.
    setDraft(draft ? { sessionId: row.id, text: draft } : null);
    setSelected(row.id);
  };

  /**
   * After a change already drawn: read the list back so it matches what is stored,
   * and when the change was refused, say why. The error is set after the reload,
   * which would otherwise clear it.
   */
  const settle = async (res: Response, fallback: string) => {
    const payload = res.ok
      ? null
      : ((await res.json().catch(() => null)) as { error?: string } | null);
    await loadSessions();
    if (!res.ok) setError(payload?.error ?? fallback);
  };

  /**
   * Rename a session in place. The row takes the new title at once; the list is read
   * again behind it, and a refused rename puts the stored title back.
   */
  const renameSession = async (id: string, title: string) => {
    setSessions((current) =>
      current.map((s) => (s.id === id ? { ...s, title } : s)),
    );
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    await settle(res, "Couldn't rename that session. Try again.");
  };

  /**
   * Gone from the list the moment it is confirmed. A refused delete reads the list
   * back, which returns the row along with the reason.
   */
  const deleteSession = async (id: string) => {
    const rest = sessions.filter((s) => s.id !== id);
    setSessions(rest);
    if (selected === id) setSelected(rest[0]?.id ?? null);
    forget(keys.transcript(id));
    forget(keys.summary(id));
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) await settle(res, "Couldn't delete that session. Try again.");
  };

  const onTurnEnd = useCallback(() => {
    if (selected) loadSummary(selected);
    loadSessions();
  }, [selected, loadSummary, loadSessions]);

  const current = sessions.find((s) => s.id === selected) ?? null;

  if (missing) {
    return <PageNotice message="This agent doesn't exist, or isn't yours to open." />;
  }

  return (
    <div className="bg-canvas text-ink flex h-[100dvh]">
      <Sidebar
        agentId={agentId}
        agentName={agent?.name ?? ""}
        fleetName={agent?.fleet_name ?? ""}
        sessions={sessions}
        hasMore={sessionCursor.more}
        onLoadMore={loadMoreSessions}
        selected={selected}
        onSelect={setSelected}
        onCreate={createSession}
        onDelete={deleteSession}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onHome={() => setSelected(null)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="bg-canvas-soft text-ink border-hairline-soft border-b px-5 py-4 text-sm md:px-8 leading-[1.43]">
            {error}
          </div>
        )}
        {selected ? (
          <>
            <SessionHeader
              title={current?.title ?? "New session"}
              createdAt={current?.created_at ?? null}
              summary={summary}
              onRename={(title) => renameSession(selected, title)}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
            {loaded?.sessionId !== selected ? (
              <div className="text-muted flex flex-1 items-center justify-center text-xl font-light mb-16">
                Connecting Session…
              </div>
            ) : (
              <Chat
                key={`${selected}:${loaded.rev}`}
                sessionId={selected}
                initialMessages={loaded.messages}
                initialHasOlder={loaded.hasOlder}
                initialOffset={loaded.offset}
                onLoadOlder={loadOlderMessages}
                onTurnEnd={onTurnEnd}
                initialInput={draft?.sessionId === selected ? draft.text : ""}
                onFork={(count, text) =>
                  void forkSession(selected, count, text)
                }
                // A chat that lives on another platform is read here and answered
                // there: the composer would send into a conversation this page is not
                // the right end of.
                continueAt={
                  current?.source === "telegram"
                    ? {
                        label: "Telegram",
                        href: telegramLink(current, botUsername),
                        channel: "telegram" as const,
                      }
                    : current?.source === "whatsapp" && whatsappLink(current)
                      ? {
                          label: "WhatsApp",
                          href: whatsappLink(current),
                          channel: "whatsapp" as const,
                        }
                      : null
                }
              />
            )}
          </>
        ) : (
          <>
            {/* With no session there is no header, so the drawer needs its own way open. */}
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sessions"
              className="text-ink hover:bg-canvas-soft m-3 flex h-9 w-9 items-center justify-center rounded-full transition md:hidden"
            >
              <Menu size={20} strokeWidth={1.75} />
            </button>
            <Welcome
              agentId={agentId}
              agentName={agent?.name ?? ""}
              onCreate={() => void createSession()}
              botUsername={botUsername}
            />
          </>
        )}
      </main>
    </div>
  );
}
