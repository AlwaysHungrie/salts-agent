"use client";

import { useState } from "react";

/**
 * Footer credit, bottom left: the salts mark and "Salts", linking to salts.dev. The mark
 * moves like the one on the salts landing page: every 5 s, and on hover, the tile swells
 * and turns a quarter, then completes the circle while the four grains hold still.
 */
export function PoweredBySalts() {
  // A new key restarts the animation, so hovering plays it from the start.
  const [play, setPlay] = useState(0);

  return (
    <a
      href="https://salts.dev"
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={() => setPlay((n) => n + 1)}
      className="absolute bottom-5 left-5 z-20 flex animate-rain-toggle-in-late items-center gap-2.5 font-orbitron text-sm font-bold tracking-[0.12em] text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.9)] transition-colors duration-300 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60 sm:bottom-6 sm:left-6"
    >
      <span className="relative grid size-8 shrink-0 place-items-center">
        <span key={play} aria-hidden className="salts-tile absolute inset-0 rounded-[10px] bg-[#141414] ring-1 ring-white/20" />
        {/* Salt: four grains that hold their place while the tile turns. */}
        <span className="relative grid grid-cols-2 gap-[3px]">
          <span className="size-[5px] rounded-[1.5px] bg-white" />
          <span className="size-[5px] rounded-[1.5px] bg-white/45" />
          <span className="size-[5px] rounded-[1.5px] bg-white/45" />
          <span className="size-[5px] rounded-[1.5px] bg-white" />
        </span>
      </span>
      Salts
    </a>
  );
}
