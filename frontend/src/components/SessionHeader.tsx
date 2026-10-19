"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Menu, Pencil, X } from "lucide-react";
import type { Summary } from "@/lib/agent";
import { formatCountShort, formatDate, formatUsdShort } from "@/lib/format";

function Stat({
  label,
  value,
  hint,
}: {
  label?: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 text-right">
      {label && (
        <div className="text-faint text-xs leading-[1.33]">{label}</div>
      )}
      <div className="text-ink tnum text-xl font-[650] leading-[1.3]">
        {value}
      </div>
      {hint && (
        <div className="text-muted tnum text-xs leading-[1.33]">{hint}</div>
      )}
    </div>
  );
}

/**
 * The session's own facts: its name, when it was created and how much it has been
 * used. The title is edited here in place — renaming is the one thing about a
 * session you change from the conversation you are looking at.
 *
 * The model is an app-wide setting now, so it lives in the settings page, not here.
 * Cloudflare's costs are deliberately not shown — they cannot be measured
 * from inside the object, and their analytics lag. See
 * docs/cloudflare-durable-object-costs.md.
 */
export function SessionHeader({
  title,
  createdAt,
  summary,
  onRename,
  onOpenSidebar,
}: {
  title: string;
  createdAt: number | null;
  summary: Summary | null;
  onRename: (title: string) => Promise<void> | void;
  onOpenSidebar: () => void;
}) {
  const [editing, setEditing] = useState(false);
  /** The rename dialog, which is how a phone renames: the header has no room to edit in. */
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(title);
  const input = useRef<HTMLInputElement>(null);

  // A rename elsewhere — or switching sessions — wins over an abandoned edit.
  // Adjust during render instead of an effect, tracking the last title seen.
  const [prevTitle, setPrevTitle] = useState(title);
  if (title !== prevTitle) {
    setPrevTitle(title);
    setEditing(false);
    setRenaming(false);
    setValue(title);
  }

  /** Inline on a wide screen; in a dialog on a phone. */
  const startRename = () => {
    if (window.matchMedia("(min-width: 768px)").matches) setEditing(true);
    else {
      setValue(title);
      setRenaming(true);
    }
  };

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = value.trim();
    setEditing(false);
    setRenaming(false);
    if (!next || next === title) {
      setValue(title);
      return;
    }
    await onRename(next);
  };

  return (
    <header className="border-hairline-soft bg-canvas border-b">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4 px-5 pt-5 pb-4 md:px-8 md:pt-6 md:pb-5">
        <button
          onClick={onOpenSidebar}
          aria-label="Open sessions"
          className="text-ink hover:bg-canvas-soft -ml-1 mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition md:hidden"
        >
          <Menu size={20} strokeWidth={1.75} />
        </button>

        <div className="mr-auto min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center">
              <input
                ref={input}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commit();
                  if (e.key === "Escape") {
                    setValue(title);
                    setEditing(false);
                  }
                }}
                onBlur={() => void commit()}
                aria-label="Session title"
                className="mr-2 bg-field text-ink focus:ring-ink min-w-0 max-w-64 flex-1 rounded-xl px-3 py-1 text-xl font-[650] leading-tight outline-none focus:ring-2 md:text-xl"
              />
              {/* Pressed before blur can fire, so the click still counts. */}
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void commit()}
                aria-label="Save title"
                className="text-muted hover:bg-canvas-soft hover:text-ink flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
              >
                <Check size={16} strokeWidth={2} />
              </button>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setValue(title);
                  setEditing(false);
                }}
                aria-label="Cancel rename"
                className="text-muted hover:bg-canvas-soft hover:text-ink flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <div className="group flex items-center gap-2">
              <button
                // On a phone only the pencil renames, so a tap on the title is not one.
                onClick={() => {
                  if (window.matchMedia("(min-width: 768px)").matches)
                    setEditing(true);
                }}
                title="Rename session"
                className="min-w-0 truncate text-left text-xl font-[650] leading-tight md:text-2xl"
              >
                {title}
              </button>
              <button
                onClick={startRename}
                aria-label="Rename session"
                className="text-muted hover:bg-canvas-soft hover:text-ink flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-100 transition md:opacity-0 md:group-hover:opacity-100"
              >
                <Pencil size={14} strokeWidth={1.75} />
              </button>
            </div>
          )}
          {/* A phone has no room for the usage column, so it takes the date's line. */}
          <div className="text-muted tnum truncate text-sm font-light leading-[1.43] md:hidden">
            {formatUsdShort(summary?.llm.cost_usd)} ·{" "}
            {formatCountShort(summary?.messages ?? 0)} msgs
          </div>
          <div className="text-muted hidden truncate text-sm font-light leading-[1.43] md:block">
            {formatDate(createdAt)}
          </div>
        </div>

        {/* What this session has cost, over how many messages it took. Both are
            formatted to a fixed shape — two decimals, counts abbreviated past four
            figures — so a long session cannot widen the header it sits in. */}
        <div className="hidden shrink-0 md:block">
          <Stat
            value={formatUsdShort(summary?.llm.cost_usd)}
            hint={`${formatCountShort(summary?.messages ?? 0)} msgs`}
          />
        </div>
      </div>

      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
          <button
            onClick={() => setRenaming(false)}
            aria-label="Cancel rename"
            className="absolute inset-0 bg-black/40"
          />
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            onSubmit={(e) => {
              e.preventDefault();
              void commit();
            }}
            className="border-hairline bg-canvas relative w-full max-w-sm rounded-[20px] border p-6 shadow-xl"
          >
            <h2
              id="rename-title"
              className="text-ink text-lg font-[650] leading-[1.35]"
            >
              Rename session
            </h2>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
              aria-label="Session title"
              className="bg-field text-ink mt-4 w-full rounded-2xl px-4 py-3 text-sm outline-none"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="border-hairline text-ink hover:bg-canvas-soft rounded-full border px-4 py-2 text-sm font-medium transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!value.trim()}
                className="bg-ink text-on-primary rounded-full px-4 py-2 text-sm font-medium transition hover:opacity-85 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </header>
  );
}
