"use client";

import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useMotionValueEvent,
  useScroll,
} from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AGENTS_DEPLOYED,
  BRAND,
  HERO,
  LINKS as DESTINATIONS,
  NAV,
  NAV_OWNER,
  NAV_SECTION_IDS,
} from "./content";
import { MaybeLink } from "./ui";

function Mark() {
  const tile = useAnimationControls();
  const playing = useRef(false);

  const play = useCallback(async () => {
    if (playing.current) return;
    playing.current = true;
    // Out: the tile swells and turns a quarter.
    await tile.start({
      rotate: 45,
      scale: 1.14,
      transition: { duration: 0.75, ease: [0.22, 1, 0.36, 1] },
    });
    // Back: it completes the circle rather than unwinding it.
    await tile.start({
      rotate: 360,
      scale: 1,
      transition: { duration: 0.43, ease: [0.65, 0, 0.35, 1] },
    });
    tile.set({ rotate: 0 });
    playing.current = false;
  }, [tile]);

  useEffect(() => {
    const id = setInterval(play, 5000);
    return () => clearInterval(id);
  }, [play]);

  return (
    <span
      onMouseEnter={play}
      className="relative grid size-8 shrink-0 place-items-center"
    >
      <motion.span
        animate={tile}
        aria-hidden="true"
        className="absolute inset-0 rounded-[10px] bg-ink"
      />
      {/* Salt: four grains that hold their place while the tile turns. */}
      <span className="relative grid grid-cols-2 gap-[3px]">
        <span className="size-[5px] rounded-[1.5px] bg-white" />
        <span className="size-[5px] rounded-[1.5px] bg-white/45" />
        <span className="size-[5px] rounded-[1.5px] bg-white/45" />
        <span className="size-[5px] rounded-[1.5px] bg-white" />
      </span>
    </span>
  );
}

/**
 * Reports which nav entry the reader is looking at.
 *
 * It observes every section id in NAV_SECTION_IDS — not just the four that
 * have a link — and maps whichever is most in view back to the nav entry that
 * owns it. That way a section added between two existing ones keeps the
 * highlight lit instead of breaking the chain; give it an id and list that id
 * in the right NAV group in content.ts.
 */
function useActiveNav() {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const seen = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        const [best] = [...seen.entries()].sort((a, b) => b[1] - a[1]);
        setActive(best && best[1] > 0 ? (NAV_OWNER[best[0]] ?? null) : null);
      },
      { rootMargin: "-25% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
    );

    NAV_SECTION_IDS.map((id) => document.getElementById(id)).forEach(
      (el) => el && observer.observe(el),
    );

    return () => observer.disconnect();
  }, []);

  return active;
}

export function SiteHeader() {
  const { scrollY } = useScroll();
  const [open, setOpen] = useState(false);
  const [lifted, setLifted] = useState(false);
  const active = useActiveNav();

  useMotionValueEvent(scrollY, "change", (y) => setLifted(y > 12));

  // Both islands share one surface treatment: bare at the top, glass once moving
  // — and while the menu is open, so they stay legible over the dimmed page.
  const island = `rounded-[18px] backdrop-blur-xl transition-[background-color,box-shadow] duration-300 ${
    lifted || open
      ? "bg-white/80 shadow-[0_0_0_1px_var(--color-hairline-soft)]"
      : "bg-transparent"
  }`;

  return (
    <header className="fixed inset-x-0 top-0 z-50 pt-3 sm:pt-5">
      <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
        <div className="flex items-center gap-2">
          {/* Identity island — mark, wordmark, and the number this product is about. */}
          <div className={`${island} flex items-center gap-3 p-1.5 pr-3`}>
            <a href="#top" className="flex items-center gap-2.5">
              <Mark />
              <span className="text-[17px] font-[650] tracking-[-0.02em]">
                {BRAND.name}
              </span>
            </a>
            <span className="hidden h-5 w-px bg-hairline lg:block" />
            <span className="tnum hidden text-[12px] font-semibold text-muted lg:block">
              {new Intl.NumberFormat("en-US", {
                notation: "compact",
                compactDisplay: "short",
              }).format(AGENTS_DEPLOYED)}
              <span className="text-faint"> agents online</span>
            </span>
          </div>

          {/* Navigation island — links, a hairline, then the one filled action. */}
          <div className={`${island} ml-auto flex items-center gap-1 p-1.5`}>
            <nav className="hidden items-center md:flex">
              {NAV.map((l) => {
                const isActive = active === l.id;
                return (
                  <a
                    key={l.id}
                    href={`#${l.id}`}
                    aria-current={isActive ? "true" : undefined}
                    className={`relative rounded-[12px] px-3.5 py-2 text-[15px] font-semibold transition-colors ${
                      isActive ? "text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {isActive && (
                      // One indicator, moved between links rather than redrawn.
                      <motion.span
                        layoutId="nav-active"
                        transition={{
                          type: "spring",
                          stiffness: 420,
                          damping: 36,
                        }}
                        className="absolute inset-0 -z-10 rounded-[12px] bg-canvas-soft"
                      />
                    )}
                    {l.label}
                  </a>
                );
              })}
              <span className="mx-2 h-5 w-px bg-hairline" />
              <MaybeLink
                href={DESTINATIONS.signIn}
                className="rounded-[12px] px-3 py-2 text-[15px] font-semibold text-muted transition-colors hover:text-ink"
              >
                Sign in
              </MaybeLink>
            </nav>

            <a
              href={DESTINATIONS.signUp ?? "#start"}
              className="inline-flex h-10 items-center gap-2 rounded-[13px] bg-ink px-4 text-sm font-semibold text-white transition-colors hover:bg-ink-soft md:pr-3"
            >
              <span>{HERO.primaryCta}</span>
              {/* The icon is desktop-only; the label is the same either way. */}
              <span className="hidden size-5 place-items-center rounded-full bg-white/15 md:grid">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path
                    d="M1 9 9 1M3.2 1H9v5.8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </a>

            <button
              type="button"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="grid size-10 place-items-center rounded-[13px] ring-1 ring-hairline transition-colors md:hidden"
            >
              <span className="flex flex-col gap-[5px]">
                <span
                  className={`h-px w-4 transition-colors ${open ? "bg-ink/30" : "bg-ink"}`}
                />
                <span
                  className={`h-px w-4 transition-colors ${open ? "bg-ink/30" : "bg-ink"}`}
                />
              </span>
            </button>
          </div>
        </div>

        <AnimatePresence>
          {open && (
            // Dims the page so the menu reads as the only live surface.
            <motion.button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed inset-0 -z-10 cursor-default bg-ink/30 backdrop-blur-[2px] md:hidden"
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {open && (
            <motion.nav
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mt-2 overflow-hidden rounded-[18px] bg-white/95 p-2 shadow-[0_0_0_1px_var(--color-hairline-soft)] backdrop-blur-xl md:hidden"
            >
              {NAV.map((l) => (
                <a
                  key={l.id}
                  href={`#${l.id}`}
                  onClick={() => setOpen(false)}
                  className="block rounded-[12px] px-4 py-3 text-[15px] font-semibold text-muted hover:bg-canvas-soft hover:text-ink"
                >
                  {l.label}
                </a>
              ))}
              <MaybeLink
                href={DESTINATIONS.signIn}
                className="block rounded-[12px] px-4 py-3 text-[15px] font-semibold text-muted hover:bg-canvas-soft hover:text-ink"
              >
                Sign in
              </MaybeLink>
            </motion.nav>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}
