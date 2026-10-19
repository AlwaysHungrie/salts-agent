"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Image, { type StaticImageData } from "next/image";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import monstera from "@/public/preview/monstera.jpg";
import chefIcon from "@/public/preview/session-chef.png";
import wheelbarrowIcon from "@/public/preview/session-wheelbarrow.png";
import snakePlant from "@/public/preview/snake-plant.jpg";

/**
 * A slice of the real app, drawn by hand rather than screenshotted: the session
 * sidebar, one conversation at a time, and the Telegram notification that arrives
 * when the agent acts on its own. Two sessions are here so the sidebar has
 * something to switch between — everything in it is fixed sample content.
 */

type Session = {
  id: string;
  title: string;
  when: string;
  icon: "chef" | "wheelbarrow";
};

const SESSIONS: Session[] = [
  { id: "bakery", title: "Friday flour order", when: "Today, 08:12", icon: "chef" },
  { id: "plants", title: "Water the plants", when: "Sat, 19:40", icon: "wheelbarrow" },
];

/** How long a visitor rests on the hero before the reminder arrives by itself. */
const NUDGE_DELAY_MS = 4000;

/** How far a visitor scrolls before the reminder arrives by itself. */
const NUDGE_SCROLL_PX = 120;

export function AppPreview({ className = "" }: { className?: string }) {
  const [selected, setSelected] = useState<string>("bakery");
  const [toast, setToast] = useState(false);

  // Few visitors open the second session, so the reminder also arrives on its own
  // once: after a short rest on the hero, or the first bit of scroll. The open
  // session stays the bakery one.
  useEffect(() => {
    const stop = () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
    };
    // Once only, so a dismissed reminder is not brought back by the next scroll.
    const show = () => {
      stop();
      setToast(true);
    };
    const onScroll = () => {
      if (window.scrollY > NUDGE_SCROLL_PX) show();
    };
    const timer = window.setTimeout(show, NUDGE_DELAY_MS);
    window.addEventListener("scroll", onScroll, { passive: true });
    return stop;
  }, []);

  // Clearing the reminder opens the conversation that scheduled it.
  const dismiss = () => {
    setToast(false);
    setSelected("plants");
  };

  return (
    <div className={`z-20 relative mx-auto w-full max-w-[860px] ${className}`}>
      {/* A soft light behind the card, so it sits above the page rather than on it.
          Blurred and cropped by nothing, it reads as glow and not as a shape. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -top-6 bottom-0 -z-10 rounded-[40px] bg-[radial-gradient(60%_55%_at_50%_45%,rgba(0,102,255,0.10)_0%,rgba(0,102,255,0.04)_45%,rgba(255,255,255,0)_75%)] blur-2xl"
      />

      {/* The sidebar has no room on a phone, so the one thing it is here to do —
          switch between the two sessions — moves above the card. */}
      <div className="mb-3 flex gap-2 sm:hidden">
        {SESSIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            aria-pressed={selected === s.id}
            className={`flex flex-1 items-center justify-center gap-2 rounded-full py-1.5 pr-3 pl-1.5 text-[12px] font-semibold transition ${
              selected === s.id
                ? "bg-ink text-white"
                : "bg-canvas text-muted ring-1 ring-hairline"
            }`}
          >
            <SessionIcon icon={s.icon} className="size-7" />
            <span className="truncate">{s.title}</span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[24px] bg-canvas shadow-[0_18px_50px_-20px_rgba(20,20,20,0.22)] ring-1 ring-hairline">
        {/* Browser chrome, so a product shot reads as a product shot. */}
        <div className="flex items-center gap-1.5 border-b border-hairline-soft bg-white/60 px-4 py-3">
          <span className="size-2.5 rounded-full bg-hairline" />
          <span className="size-2.5 rounded-full bg-hairline" />
          <span className="size-2.5 rounded-full bg-hairline" />
          <span className="ml-3 flex h-5 min-w-0 items-center rounded-full bg-canvas-soft px-2.5 text-[10px] text-faint">
            salts.bar/a/juno
          </span>
        </div>

        <div className="relative flex h-[440px] text-left sm:h-[420px]">
          <Sidebar selected={selected} onSelect={setSelected} />
          <Transcript selected={selected} />
        </div>
      </div>

      {/* The reminder belongs to the plant session: it arrives on its own once, and
          dismissing it switches the preview to that conversation. */}
      <TelegramToast open={toast} onDismiss={dismiss} />
    </div>
  );
}

