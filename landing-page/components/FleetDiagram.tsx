"use client";

import { motion, useInView, useReducedMotion } from "framer-motion";
import { useRef } from "react";

import { FLEET } from "./content";

/**
 * One to many, drawn: the fleet owner in the middle, whose key every agent runs
 * on, and a ring of community members around them, each with an
 * agent of their own. Pulses travel outward along the lines, because everything
 * the members' agents run on comes from the middle.
 */

/** Soft tints for the member avatars, as [background, text]. */
const TINTS: [string, string][] = [
  ["#FFEDD5", "#C2410C"],
  ["#DCFCE7", "#15803D"],
  ["#E0F2FE", "#0369A1"],
  ["#EDE9FE", "#6D28D9"],
  ["#FFE4E6", "#BE123C"],
  ["#FEF3C7", "#B45309"],
  ["#CCFBF1", "#0F766E"],
  ["#E2E8F0", "#334155"],
];

/** Distance from the centre to each member, as a share of the box. */
const RADIUS = 40;

export function FleetDiagram({ className = "" }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { once: true, margin: "-80px" });
  const reduced = useReducedMotion();
  const members = FLEET.members;

  const at = (i: number) => {
    const angle = ((-90 + (360 / members.length) * i) * Math.PI) / 180;
    return { x: 50 + RADIUS * Math.cos(angle), y: 50 + RADIUS * Math.sin(angle) };
  };

  return (
    <div
      ref={box}
      aria-hidden
      className={`relative mx-auto aspect-square w-full max-w-[520px] select-none ${className}`}
    >
      {/* The lines, and the pulses that run out along them. */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible">
        {members.map((_, i) => {
          const p = at(i);
          return (
            <g key={i}>
              <motion.line
                x1={50}
                y1={50}
                x2={p.x}
                y2={p.y}
                stroke="var(--color-hairline)"
                strokeWidth={0.35}
                initial={reduced ? false : { pathLength: 0 }}
                animate={seen ? { pathLength: 1 } : undefined}
                transition={{ duration: 0.6, delay: 0.2 + i * 0.08, ease: "easeOut" }}
              />
              {!reduced && seen && (
                <motion.circle
                  r={0.8}
                  fill="var(--color-accent)"
                  initial={{ cx: 50, cy: 50, opacity: 0 }}
                  animate={{ cx: [50, p.x], cy: [50, p.y], opacity: [0, 1, 0] }}
                  transition={{
                    duration: 1.8,
                    delay: 1.2 + i * 0.35,
                    repeat: Infinity,
                    // One pulse leaves the middle every 0.35s, so they go round as a wave.
                    repeatDelay: members.length * 0.35 - 1.8,
                    ease: "easeInOut",
                  }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Under the owner, above the lines: a disc of page colour, so the lines seem
          to start at its edge and never run under the owner's labels. */}
      <div className="absolute top-1/2 left-1/2 aspect-square w-[50%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-canvas" />

      {/* The members, each with an agent of their own. The avatar sits exactly on
          its point; the name goes above it in the top half, below it otherwise. */}
      {members.map((name, i) => {
        const p = at(i);
        const [bg, fg] = TINTS[i % TINTS.length];
        const above = p.y < 40;
        return (
          <motion.div
            key={name}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            initial={reduced ? false : { opacity: 0, scale: 0.6 }}
            animate={seen ? { opacity: 1, scale: 1 } : undefined}
            transition={{ duration: 0.45, delay: 0.5 + i * 0.08, ease: [0.22, 1, 0.36, 1] }}
          >
            <span
              className="flex size-11 items-center justify-center rounded-full text-[15px] font-semibold ring-4 ring-canvas sm:size-12"
              style={{ background: bg, color: fg }}
            >
              {name[0]}
            </span>
            <AgentBadge />
            <span
              className={`absolute left-1/2 -translate-x-1/2 text-[11px] font-medium whitespace-nowrap text-muted ${
                above ? "bottom-full mb-1.5" : "top-full mt-1.5"
              }`}
            >
              {name}
            </span>
          </motion.div>
        );
      })}

      {/* The owner: whose key every agent in the fleet runs on. */}
      <motion.div
        className="absolute top-1/2 left-1/2 flex w-[46%] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={seen ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="flex items-center gap-1.5 rounded-full bg-canvas-soft px-2.5 py-1 text-[10px] font-medium text-muted text-balance sm:text-[11px]">
          <KeyIcon />
          {FLEET.owner.key}
        </span>
        <span className="mt-3 flex size-16 items-center justify-center rounded-full bg-ink text-2xl font-semibold text-white shadow-[0_14px_30px_-12px_rgba(20,20,20,0.5)] sm:size-20 sm:text-[28px]">
          {FLEET.owner.name[0]}
        </span>
        <span className="mt-2.5 text-sm font-semibold sm:text-base">{FLEET.owner.name}</span>
        <span className="text-[11px] text-faint sm:text-xs">{FLEET.owner.role}</span>
      </motion.div>
    </div>
  );
}

/** The Salts mark, small, on a member's avatar: this person has an agent. */
function AgentBadge() {
  return (
    <span className="absolute -right-1 -bottom-1 grid size-5 grid-cols-[4px_4px] place-content-center gap-[2px] rounded-[6px] bg-ink ring-2 ring-canvas">
      <span className="size-1 rounded-[1px] bg-white" />
      <span className="size-1 rounded-[1px] bg-white" />
      <span className="size-1 rounded-[1px] bg-white/50" />
      <span className="size-1 rounded-[1px] bg-white" />
    </span>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3 shrink-0">
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <circle cx="8" cy="15" r="4" />
        <path d="M11 12l8-8M16 7l2 2M14 9l2 2" />
      </g>
    </svg>
  );
}
