"use client";

import { useState } from "react";

import { CAPABILITIES } from "./content";

/**
 * The capabilities card, where every capability pill is a switch. A light in the
 * top-right corner grows brighter and wider with each switch that is on, so
 * turning things on visibly costs something, the way it does in the product.
 */
export function CapabilityPanel() {
  const [on, setOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      CAPABILITIES.items.map((c) => [
        c,
        !(CAPABILITIES.offByDefault as readonly string[]).includes(c),
      ]),
    ),
  );

  // The light works in steps, not a smooth share: at or below LIGHT_OFF switches
  // the bulb is dark, at LIGHT_FULL or more it is at full strength, and each switch
  // in between is one large step.
  const count = CAPABILITIES.items.filter((c) => on[c]).length;
  const share = Math.min(
    1,
    Math.max(0, (count - LIGHT_OFF) / (LIGHT_FULL - LIGHT_OFF)),
  );

  return (
    <div className="relative overflow-hidden rounded-[32px] bg-canvas-soft px-5 py-7 sm:p-8 lg:p-12">
      {/* The light: a bulb in the top-right corner and the glow it throws, centred on
          it. With few switches on the bulb is an unlit grey and the glow is faint;
          each switch warms the bulb and widens and brightens the glow. */}
      <div aria-hidden className="pointer-events-none absolute top-10 right-10">
        <div
          className="absolute top-0 left-0 aspect-square w-[min(160vw,1800px)] rounded-full bg-[radial-gradient(closest-side,rgba(255,240,200,1)_0%,rgba(255,220,150,0.7)_8%,rgba(255,210,130,0.32)_26%,rgba(255,210,130,0.1)_45%,rgba(255,210,130,0)_65%)] transition-[opacity,transform] duration-700 ease-out"
          style={{
            opacity: share,
            transform: `translate(-50%, -50%) scale(${0.45 + 0.55 * share})`,
          }}
        />
        <div
          className="absolute size-9 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background,box-shadow] duration-700 ease-out"
          style={{
            background: `radial-gradient(circle at 50% 45%, ${mix(GREY_CORE, WARM_CORE, share)} 0%, ${mix(GREY_CORE, WARM_CORE, share)} 35%, ${mix(GREY_EDGE, WARM_EDGE, share)} 100%)`,
            boxShadow: `0 0 ${10 + 70 * share}px ${24 * share}px rgba(255,214,130,${0.85 * share}), inset 0 0 0 1px rgba(0,0,0,${0.07 * (1 - share)})`,
          }}
        />
      </div>

      <div className="relative max-w-[560px]">
        <h2 className="text-[clamp(26px,3.5vw,34px)] font-[650] leading-[1.1] tracking-[-0.025em]">
          {CAPABILITIES.title}
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-muted sm:mt-4 sm:text-base">
          {CAPABILITIES.body}
        </p>
      </div>

      <div className="relative mt-6 flex flex-wrap gap-1.5 sm:mt-8 sm:gap-2">
        {CAPABILITIES.items.map((c) => (
          <button
            key={c}
            role="switch"
            aria-checked={on[c]}
            onClick={() => setOn((s) => ({ ...s, [c]: !s[c] }))}
            className={`cursor-pointer rounded-full px-3 py-1.5 text-[13px] ring-1 transition-colors sm:px-4 sm:py-2 sm:text-sm ${
              on[c]
                ? "bg-canvas text-ink ring-hairline-soft"
                : "bg-transparent text-faint ring-hairline"
            }`}
          >
            {c}
          </button>
        ))}
        <span className="rounded-full px-3 py-1.5 text-[13px] text-faint ring-1 ring-hairline sm:px-4 sm:py-2 sm:text-sm">
          {CAPABILITIES.more}
        </span>
      </div>
    </div>
  );
}

/** Switches on at or below which the bulb is dark. */
const LIGHT_OFF = 4;

/** Switches on at or above which the light is at full strength. */
const LIGHT_FULL = 11;

/* The bulb's colours, unlit and lit, as [r, g, b]. */
const GREY_CORE = [246, 246, 246];
const GREY_EDGE = [214, 214, 214];
const WARM_CORE = [255, 253, 244];
const WARM_EDGE = [255, 214, 130];

/** A colour `t` of the way from `a` to `b`. */
function mix(a: number[], b: number[], t: number) {
  const [r, g, bl] = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${r}, ${g}, ${bl})`;
}
