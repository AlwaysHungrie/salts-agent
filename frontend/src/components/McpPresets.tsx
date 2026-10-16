"use client";

import { useEffect, useRef, useState } from "react";
import type { McpAuth, McpCatalogEntry } from "@/lib/agent";

/**
 * A provider whose MCP server is known: the values its server expects, so connecting
 * one is a click rather than a URL to go and find.
 */
export type McpPreset = {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  /** Headers the form starts with, for the user to fill in. */
  headers: Record<string, string>;
  /** The provider's mark, drawn at 24×24. */
  logo: React.ReactNode;
  /** One line on what the server does. */
  description: string;
  /** Fills the whole tile, in place of the plain canvas, when the logo is drawn on it. */
  tile?: string;
};

/** The salt app icon's background, which a salt mark's whole tile is filled with. */
const SALT_TILE = "#141414";

/**
 * The salt app icon's four squares, drawn on a tile already filled with its black, with
 * a catalogue entry's letter at the centre: white, outlined in the entry's colour.
 */
function SaltMark({ letter, color }: { letter: string; color: string }) {
  return (
    <svg aria-hidden="true" width={46} height={46} viewBox="0 0 32 32">
      <rect x="6.5" y="6.5" width="8" height="8" rx="2.2" fill="#fff" />
      <rect
        x="17.5"
        y="6.5"
        width="8"
        height="8"
        rx="2.2"
        fill="#fff"
        fillOpacity="0.45"
      />
      <rect
        x="6.5"
        y="17.5"
        width="8"
        height="8"
        rx="2.2"
        fill="#fff"
        fillOpacity="0.45"
      />
      <rect x="17.5" y="17.5" width="8" height="8" rx="2.2" fill="#fff" />
      <text
        x="16"
        y="16.8"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="17"
        fontWeight="900"
        fill="#fff"
        stroke={color}
        strokeWidth="3"
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {letter}
      </text>
    </svg>
  );
}

/**
 * A catalogue entry as a tile: its SVG icon, or a letter mark when it has none.
 * Templates come from the deployment's settings; the frontend ships none of its own.
 */
export function toPreset(entry: McpCatalogEntry): McpPreset {
  const letter = (entry.letter || entry.name).trim().charAt(0).toUpperCase();
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    auth: entry.auth,
    headers: entry.headers ?? {},
    description: entry.description ?? "",
    tile: !entry.icon && entry.color ? SALT_TILE : undefined,
    logo: entry.icon ? (
      // A plain <img>, not next/image: the icon is a data URL with nothing to optimise,
      // and <img> is what keeps any script inside the SVG from running.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={entry.icon}
        alt=""
        aria-hidden="true"
        width={26}
        height={26}
        className="h-[26px] w-[26px]"
      />
    ) : entry.color ? (
      <SaltMark letter={letter} color={entry.color} />
    ) : (
      <span
        aria-hidden="true"
        className="flex h-[26px] w-[26px] items-center justify-center rounded-lg text-[13px] font-semibold text-white"
        style={{ background: "#6b7280" }}
      >
        {letter}
      </span>
    ),
  };
}

/** How fast the strip drifts, in pixels per second. */
const SPEED = 4;
/** Past this much movement a pointer was dragging the strip, not picking a tile. */
const DRAG_SLOP = 4;

/**
 * The providers, drifting past on a loop.
 *
 * The strip is rendered twice and the offset wraps at half its width, which is what
 * makes the loop seamless. The position is written straight to the node inside the
 * animation frame rather than held in state: it changes sixty times a second, and
 * nothing else in the tree needs to know about it.
 */
