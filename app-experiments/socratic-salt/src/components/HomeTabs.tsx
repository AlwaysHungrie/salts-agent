"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Row } from "./Row";
import type { ChallengeCard } from "@/lib/challenges";

type Tab = "all" | "mine";

/** frontend/'s segmented control: one white thumb sliding under the chosen label. */
export function HomeTabs({
  all,
  mine,
  canCreate,
}: {
  all: ChallengeCard[];
  mine: ChallengeCard[];
  canCreate: boolean;
}) {
  const [tab, setTab] = useState<Tab>("all");

  return (
    <>
      <div role="tablist" className="bg-canvas-soft relative mt-4 grid w-72 grid-cols-2 rounded-full p-1">
        <span
          aria-hidden
          className="bg-canvas absolute inset-y-1 left-1 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.06)] transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)]"
          style={{ width: "calc(50% - 4px)", transform: tab === "mine" ? "translateX(100%)" : "translateX(0)" }}
        />
        {(["all", "mine"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative h-9 rounded-full text-sm font-semibold transition-colors duration-300 ${
              tab === t ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {t === "all" ? "All challenges" : "Your challenges"}
          </button>
        ))}
      </div>

      {tab === "all" ? (
        <div key="all" className="from-left mt-2 space-y-2">
          {all.length === 0 && (
            <p className="text-muted px-1 py-2 text-sm leading-[1.43]">
              No challenges are open to you yet.
            </p>
          )}
          {all.map((c) => (
            <Row key={c.id} href={`/c/${c.id}`} title={c.name} detail={c.excerpt} />
          ))}
        </div>
      ) : (
        <div key="mine" className="from-right mt-2 space-y-2">
          {mine.map((c) => (
            <Row key={c.id} href={`/c/${c.id}`} title={c.name} detail={c.excerpt} />
          ))}
          {canCreate ? (
            <Link
              href="/new"
              className="from-accent/12 hover:to-accent/5 flex min-h-17 items-center gap-3 rounded-2xl bg-linear-to-r to-transparent px-5 py-4 font-semibold transition"
            >
              <Plus size={18} strokeWidth={2} /> New challenge
            </Link>
          ) : (
            <p className="text-muted px-1 py-2 text-sm leading-[1.43]">
              You have reached your agent limit, so you cannot create another challenge.
            </p>
          )}
        </div>
      )}
    </>
  );
}
