"use client";

import { Suspense, use } from "react";
import { linkLabel, type Person } from "@/lib/people";

// One fetch per person per page load, whichever answer names them first.
const loaded = new Map<string, Promise<Person | null>>();

function load(id: string): Promise<Person | null> {
  let p = loaded.get(id);
  if (!p) {
    p = fetch(`/api/people/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<Person>) : null))
      .catch(() => null);
    loaded.set(id, p);
  }
  return p;
}

/** A person named in an answer, as a search result: who, what they do, and where to find them. */
export function PersonCard({ id }: { id: string }) {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <Card id={id} />
    </Suspense>
  );
}

function Card({ id }: { id: string }) {
  const p = use(load(id));
  // An id the agent got wrong names no one: nothing to show.
  if (!p) return null;
  const name = p.name ?? "Someone at Devcon";
  return (
    <article
      id={`person-${id}`}
      className="result rise-in scroll-mt-24 rounded-xl border border-white/10 bg-white/[0.03] p-5"
    >
      <h3 className="text-xl font-semibold tracking-tight text-white">{name}</h3>
      <p className="mt-1 text-white/80">
        {p.headline}
        {/* Not when the headline already says where. */}
              {p.location && !p.headline.includes(p.location) && <span className="text-white/40"> · {p.location}</span>}
      </p>
      <p className="mt-2 leading-relaxed text-white/55">{p.summary}</p>
      {p.links.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {p.links.map((l) => (
            <li key={l}>
              <a
                href={l}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[#5dff8f]/90 underline decoration-[#5dff8f]/30 underline-offset-4 hover:decoration-[#5dff8f]"
              >
                {linkLabel(l)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <div className="h-6 w-48 animate-pulse rounded bg-white/10" />
      <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-white/[0.07]" />
      <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-white/[0.07]" />
    </div>
  );
}
