/**
 * Loading and deterministic selection for the alien signage script.
 *
 * The glyphs themselves live in src/data/alien-alphabet.ts (see that file, and
 * scripts/build-alphabet.py, for where they come from and why they were
 * filtered). This module is only concerned with getting the faces in front of
 * the canvas and picking a stable glyph for a given seed.
 */

import { ALIEN_FACES, ALIEN_GLYPHS } from "@/data/alien-alphabet";

/** Hash a string to a seed so a given panel always renders the same glyphs. */
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
export function loadAlienFaces(): Promise<void> {
  if (loading) return loading;
  if (typeof document === "undefined") return Promise.resolve();

  loading = Promise.all(
    ALIEN_FACES.map(async (spec) => {
      const face = new FontFace(
        spec.family,
        `url(${spec.url}) format("woff2")`,
      );
      await face.load();
      document.fonts.add(face);
    }),
  ).then(() => undefined);

  return loading;
}

/** The glyph for a seed, as a canvas font family and the character to draw. */
export function alienGlyph(seed: number): { family: string; char: string } {
  const [family, char] = ALIEN_GLYPHS[seed % ALIEN_GLYPHS.length];
  return { family, char };
}