export function McpPresetStrip({
  onPick,
  only = [],
  catalog = [],
}: {
  onPick: (preset: McpPreset) => void;
  /** Template ids to show. Empty shows every one in the catalogue. */
  only?: string[];
  /** The templates on offer: the agent's own, or else the deployment's. */
  catalog?: McpCatalogEntry[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  // Hovering and dragging both hold the strip still, so a tile can be aimed at.
  const held = useRef(false);
  const drag = useRef<{ x: number } | null>(null);
  /**
   * Whether the pointer has been captured. Capture is taken only once a gesture is
   * a drag: it retargets the pointer-up to this container, and the browser picks the
   * click's target from where the down and the up landed — so capturing on every
   * pointer-down would move every click off the tile and onto the strip.
   */
  const captured = useRef(false);
  // How far the current gesture has travelled. Read by the click that follows the
  // pointer-up, which is the only way to tell a pick from the end of a drag.
  const moved = useRef(0);
  /** The tile under the pointer, and where its popup sits within the strip. */
  const [hovered, setHovered] = useState<{
    preset: McpPreset;
    x: number;
  } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();

    const step = (now: number) => {
      const elapsed = now - previous;
      previous = now;
      const node = track.current;
      if (node) {
        if (!held.current) offset.current -= (SPEED * elapsed) / 1000;
        // Half the track is one full copy of the strip, so wrapping there puts the
        // identical tile under the cursor and the seam is never visible.
        const half = node.scrollWidth / 2;
        if (half > 0) offset.current = ((offset.current % half) + half) % half;
        node.style.transform = `translateX(${offset.current - half}px)`;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  // One preset would leave most of the strip empty, so the list is repeated until it
  // is wide enough to look like a strip at all — and then doubled, for the wrap.
  // An agent's meta settings may narrow the catalogue; a list that narrowed it to
  // nothing is treated as no restriction.
  const all = catalog.map(toPreset);
  const narrowed = only.length ? all.filter((p) => only.includes(p.id)) : all;
  const presets = narrowed.length ? narrowed : all;
  const filled = Array.from(
    { length: presets.length ? Math.ceil(8 / presets.length) : 0 },
    () => presets,
  ).flat();
  const tiles = [...filled, ...filled];

  if (!presets.length) return null;

  return (
    // The popup sits outside the clipped strip, so it is not cut off by its mask.
    <div ref={wrapper} className="relative">
      <div
        onPointerEnter={() => (held.current = true)}
        onPointerLeave={() => {
          held.current = false;
          drag.current = null;
          setHovered(null);
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX };
          moved.current = 0;
          captured.current = false;
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x;
          drag.current = { x: e.clientX };
          moved.current += Math.abs(dx);
          offset.current += dx;
          setHovered(null);
          // Now it is a drag: hold the pointer so it keeps working past the edges.
          if (!captured.current && moved.current > DRAG_SLOP) {
            captured.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerUp={(e) => {
          if (captured.current)
            e.currentTarget.releasePointerCapture(e.pointerId);
          captured.current = false;
          drag.current = null;
        }}
        // The strip fades out at both edges rather than being cut off. A mask is used
        // instead of a gradient overlay because the section behind it is itself a
        // gradient, which an overlay in a flat colour would band against.
        className="cursor-grab touch-pan-y overflow-hidden py-0 select-none active:cursor-grabbing [mask-image:linear-gradient(to_right,transparent,black_40px,black_calc(100%-40px),transparent)]"
      >
        <div ref={track} className="flex w-max gap-3">
          {tiles.map((preset, i) => (
            <button
              key={`${preset.id}-${i}`}
              aria-label={`Add ${preset.name}`}
              onPointerEnter={(e) => {
                if (drag.current && moved.current > DRAG_SLOP) return;
                const box = wrapper.current?.getBoundingClientRect();
                const tile = e.currentTarget.getBoundingClientRect();
                if (box)
                  setHovered({
                    preset,
                    x: tile.left + tile.width / 2 - box.left,
                  });
              }}
              onClick={() => {
                // A drag that ends on a tile is a drag, not a click on it.
                if (moved.current > DRAG_SLOP) return;
                onPick(preset);
              }}
              className="bg-canvas border-hairline text-ink hover:border-ink flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border transition"
              style={
                preset.tile
                  ? { background: preset.tile, borderColor: preset.tile }
                  : undefined
              }
            >
              {preset.logo}
            </button>
          ))}
        </div>
      </div>
      {hovered && (
        <div
          role="tooltip"
          className="bg-canvas border-hairline pointer-events-none absolute top-full z-20 mt-2 w-60 rounded-2xl border px-4 py-3 shadow-lg"
          style={{
            // Centred on the tile, but kept inside the strip at both ends.
            left: `clamp(0px, ${hovered.x}px - 7.5rem, 100% - 15rem)`,
          }}
        >
          <p className="text-ink text-[13px] font-semibold leading-[1.38]">
            {hovered.preset.name}
          </p>
          {hovered.preset.description && (
            <p className="text-muted mt-1 text-xs leading-[1.4]">
              {hovered.preset.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
