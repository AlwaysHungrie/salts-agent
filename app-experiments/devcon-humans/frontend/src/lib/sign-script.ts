/**
 * Loading and deterministic selection for the street signs' words and marks.
 *
 * The words and fonts live in src/data/sign-words.ts. This module gets the faces in front
 * of the canvas and looks up what each panel says.
 */

import { PANEL_SIGNS, SIGN_FACES, type Sign } from "@/data/sign-words";

/** Hash a string to a seed, for each panel's own flicker phase. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let loading: Promise<void> | null = null;

/**
 * Registers the subset faces and resolves once they are usable by canvas2d.
 * Idempotent, and safe to call before the textures are baked — the sign canvas
 * measures glyphs, so drawing before the faces land would mis-size every sign.
 */
export function loadSignFaces(): Promise<void> {
  if (loading) return loading;
  if (typeof document === "undefined") return Promise.resolve();

  loading = Promise.all(
    SIGN_FACES.map(async (spec) => {
      const face = new FontFace(spec.family, `url(${spec.url}) format("woff2")`);
      await face.load();
      document.fonts.add(face);
    }),
  ).then(() => undefined);

  return loading;
}

/** What panel `index` (in scene-panels.json order) says; a panel without one stays blank. */
export function signFor(index: number): Sign | null {
  return PANEL_SIGNS[index] ?? null;
}
