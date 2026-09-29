"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Mark } from "./Mark";

/**
 * The challenge as an app: brief on the left, debate on the right. On a phone the
 * two are one pane at a time, switched by the segmented control frontend/ uses.
 */
export function ChallengeView({
  name,
  brief,
  chat,
  started,
  ownerOf,
}: {
  name: string;
  brief: ReactNode;
  chat: ReactNode;
  started: boolean;
  /** The challenge id, when the caller created it: links to its settings and conversations. */
  ownerOf?: string;
}) {
  const [tab, setTab] = useState<"brief" | "debate">(started ? "debate" : "brief");

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-hairline-soft flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
        <Link href="/" className="group flex min-w-0 items-center gap-2.5" aria-label="All challenges">
          <Mark />
          <span className="text-muted hidden items-center gap-1 text-sm font-semibold sm:flex">
            <ArrowLeft className="size-3.5" /> Challenges
          </span>
        </Link>
        <span className="bg-hairline hidden h-5 w-px sm:block" />
        <h1 className="min-w-0 truncate text-[15px] font-[650] tracking-[-0.01em]">{name}</h1>
        {ownerOf && (
          <nav className="ml-auto hidden items-center gap-1 sm:flex lg:ml-auto">
            <Link
              href={`/c/${ownerOf}/conversations`}
              className="text-muted hover:text-ink hover:bg-canvas-soft rounded-full px-3 py-1.5 text-sm font-semibold transition"
            >
              Conversations
            </Link>
            <Link
              href={`/c/${ownerOf}/settings`}
              className="text-muted hover:text-ink hover:bg-canvas-soft rounded-full px-3 py-1.5 text-sm font-semibold transition"
            >
              Settings
            </Link>
          </nav>
        )}

        <div className={`bg-canvas-soft relative grid w-44 ${ownerOf ? "sm:ml-2" : ""} ml-auto shrink-0 grid-cols-2 rounded-full p-1 lg:hidden`}>
          <span
            aria-hidden
            className={`bg-canvas absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.06)] transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)] ${
              tab === "debate" ? "translate-x-full" : ""
            }`}
          />
          {(["brief", "debate"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`relative h-8 rounded-full text-sm font-semibold capitalize transition-colors duration-300 ${
                tab === t ? "text-ink" : "text-muted"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`border-hairline-soft min-h-0 w-full min-w-0 overflow-y-auto lg:block lg:w-[44%] lg:max-w-[640px] lg:shrink-0 lg:border-r ${
            tab === "brief" ? "from-left block" : "hidden"
          }`}
        >
          <div className="px-5 py-8 sm:px-10 sm:py-12">
            <p className="text-faint text-xs font-semibold tracking-[0.08em] uppercase">The brief</p>
            <div className="mt-4">{brief}</div>
            <button
              type="button"
              onClick={() => setTab("debate")}
              className="bg-ink hover:bg-ink-soft mt-10 inline-flex h-12 items-center rounded-full px-6 text-base font-semibold text-white transition-colors lg:hidden"
            >
              Make your case
            </button>
          </div>
        </aside>
        <section
          className={`min-h-0 min-w-0 flex-1 flex-col lg:flex ${tab === "debate" ? "from-right flex" : "hidden"}`}
        >
          {chat}
        </section>
      </div>
    </div>
  );
}
