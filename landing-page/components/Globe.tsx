"use client";

import { useEffect, useRef } from "react";
import { LAND } from "./land";

const SPIN = 40; // seconds per full turn
const TILT = (8 * Math.PI) / 180; // poles leaned back, away from us
const ROLL = (6 * Math.PI) / 180; // and the axis leaned across the screen
const LIT = "#ffffff";

/**
 * A globe whose body is the card's own ink: only the continents and a faint
 * graticule are lit. Orthographic, so the land really does wrap round the far
 * side instead of sliding back and forth.
 */
export function Globe({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let raf = 0;
    let size = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = canvas.clientWidth;
      canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const onResize = () => {
      resize();
      if (reduced) raf = requestAnimationFrame(draw);
    };
    resize();
    window.addEventListener("resize", onResize);

    const draw = (time: number) => {
      const r = size / 2 - 1;
      const cx = size / 2;
      const cy = size / 2;
      const spin = reduced ? 0.6 : (time / 1000 / SPIN) * Math.PI * 2;
      const cosT = Math.cos(TILT);
      const sinT = Math.sin(TILT);
      const cosR = Math.cos(ROLL);
      const sinR = Math.sin(ROLL);

      ctx.clearRect(0, 0, size, size);

      // The sphere sits in the card's own ink; only the land is lit.
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.stroke();

      /** Lon/lat to screen, with a null for points round the back. */
      const project = (lon: number, lat: number) => {
        const la = (lat * Math.PI) / 180;
        const lo = (lon * Math.PI) / 180 + spin;
        const x = Math.cos(la) * Math.sin(lo);
        const y = Math.sin(la);
        const z = Math.cos(la) * Math.cos(lo);
        const yt = y * cosT - z * sinT;
        const zt = y * sinT + z * cosT;
        if (zt <= 0) return null;
        // Roll in the screen plane, so the axis leans rather than standing up.
        const xr = x * cosR - yt * sinR;
        const yr = x * sinR + yt * cosR;
        return [cx + xr * r, cy - yr * r, zt] as const;
      };

      // Graticule: faint cuts, so the rotation has something to read against.
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      const wire = (
        from: number,
        to: number,
        step: number,
        at: (v: number) => readonly [number, number],
      ) => {
        ctx.beginPath();
        let moved = false;
        for (let v = from; v <= to; v += step) {
          const [lon, lat] = at(v);
          const p = project(lon, lat);
          if (!p) {
            moved = false;
            continue;
          }
          if (moved) ctx.lineTo(p[0], p[1]);
          else ctx.moveTo(p[0], p[1]);
          moved = true;
        }
        ctx.stroke();
      };
      for (let lat = -60; lat <= 60; lat += 30) {
        wire(-180, 180, 3, (lon) => [lon, lat]);
      }
      for (let lon = -180; lon < 180; lon += 30) {
        wire(-90, 90, 3, (lat) => [lon, lat]);
      }

      // Land, dot by dot. Dots near the limb dim and shrink, which sells the curve.
      const dot = Math.max(1.1, r / 115);
      for (let i = 0; i < LAND.length; i += 2) {
        const p = project(LAND[i], LAND[i + 1]);
        if (!p) continue;
        ctx.fillStyle = LIT;
        ctx.globalAlpha = 0.35 + 0.65 * p[2];
        ctx.beginPath();
        ctx.arc(p[0], p[1], dot * (0.5 + 0.5 * p[2]), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!reduced) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className={className} />;
}
