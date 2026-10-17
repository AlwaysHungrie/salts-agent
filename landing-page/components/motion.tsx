"use client";

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/** Fade-and-rise on entry. Restrained by design: 12px, half a second, once. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-10% 0px -10% 0px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Staggers its Reveal-like children by index. */
export function RevealGroup({
  children,
  className,
  step = 0.06,
}: {
  children: ReactNode[];
  className?: string;
  step?: number;
}) {
  return (
    <div className={className}>
      {children.map((child, i) => (
        <Reveal key={i} delay={i * step}>
          {child}
        </Reveal>
      ))}
    </div>
  );
}

/* --------------------------------------------------- Hero squircles -- */

/** How much further the squircles hold on screen once the hero has passed,
 *  in viewport heights of scroll. Raise it to keep them around longer. */
const HOLD_VH = 0.1;

/** How much scroll the exit itself takes, in viewport heights. */
const EXIT_VH = 0.3;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const SQUIRCLES = [
  { className: "left-[6%] top-[22%] size-16", delay: 0.1, amp: 14, phase: 0 },
  {
    className: "left-[13%] top-[52%] size-12",
    delay: 0.18,
    amp: 10,
    phase: 1.3,
  },
  {
    className: "right-[7%] top-[28%] size-20",
    delay: 0.26,
    amp: 16,
    phase: 2.4,
  },
  {
    className: "right-[15%] top-[58%] size-12",
    delay: 0.34,
    amp: 10,
    phase: 3.7,
  },
];

/**
 * The four squircle slots. They start stacked at the centre of the viewport,
 * fly out to their resting spots, then rock left and right as the page scrolls.
 * They stay pinned to the viewport through the hero and its chat placeholder,
 * then slide up and out.
 */
export function HeroSquircles() {
  // Spans the hero, so it tells us when the section — chat placeholder and all —
  // has finished passing the viewport.
  const span = useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll();

  // Measured in viewport heights of scroll past the end of the hero.
  const [exit, setExit] = useState({ start: Infinity, end: Infinity });
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const measure = () => {
      const el = span.current;
      if (!el) return;
      const vh = window.innerHeight;
      const bottom = el.getBoundingClientRect().bottom + window.scrollY;
      const start = bottom - vh + HOLD_VH * vh;
      setExit({ start, end: start + EXIT_VH * vh });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const progress = useTransform(scrollY, (v) =>
    clamp01((v - exit.start) / Math.max(1, exit.end - exit.start)),
  );
  const exitY = useTransform(progress, [0, 1], [0, -900]);
  const exitOpacity = useTransform(progress, [0, 0.7], [1, 0]);

  const layer = (
    <motion.div
      aria-hidden
      style={{ y: exitY, opacity: exitOpacity }}
      className="pointer-events-none fixed inset-0 z-10 hidden lg:block"
    >
      {SQUIRCLES.map((s) => (
        <Squircle key={s.className} {...s} />
      ))}
    </motion.div>
  );

  return (
    <>
      <div
        ref={span}
        aria-hidden
        className="pointer-events-none absolute inset-0"
      />
      {/* The page sheet is its own stacking context, so the squircles are
          portalled out to sit above the header and everything else. */}
      {mounted ? createPortal(layer, document.body) : null}
    </>
  );
}

function Squircle({
  className,
  delay,
  amp,
  phase,
}: {
  className: string;
  delay: number;
  amp: number;
  phase: number;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(0.4);
  const opacity = useMotionValue(0);

  const { scrollY } = useScroll();
  const sway = useSpring(
    useTransform(scrollY, (v) =>
      reduced ? 0 : Math.sin(v / 50 + phase) * amp,
    ),
    { stiffness: 220, damping: 16, mass: 0.4 },
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (reduced) {
      opacity.set(1);
      scale.set(1);
      return;
    }

    // Measure where this slot rests, then start it from the middle of the screen.
    const r = el.getBoundingClientRect();
    x.set(window.innerWidth / 2 - (r.left + r.width / 2));
    y.set(window.innerHeight / 2 - (r.top + r.height / 2));

    const travel = { duration: 1.1, delay, ease: [0.16, 1, 0.3, 1] as const };
    const controls = [
      animate(x, 0, travel),
      animate(y, 0, travel),
      animate(scale, 1, travel),
      animate(opacity, 1, { duration: 0.4, delay }),
    ];
    return () => controls.forEach((c) => c.stop());
  }, [delay, opacity, reduced, scale, x, y]);

  return (
    <motion.div className={`absolute ${className}`} style={{ x: sway }}>
      <motion.div
        ref={ref}
        style={{ x, y, scale, opacity }}
        className="squircle size-full bg-canvas-soft ring-1 ring-hairline-soft"
      />
    </motion.div>
  );
}

/* ------------------------------------------------------------ CountUp -- */

/**
 * Counts to a number the first time it is scrolled into view. Reduced motion
 * gets the final number straight away.
 */
export function CountUp({
  to,
  decimals = 0,
  suffix = "",
  duration = 1.6,
  className = "",
}: {
  to: number;
  decimals?: number;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);

  const show = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }) + suffix;

  const [text, setText] = useState(() => show(reduced ? to : 0));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      setText(show(to));
      return;
    }

    let controls: { stop: () => void } | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        controls = animate(0, to, {
          duration,
          ease: [0.16, 1, 0.3, 1],
          onUpdate: (n) => setText(show(n)),
        });
      },
      { threshold: 0.4 },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      controls?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, reduced, to, decimals, suffix]);

  return (
    <span ref={ref} className={`tnum ${className}`}>
      {text}
    </span>
  );
}
