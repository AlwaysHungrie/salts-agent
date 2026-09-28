import Link from "next/link";
import type { ReactNode } from "react";

import { BackToTop } from "./BackToTop";
import { GuideSearch } from "./GuideSearch";
import { guideSections } from "@/lib/guide";

/**
 * The shell every guide route shares: a bar that goes back to the app, the article
 * index down the left, and whatever the route puts in the middle.
 *
 * Ported from `landing-page/components/DocsLayout.tsx`. The only interactive part is
 * the search dialog; the mobile article index is a `<details>` and the sidebar is a
 * list of links, so neither costs any JavaScript.
 */
export function GuideLayout({
  children,
  /** The article being read, so its link is marked current. */
  current,
}: {
  children: ReactNode;
  current?: string;
}) {
  const sections = guideSections();

  return (
    <div className="bg-canvas text-ink min-h-screen w-full">
      <header className="border-hairline-soft bg-canvas/85 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="bg-ink grid size-8 place-items-center rounded-[10px]">
                <span className="grid grid-cols-2 gap-[3px]">
                  <span className="size-[5px] rounded-[1.5px] bg-white" />
                  <span className="size-[5px] rounded-[1.5px] bg-white/45" />
                  <span className="size-[5px] rounded-[1.5px] bg-white/45" />
                  <span className="size-[5px] rounded-[1.5px] bg-white" />
                </span>
              </span>
              <span className="text-[17px] font-[650] tracking-[-0.02em]">Salts</span>
            </Link>
            <Link
              href="/guide"
              className="bg-canvas-soft text-muted hover:text-ink rounded-full px-2.5 py-1 text-xs font-semibold tracking-[0.02em] transition-colors"
            >
              Guide
            </Link>
          </div>
          <div className="flex items-center gap-4">
            {/* Its index is the static file at /guide/search-index.json. */}
            <GuideSearch />
            <BackToTop />
          </div>
        </div>
      </header>

      {/* The index, collapsed, above the article on a phone. */}
      <details className="border-hairline-soft border-b lg:hidden">
        <summary className="mx-auto flex w-full max-w-[1320px] cursor-pointer list-none items-center justify-between px-6 py-4 text-sm font-semibold">
          All articles
          <span aria-hidden="true" className="text-faint">
            ▾
          </span>
        </summary>
        <div className="mx-auto w-full max-w-[1320px] px-6 pb-6">
          <Index sections={sections} current={current} />
        </div>
      </details>

      <div className="mx-auto flex w-full max-w-[1320px] gap-10 px-6">
        <aside className="hidden w-[228px] shrink-0 lg:block">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-10 pr-2">
            <Index sections={sections} current={current} />
          </div>
        </aside>

        <main className="min-w-0 flex-1 py-10 sm:py-14">{children}</main>
      </div>

      <footer className="border-hairline-soft border-t">
        <div className="text-faint mx-auto flex w-full max-w-[1320px] flex-col gap-3 px-6 py-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span>
            Still have a question?{" "}
            <a
              href="https://t.me/saltsagents"
              target="_blank"
              rel="noreferrer"
              className="text-ink underline underline-offset-2"
            >
              Ask here
            </a>
          </span>
          <Link href="/" className="hover:text-ink transition-colors">
            Your agents
          </Link>
        </div>
      </footer>
    </div>
  );
}

function Index({
  sections,
  current,
}: {
  sections: ReturnType<typeof guideSections>;
  current?: string;
}) {
  return (
    <nav aria-label="User guide">
      {sections.map((section) => (
        <div key={section.title} className="mt-6 first:mt-0">
          <p className="text-faint text-[11px] font-semibold tracking-[0.08em] uppercase">
            {section.title}
          </p>
          <ul className="mt-2 space-y-px">
            {section.guides.map((guide) => {
              const active = guide.slug === current;
              return (
                <li key={guide.slug}>
                  <Link
                    href={`/guide/${guide.slug}`}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-[10px] px-2.5 py-[7px] text-[14px] leading-[1.35] transition-colors ${
                      active
                        ? "bg-canvas-soft text-ink font-semibold"
                        : "text-muted hover:bg-canvas-soft hover:text-ink"
                    }`}
                  >
                    {guide.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
