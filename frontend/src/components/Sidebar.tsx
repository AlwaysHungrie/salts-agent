"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  Home,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { SessionRow } from "@/lib/agent";
import { formatDate } from "@/lib/format";

/** How long typing has to settle before the list is filtered. */
const SEARCH_DEBOUNCE_MS = 200;
/** How long a row has to be held before it starts a selection. */
const LONG_PRESS_MS = 500;
/** Past this much movement a held row is being scrolled, not pressed. */
const PRESS_SLOP = 8;

export function Sidebar({
  agentId,
  agentName,
  fleetName = "",
  sessions,
  hasMore,
  onLoadMore,
  selected,
  onSelect,
  onCreate,
  onDelete,
  open,
  onClose,
  onHome,
}: {
  /** The agent these sessions belong to. Every link out of here is scoped to it. */
  agentId: string;
  agentName: string;
  /**
   * The fleet this agent belongs to, or "" when it stands alone. Shown under the
   * name, in place of the address of whoever is reading it: they know their own
   * address, and what they may not know is whose fleet this agent came from.
   */
  fleetName?: string;
  sessions: SessionRow[];
  /** Whether older sessions remain unread behind the ones drawn. */
  hasMore: boolean;
  /** Append the next page. Called when the list is scrolled to its end. */
  onLoadMore: () => Promise<void>;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Delete these sessions. One from a row's ×, several from a selection. */
  onDelete: (ids: string[]) => void;
  /** Whether the drawer is showing. Only meaningful below the md breakpoint. */
  open: boolean;
  onClose: () => void;
  /** Close the open session and show the welcome screen. */
  onHome: () => void;
}) {
  const [busy, setBusy] = useState(false);
  /** Whether the pointer is over the fleet band. Nothing on a touch screen. */
  const [bandHover, setBandHover] = useState(false);
  /** Whether a tap has left the band scrolling. The touch answer to hovering. */
  const [bandTapped, setBandTapped] = useState(false);
  /** A page request in flight, so a fast scroll asks for the next page once. */
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  /** The sessions the delete dialog is asking about, if it is open. */
  const [confirming, setConfirming] = useState<SessionRow[] | null>(null);
  /**
   * The sessions picked for deleting together, or null outside selection mode. A long
   * press on a row starts it; Done or Escape ends it.
   */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  /** The press being timed, and whether it already fired, so its click is not a pick. */
  const press = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const longPressed = useRef(false);
  // Filtering trails the keystrokes, so a fast typist re-renders the list once
  // rather than once per character.
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Fetch the next page when the end of the list comes into view. Search filters
   * only what has been loaded, so paging keeps running while a query is typed —
   * otherwise a match further down the list could never be reached.
   */
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || loadingMore) return;
      setLoadingMore(true);
      void onLoadMore().finally(() => setLoadingMore(false));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  // A destructive dialog has to be as easy to leave as to open, and so does a
  // selection: Escape closes the dialog first, then ends the selection.
  useEffect(() => {
    if (!confirming && !picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirming) setConfirming(null);
      else setPicked(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, picked]);

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  /** Start timing a hold on a row; held long enough, it starts a selection with it. */
  const startPress = (id: string, e: React.PointerEvent) => {
    // A mouse holds with its main button only; a right click is not a long press.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cancelPress();
    longPressed.current = false;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        press.current = null;
        longPressed.current = true;
        setPicked((current) => new Set(current ?? []).add(id));
        // A short buzz where there is a motor for it, so the hold is felt as well as seen.
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS),
    };
  };

  const movePress = (e: React.PointerEvent) => {
    const held = press.current;
    if (!held) return;
    if (Math.hypot(e.clientX - held.x, e.clientY - held.y) > PRESS_SLOP)
      cancelPress();
  };

  const visible = useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(needle));
  }, [sessions, debounced]);

  return (
    <>
      {/* On a phone the sidebar is a drawer, so the page behind it needs a way out. */}
      {open && (
        <button
          onClick={onClose}
          aria-label="Close sessions"
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}

      <aside
        className={`border-hairline-soft bg-canvas fixed inset-y-0 left-0 z-40 flex h-full w-72 max-w-[85vw] shrink-0 flex-col border-r transition-transform md:static md:z-auto md:max-w-none md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* A fleet agent is somebody else's: they pay for it, they decide what it
            can do, and they can take it away. That is worth saying on every screen
            it appears on rather than once at handover — so it is a band, in the one
            accent this design has, and it moves. */}
        {fleetName && (
          /* Still by default, and moving only while it is pointed at — or, where
             there is no pointer, while it is left switched on by a tap. The line
             is readable either way; the scroll is for reading past its end. */
          <div
            onMouseEnter={() => setBandHover(true)}
            onMouseLeave={() => setBandHover(false)}
            onClick={() => setBandTapped((on) => !on)}
            className="bg-accent text-on-primary shrink-0 overflow-hidden py-1.5"
          >
            <div
              className={`marquee flex w-max whitespace-nowrap will-change-transform ${
                bandHover || bandTapped ? "marquee-run" : ""
              }`}
            >
              {/* Two copies, so the loop has no seam to jump. The second is hidden
                  from a screen reader, which would otherwise read the line twice. */}
              {[false, true].map((copy) => (
                <span
                  key={String(copy)}
                  aria-hidden={copy || undefined}
                  className="px-6 text-[11px] font-medium leading-[1.33]"
                >
                  This agent is part of {fleetName}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            {/* The way out of this agent entirely. First thing in the corner,
                because leaving is the one move that is not about this agent. */}
            <Link
              href="/"
              title="All agents"
              aria-label="All agents"
              className="border-hairline bg-canvas text-ink hover:bg-canvas-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition"
            >
              <Home size={16} strokeWidth={1.75} />
            </Link>
            <div className="min-w-0">
              <button
                onClick={() => {
                  onHome();
                  onClose();
                }}
                title={`${agentName || "Agent"} home`}
                className="block w-full min-w-0 text-left"
              >
                <div className="truncate text-2xl font-[650] leading-tight">
                  {agentName || "Agent"}
                </div>
                {fleetName && (
                  <div className="text-muted text-sm font-light leading-[1.43]">
                    {fleetName}
                  </div>
                )}
              </button>
              {!fleetName && (
                <a
                  href="/guide"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted hover:text-ink text-sm font-light leading-[1.43] underline underline-offset-2 transition"
                >
                  User guide
                </a>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close sessions"
            className="text-muted hover:bg-canvas-soft hover:text-ink flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition md:hidden"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="bg-field flex h-10 items-center gap-2 rounded-2xl px-3">
            <Search
              size={16}
              strokeWidth={1.75}
              className="text-faint shrink-0"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions"
              aria-label="Search sessions"
              className="placeholder:text-faint text-ink min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-muted hover:text-ink flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-20">
          {sessions.length === 0 && (
            <p className="text-muted px-2 py-10 text-center text-sm leading-[1.43]">
              No sessions yet.
            </p>
          )}
          {sessions.length > 0 && visible.length === 0 && (
            <p className="text-muted px-2 py-10 text-center text-sm leading-[1.43]">
              No sessions match “{debounced.trim()}”.
            </p>
          )}
          {visible.map((s) => {
            const isPicked = !!picked?.has(s.id);
            return (
              <div
                key={s.id}
                onPointerDown={(e) => startPress(s.id, e)}
                onPointerMove={movePress}
                onPointerUp={cancelPress}
                onPointerLeave={cancelPress}
                onPointerCancel={cancelPress}
                // A held row on a phone would otherwise open the browser's own menu.
                onContextMenu={(e) => {
                  if (longPressed.current || picked) e.preventDefault();
                }}
                className={`group flex items-center gap-2 rounded-2xl px-4 py-3 transition select-none [-webkit-touch-callout:none] ${
                  isPicked || (!picked && selected === s.id)
                    ? "bg-canvas-soft"
                    : "hover:bg-canvas-soft/60"
                }`}
              >
                <button
                  onClick={() => {
                    // The click that ends a long press is the press, not a pick.
                    if (longPressed.current) {
                      longPressed.current = false;
                      return;
                    }
                    if (picked) {
                      toggle(s.id);
                      return;
                    }
                    onSelect(s.id);
                    onClose();
                  }}
                  aria-pressed={picked ? isPicked : undefined}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-base font-semibold leading-[1.38]">
                    {s.title}
                  </div>
                  <div className="text-faint tnum truncate text-xs leading-[1.33]">
                    {formatDate(s.created_at)}
                  </div>
                </button>
                {picked ? (
                  <button
                    onClick={() => toggle(s.id)}
                    role="checkbox"
                    aria-checked={isPicked}
                    aria-label={`Select ${s.title}`}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ${
                      isPicked
                        ? "bg-ink border-ink text-on-primary"
                        : "border-hairline bg-canvas"
                    }`}
                  >
                    {isPicked && <Check size={12} strokeWidth={3} />}
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirming([s])}
                    title={`Delete ${s.title}`}
                    aria-label={`Delete ${s.title}`}
                    className="text-muted hover:bg-canvas hover:text-ink flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base leading-none opacity-100 transition md:opacity-0 md:group-hover:opacity-100"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {hasMore && (
            <div
              ref={sentinel}
              className="text-faint px-2 py-4 text-center text-xs leading-[1.33]"
            >
              {loadingMore ? "Loading…" : ""}
            </div>
          )}
        </div>

        {picked ? (
          /* In a selection the corners finish it: Done on one side, and on the other,
             where the plus was, the one thing a selection is for. */
          <>
            <button
              onClick={() => setPicked(null)}
              className="border-hairline bg-canvas text-ink hover:bg-canvas-soft absolute bottom-4 left-4 flex h-11 items-center rounded-full border px-5 text-sm font-semibold shadow-sm transition"
            >
              Done
            </button>
            <button
              onClick={() =>
                setConfirming(sessions.filter((s) => picked.has(s.id)))
              }
              disabled={picked.size === 0}
              title="Delete selected"
              aria-label={`Delete ${picked.size} selected session${picked.size === 1 ? "" : "s"}`}
              className="bg-ink text-on-primary absolute right-4 bottom-4 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition hover:opacity-85 disabled:opacity-40"
            >
              <Trash2 size={18} strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            {/* Configuring the agent on one side, adding to it on the other. Only the
              plus is filled: starting a session is what this sidebar is for, and two
              solid circles competing for that would say neither. */}
            <div className="absolute bottom-4 left-4 flex items-center gap-2">
              <Link
                href={`/a/${encodeURIComponent(agentId)}/capabilities`}
                title="Capabilities"
                aria-label="Capabilities"
                className="border-hairline bg-canvas text-ink hover:bg-canvas-soft flex h-11 w-11 items-center justify-center rounded-full border shadow-sm transition"
              >
                <SlidersHorizontal size={18} strokeWidth={1.75} />
              </Link>
              <Link
                href={`/a/${encodeURIComponent(agentId)}/settings`}
                title="Settings"
                aria-label="Settings"
                className="border-hairline bg-canvas text-ink hover:bg-canvas-soft flex h-11 w-11 items-center justify-center rounded-full border shadow-sm transition"
              >
                <Settings size={18} strokeWidth={1.75} />
              </Link>
            </div>

            <button
              onClick={async () => {
                setBusy(true);
                await onCreate();
                setBusy(false);
              }}
              disabled={busy}
              title="New session"
              aria-label="New session"
              className="bg-ink text-on-primary absolute right-4 bottom-4 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition hover:opacity-85 disabled:opacity-40"
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </>
        )}
      </aside>

      {confirming && (
        <ConfirmDelete
          sessions={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onDelete(confirming.map((s) => s.id));
            setConfirming(null);
            setPicked(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Deleting a session takes everything it holds and cannot be undone, so it is asked
 * rather than done. The consequences are named plainly, and the way out is the easier
 * of the two choices to reach: the backdrop, the Escape key, or Cancel.
 *
 * A Telegram session is worth its own sentence. What is deleted here is this side of
 * the conversation; the chat itself belongs to Telegram and keeps its messages, and
 * someone who deletes a session expecting the chat to go with it has been misled.
 */
function ConfirmDelete({
  sessions,
  onCancel,
  onConfirm,
}: {
  /** One session from its row, or several from a selection. */
  sessions: SessionRow[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const one = sessions.length === 1 ? sessions[0] : null;
  // Both channels keep their own copy of the conversation, so deleting the session
  // here does not delete anything there.
  const channels = [
    ...new Set(
      sessions
        .map((s) =>
          s.source === "telegram"
            ? "Telegram"
            : s.source === "whatsapp"
              ? "WhatsApp"
              : "",
        )
        .filter(Boolean),
    ),
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
      <button
        onClick={onCancel}
        aria-label={one ? "Keep session" : "Keep sessions"}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        className="border-hairline bg-canvas relative w-full max-w-sm rounded-[20px] border p-6 shadow-xl"
      >
        <h2
          id="confirm-delete-title"
          className="text-ink text-lg font-[650] leading-[1.35]"
        >
          {one
            ? `Delete “${one.title}”?`
            : `Delete ${sessions.length} sessions?`}
        </h2>
        <p className="text-muted mt-2 text-sm leading-normal">
          {one ? "Its" : "Their"} messages, files, and stored data will be
          deleted permanently. This can’t be undone.
        </p>
        {channels.length > 0 && (
          <p className="text-muted mt-2 text-sm leading-normal">
            Messages in the {channels.join(" and ")} chat
            {one ? "" : "s"} aren’t deleted. A new session starts the next time
            someone writes there.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            // Focus starts on the way out, not on the deletion: a stray Return should
            // keep the session, never take it.
            autoFocus
            className="border-hairline text-ink hover:bg-canvas-soft rounded-full border px-4 py-2 text-sm font-medium transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="bg-ink text-on-primary rounded-full px-4 py-2 text-sm font-medium transition hover:opacity-85"
          >
            {one ? "Delete session" : `Delete ${sessions.length} sessions`}
          </button>
        </div>
      </div>
    </div>
  );
}
