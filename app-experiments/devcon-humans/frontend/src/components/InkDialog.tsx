"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

const noSubscribe = () => () => {};

/**
 * A trigger → ink-spiral wipe → full-screen dialog. From mooned's "What is this?".
 *
 * The wipe is drawn on a canvas that is never cleared between frames: five
 * dots are stamped along their paths every frame, so the accumulated stamps
 * *are* the streaks trailing behind them. As the dots swell the arms thicken
 * until they merge and the page is solid black — no separate fade needed,
 * though the last stretch tops the canvas up to pure black so the handoff to
 * the dialog can never show a seam.
 */

const DOTS = 5;
const GAP_DEG = 360 / 5; // angular gap between neighbouring dots — a tight fan
const SPIN_TURNS = 3.55; // full rotations each dot makes on the way out
const SUBSTEPS = 8; // stamps per frame — keeps fast arcs from going dotty
const SWEEP_MS = 1500;
const SEAL_FROM = 0.38; // fraction of the sweep where the black top-up starts
const FADE_MS = 520;

type Phase = "idle" | "sweep" | "open" | "closing";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export default function InkDialog({
  label,
  trigger,
  children,
}: {
  /** The dialog's accessible name. */
  label: string;
  /** What opens it, given the function that does. */
  trigger: (open: () => void) => React.ReactNode;
  /** The dialog's contents, or a function of the one that closes it. */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);

  const open = useCallback(() => {
    if (phase !== "idle") return;
    setPhase("sweep");
  }, [phase]);

  // Guarded through the updater so a pointerdown and the click that follows it
  // (or a second press mid-fade) cannot queue two teardowns.
  const close = useCallback(() => {
    setPhase((p) => (p === "open" ? "closing" : p));
  }, []);

  // The fade-out owns its own timer, so it is cancelled if the overlay goes
  // away first.
  useEffect(() => {
    if (phase !== "closing") return;
    const id = window.setTimeout(() => setPhase("idle"), FADE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  // Escape closes the dialog once it is up.
  useEffect(() => {
    if (phase !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, close]);

  // The sweep itself.
  useEffect(() => {
    if (phase !== "sweep") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#000";

    const cx = w / 2;
    const cy = h / 2;
    // Far corner, so the arms overshoot the viewport rather than stopping at it.
    const maxR = Math.hypot(w, h) / 2;

    const stamp = (t: number) => {
      // Dots fade up from nothing over the first sliver of the sweep.
      ctx.globalAlpha = Math.min(1, t / 0.1);
      const e = easeOut(t);
      const r = maxR * Math.pow(t, 1.7);
      const size = 2 + maxR * 0.75 * Math.pow(t, 2.3);
      for (let i = 0; i < DOTS; i++) {
        // Centred fan: the five sit GAP_DEG apart around a shared heading
        // rather than spread evenly round the circle.
        const fan = (i - (DOTS - 1) / 2) * GAP_DEG * (Math.PI / 180);
        const a = fan + SPIN_TURNS * Math.PI * 2 * e;
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(a) * r,
          cy + Math.sin(a) * r,
          size,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    };

    const start = performance.now();
    let prev = 0;

    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / SWEEP_MS);
      // Walk from the previous frame's t to this one so the trail is continuous
      // even when a frame is dropped.
      for (let s = 1; s <= SUBSTEPS; s++) {
        stamp(prev + ((t - prev) * s) / SUBSTEPS);
      }
      prev = t;

      // Tail end: pour black over whatever gaps the arms left behind.
      if (t > SEAL_FROM) {
        ctx.globalAlpha = Math.pow((t - SEAL_FROM) / (1 - SEAL_FROM), 2);
        ctx.fillRect(0, 0, w, h);
      }

      if (t < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        ctx.globalAlpha = 1;
        ctx.fillRect(0, 0, w, h);
        setPhase("open");
      }
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  // A trigger may sit inside a pointer-events-none stack that
  // owns its own stacking context — so the overlay is portalled to <body> to
  // keep it clickable, scrollable, and above everything else.
  const mounted = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

  const showing = phase !== "idle";

  return (
    <>
      {trigger(open)}

      {mounted &&
        showing &&
        createPortal(
          <div
            className="pointer-events-auto fixed inset-0 z-50 transition-opacity duration-500"
            style={{ opacity: phase === "closing" ? 0 : 1 }}
          >
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden
            />

            {phase !== "sweep" && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label={label}
                onClick={close}
                className="absolute inset-0 bg-black"
              >
                <button
                  type="button"
                  onPointerDown={close}
                  onClick={close}
                  aria-label="Close"
                  className="pointer-events-auto absolute right-5 top-5 z-20 flex size-11 animate-what-fade-in items-center justify-center rounded-full border border-white/15 text-white/60 transition-colors duration-300 hover:border-white/40 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
                >
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    className="size-5"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>

                <div
                  onClick={(e) => e.stopPropagation()}
                  className="h-full animate-what-fade-in overflow-y-auto overscroll-contain px-6 py-24 sm:px-10"
                >
                  {typeof children === "function" ? children(close) : children}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
