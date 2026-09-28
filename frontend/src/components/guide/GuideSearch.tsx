"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SearchEntry } from "@/lib/guide-search";

/**
 * Search over the guide, in a dialog. Ported from `landing-page/components/DocsSearch.tsx`.
 *
 * The index is built from the same markdown the pages render, at build time, and
 * served as one static file. It is fetched the first time the dialog is opened
 * and kept for the rest of the visit — so there is no round trip per keystroke,
 * nothing to keep in sync with the articles, and no index inlined into the HTML
 * of every page.
 *
 * The dialog is a real `<dialog>` opened with `showModal()`, which brings the
 * focus trap, the inert background and Escape-to-close with it rather than
 * reimplementing all three.
 */
export function GuideSearch() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
  /** Set while the one fetch is in flight, so opening twice fetches once. */
  const loading = useRef(false);

  const results = useMemo(() => search(index ?? [], query), [index, query]);

  const show = useCallback(() => {
    setQuery("");
    setActive(0);
    setOpen(true);
    dialog.current?.showModal();
    // Safari does not always focus the autofocused input of a fresh dialog.
    requestAnimationFrame(() => input.current?.focus());

    if (index || loading.current) return;
    loading.current = true;
    fetch("/guide/search-index.json")
      .then((res) => res.json())
      .then((entries: SearchEntry[]) => setIndex(entries))
      .catch(() => {
        // Nothing to retry against: a failed index leaves the dialog saying it
        // could not load rather than silently finding nothing.
        setIndex([]);
      })
      .finally(() => {
        loading.current = false;
      });
  }, [index]);

  const hide = useCallback(() => {
    dialog.current?.close();
  }, []);

  /* ⌘K and Ctrl+K from anywhere, and "/" when not already typing. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);

      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (open) hide();
        else show();
        return;
      }
      if (event.key === "/" && !typing && !open) {
        event.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, hide]);

  /* The highlighted row follows the keyboard rather than the other way round. */
  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = useCallback(
    (entry: SearchEntry) => {
      hide();
      router.push(`/guide/${entry.slug}${entry.hash ? `#${entry.hash}` : ""}`);
    },
    [hide, router],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((at) => (results.length === 0 ? 0 : (at + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at) => (results.length === 0 ? 0 : (at - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[active];
      if (entry) go(entry);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="flex h-9 items-center gap-2 rounded-full bg-canvas-soft pl-3 pr-2 text-sm text-muted transition-colors hover:text-ink sm:w-[220px]"
      >
        <SearchIcon />
        <span className="flex-1 text-left">Search</span>
        <kbd className="hidden rounded-[6px] bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-faint sm:block">
          ⌘K
        </kbd>
      </button>

      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        // A click that lands on the dialog itself landed on the backdrop: the
        // panel inside it covers every other pixel.
        onClick={(event) => {
          if (event.target === dialog.current) hide();
        }}
        className="m-0 max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-ink/35 backdrop:backdrop-blur-[2px] open:fixed open:inset-0 open:flex open:items-start open:justify-center"
      >
        <div
          className="mt-[10vh] w-[calc(100%-2rem)] max-w-[620px] overflow-hidden rounded-[24px] bg-canvas text-ink shadow-[0_24px_60px_rgba(0,0,0,0.18)] ring-1 ring-hairline"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-3 border-b border-hairline-soft px-5 py-4">
            <SearchIcon />
            <input
              ref={input}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search the guide"
              aria-label="Search the guide"
              className="w-full bg-transparent text-[16px] outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={hide}
              className="rounded-[8px] bg-canvas-soft px-2 py-1 font-mono text-[11px] text-faint transition-colors hover:text-ink"
            >
              esc
            </button>
          </div>

          <div className="max-h-[min(60vh,460px)] overflow-y-auto">
            {index === null ? (
              <p className="px-5 py-8 text-center text-sm text-faint">Loading the index…</p>
            ) : query.trim() === "" ? (
              <p className="px-5 py-8 text-center text-sm text-faint">
                Type to search every article. ↑↓ to move, ⏎ to open.
              </p>
            ) : results.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-faint">
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              <ul ref={list} className="p-2">
                {results.map((entry, i) => (
                  <li key={`${entry.slug}-${entry.hash}-${i}`}>
                    <button
                      type="button"
                      data-active={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(entry)}
                      className={`block w-full rounded-[14px] px-3 py-3 text-left transition-colors ${
                        i === active ? "bg-canvas-soft" : ""
                      }`}
                    >
                      <p className="flex items-baseline gap-2">
                        <span className="text-[15px] font-semibold leading-[1.3]">
                          {entry.heading || entry.title}
                        </span>
                        <span className="truncate text-[11px] uppercase tracking-[0.06em] text-faint">
                          {entry.heading ? entry.title : entry.group}
                        </span>
                      </p>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-[1.5] text-muted">
                        {highlight(snippet(entry.text, query), query)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      className="shrink-0 text-faint"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------- matching -- */

const terms = (query: string) =>
  query
    .toLowerCase()
    .split(/[^a-z0-9!]+/i)
    .filter((term) => term.length > 1);

/**
 * Every term has to appear somewhere in an entry, and where it appears decides
 * the order: a title beats a heading, a heading beats the prose. Two dozen
 * articles do not need anything cleverer, and anything cleverer would have to be
 * explained to whoever edits the markdown next.
 */
function search(index: SearchEntry[], query: string): SearchEntry[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];

  const scored: { entry: SearchEntry; score: number }[] = [];

  for (const entry of index) {
    const title = entry.title.toLowerCase();
    const heading = entry.heading.toLowerCase();
    const text = entry.text.toLowerCase();

    let score = 0;
    let matchedAll = true;

    for (const term of wanted) {
      let termScore = 0;
      if (title.includes(term)) termScore += title.startsWith(term) ? 9 : 6;
      if (heading.includes(term)) termScore += 5;
      if (text.includes(term)) termScore += 2;
      if (termScore === 0) {
        matchedAll = false;
        break;
      }
      score += termScore;
    }

    if (!matchedAll) continue;
    // The opening of an article stands for the article, so it outranks one of
    // its own sections when both match equally.
    if (entry.hash === "") score += 1;
    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((row) => row.entry);
}

/** A window of the prose around the first term that matched. */
function snippet(text: string, query: string): string {
  const wanted = terms(query);
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of wanted) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at <= 90) return text.slice(0, 190);
  return `…${text.slice(at - 60, at + 130)}`;
}

/** The matched terms, marked, so the eye lands where the match is. */
function highlight(text: string, query: string) {
  const wanted = terms(query);
  if (wanted.length === 0) return text;

  const pattern = new RegExp(
    `(${wanted.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "ig",
  );

  // `split` with a capture group hands the delimiters back in the array, so the
  // matched terms are exactly the parts that are one of the terms.
  return text.split(pattern).map((part, i) =>
    wanted.includes(part.toLowerCase()) ? (
      <mark key={i} className="bg-transparent font-semibold text-ink">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