/* ------------------------------------------------------------- Sidebar -- */

function Sidebar({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="hidden w-[200px] shrink-0 flex-col border-r border-hairline-soft bg-canvas sm:flex">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-canvas-soft text-[10px] font-semibold text-muted">
            J
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-[650] leading-tight">
              Juno
            </div>
            <div className="text-[10px] leading-tight text-faint">
              @juno_bot
            </div>
          </div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="flex h-7 items-center gap-1.5 rounded-[10px] bg-field px-2 text-[11px] text-faint">
          <SearchIcon />
          Search sessions
        </div>
      </div>

      <div className="space-y-1 px-3">
        {SESSIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition ${
              selected === s.id ? "bg-canvas-soft" : "hover:bg-canvas-soft/60"
            }`}
          >
            <SessionIcon icon={s.icon} className="size-9" />
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold leading-[1.35]">
                {s.title}
              </div>
              <div className="tnum truncate text-[10px] leading-[1.35] text-faint">
                {s.when}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-end p-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white">
          <PlusIcon />
        </span>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------- Transcript -- */

function Transcript({ selected }: { selected: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-hidden px-4 py-5 sm:px-6">
        {selected === "bakery" ? <BakeryThread /> : <PlantThread />}
      </div>

      {/* The composer, as a rest state: nothing typed, nothing pending. */}
      <div className="border-t border-hairline-soft px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2 rounded-full bg-field px-3 py-2">
          <PaperclipIcon />
          <span className="flex-1 text-[12px] text-faint">
            Message Juno&hellip;
          </span>
          <span className="flex size-6 items-center justify-center rounded-full bg-ink text-white">
            <SendIcon />
          </span>
        </div>
      </div>
    </div>
  );
}

function PlantThread() {
  return (
    <>
      <Bubble from="user">
        <div className="mb-2 grid grid-cols-2 gap-1">
          <PlantPhoto src={monstera} alt="Monstera in a cream pot" />
          <PlantPhoto src={snakePlant} alt="Snake plant in a white pot" />
        </div>
        These two are mine. Remind me to water them?
      </Bubble>

      <Bubble from="agent">
        <ToolLines lines={["Looked up", "Scheduled"]} />
        <p>
          Saved. The monstera needs water about every 5 days, the snake plant
          every two weeks.
        </p>
        <p className="mt-2">
          I&rsquo;ll message you on Telegram at 9am &mdash; monstera Monday and
          Saturday, snake plant on the 1st and the 15th.
        </p>
        <Usage tokens="1,204 + 188" cost="$0.004" ms="1.9s" />
      </Bubble>
    </>
  );
}

function BakeryThread() {
  return (
    <>
      <Bubble from="user">
        <FileCard name="stock-count-mar.xlsx" meta="XLSX &middot; 34 KB" />
        Weekend cleared us out. Going by this count, how much flour and butter
        do I reorder before Friday?
      </Bubble>

      <Bubble from="agent">
        <ToolLines
          lines={["Read stock-count-mar.xlsx", "Searched", "Ran sql_query"]}
        />
        <p>
          You&rsquo;re short for Friday. Based on the last four weeks of sales
          in your orders table:
        </p>
        <ul className="mt-2 space-y-1 pl-4">
          <li className="list-disc">
            <span className="font-semibold">Flour &mdash; 80 kg.</span> You have
            22 kg; a normal week takes 96 kg.
          </li>
          <li className="list-disc">
            <span className="font-semibold">Butter &mdash; 25 kg.</span> Your
            mill raised its price 6% on Monday, so I&rsquo;d order the whole
            week now rather than twice.
          </li>
        </ul>
        <Usage tokens="4,182 + 611" cost="$0.014" ms="3.1s" />
      </Bubble>
    </>
  );
}

function Bubble({
  from,
  children,
}: {
  from: "user" | "agent";
  children: React.ReactNode;
}) {
  const isUser = from === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[86%] rounded-[16px] px-3.5 py-2.5 text-[12px] leading-[1.45] ${
          isUser
            ? "bg-ink text-white"
            : "border border-hairline-soft bg-canvas text-ink"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/** What the agent did before it answered, in the same quiet grey as the app. */
function ToolLines({ lines }: { lines: string[] }) {
  return (
    <div className="mb-2.5 space-y-0.5 text-[10.5px] leading-[1.4] text-faint">
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

function Usage({
  tokens,
  cost,
  ms,
}: {
  tokens: string;
  cost: string;
  ms: string;
}) {
  return (
    <div className="tnum mt-2.5 flex flex-wrap gap-x-3 border-t border-hairline-soft pt-2 text-[10px] leading-[1.35] text-faint">
      <span>{tokens} tkns</span>
      <span className="font-semibold text-ink">{cost}</span>
      <span>{ms}</span>
    </div>
  );
}

function FileCard({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-[10px] bg-white/10 px-2.5 py-2">
      <SheetIcon />
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold leading-tight">
          {name}
        </div>
        <div className="text-[10px] leading-tight opacity-70">{meta}</div>
      </div>
    </div>
  );
}

/** A photo as the chat draws it: square, cropped, corners matching the bubble. */
function PlantPhoto({ src, alt }: { src: StaticImageData; alt: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      sizes="120px"
      className="h-[76px] w-full rounded-[10px] object-cover"
    />
  );
}

/* --------------------------------------------------------------- Toast -- */

/**
 * The payoff of the scheduled reminder: the agent writing first, in Telegram. It is
 * drawn where macOS draws one — the corner of the screen, not the corner of the
 * preview — so it arrives over the page rather than inside the product shot. It is
 * portalled to the body, because a fixed child of a transformed ancestor is fixed to
 * that ancestor instead of the viewport.
 *
 * The preview decides when it arrives; nothing but the dismiss button takes it
 * away, so it cannot vanish while it is being read.
 */
function TelegramToast({
  open,
  onDismiss,
}: {
  open: boolean;
  onDismiss: () => void;
}) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    // Clear of the fixed header, which owns the very top of the page.
    <div className="pointer-events-none fixed top-[14px] right-4 sm:right-8 z-[60] w-[304px] max-w-[calc(100vw-2rem)] sm:top-[86px]">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduced ? false : { opacity: 0, x: 24, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.97 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto relative rounded-[16px] bg-white/85 p-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.16)] ring-1 ring-black/5 backdrop-blur-md"
          >
            {/* Overhanging the corner, the way macOS hangs its close badge. */}
            <button
              onClick={onDismiss}
              aria-label="Dismiss notification"
              className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-white text-muted shadow-[0_2px_8px_rgba(0,0,0,0.18)] ring-1 ring-black/5 transition hover:text-ink"
            >
              <CloseIcon />
            </button>
            <div className="flex gap-3">
              <TelegramIcon />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-[650] leading-tight">
                    Juno
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">now</span>
                </div>
                <p className="mt-1 text-[12px] leading-[1.4] text-muted">
                  Time to water the monstera. No rain since Saturday, so the
                  soil will be dry.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------- Icons -- */

/** Each session's mark: a generated icon, cropped to a circle. */
function SessionIcon({
  icon,
  className,
}: {
  icon: Session["icon"];
  className: string;
}) {
  return (
    <Image
      src={icon === "chef" ? chefIcon : wheelbarrowIcon}
      alt=""
      sizes="36px"
      className={`shrink-0 rounded-full object-cover ${className}`}
    />
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3 shrink-0">
      <g fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="M15.5 15.5 L21 21" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="size-3.5 shrink-0 text-faint"
    >
      <path
        d="M20 11.5 11.8 19.7a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.6 1.6 0 0 1-2.2-2.2l7.3-7.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3">
      <path
        d="M4 12h14M12 5l7 7-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SheetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 shrink-0">
      <g fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M9 12h6M9 16h6" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-[#229ED9]">
      <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-white">
        <path d="M21.8 3.4 2.9 10.7c-1 .4-1 1.8.1 2.1l4.3 1.3 1.6 5c.3.9 1.4 1.1 2 .4l2.3-2.4 4.4 3.2c.8.6 1.9.1 2.1-.8l3-13.9c.2-1-.8-1.8-1.9-1.2zM9.4 14.6l-.3 3.1-1.1-3.5 8.9-5.6-7.5 6z" />
      </svg>
    </span>
  );
}
