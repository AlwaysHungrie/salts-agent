import { alienGlyph, hash } from "./alien-script";

export type Panel = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  depth: number;
  orient: string;
  quad: number[][];
};

/**
 * Bakes the alien signage into two offscreen textures the scene shader samples
 * alongside the plate.
 *
 * signs  RGBA — glyph colour and coverage, drawn into each panel's quad.
 * phase  RG   — R: a per-panel flicker phase, G: the panel mask. Keeping these
 *               apart lets every sign flicker on its own schedule from a pair
 *               of static textures, with no per-frame re-upload.
 */

const PHASE_DIV = 8; // the phase texture only needs region granularity

type Vec = [number, number];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec) => Math.hypot(a[0], a[1]);

/** How many glyphs fit, and along which axis, given the quad's real proportions. */
function layout(ex: Vec, ey: Vec) {
  const lx = len(ex);
  const ly = len(ey);
  const vertical = ly >= lx;
  const ratio = vertical ? ly / Math.max(lx, 1) : lx / Math.max(ly, 1);
  return { vertical, count: Math.max(1, Math.min(6, Math.round(ratio))) };
}

export function buildSignTextures(panels: Panel[], W: number, H: number) {
  const signs = document.createElement("canvas");
  signs.width = W;
  signs.height = H;
  const sc = signs.getContext("2d")!;

  const phase = document.createElement("canvas");
  phase.width = Math.ceil(W / PHASE_DIV);
  phase.height = Math.ceil(H / PHASE_DIV);
  const pc = phase.getContext("2d")!;

  panels.forEach((p, i) => {
    const tl = p.quad[0] as Vec;
    const ex = sub(p.quad[1] as Vec, tl); // top edge
    const ey = sub(p.quad[3] as Vec, tl); // left edge
    const { vertical, count } = layout(ex, ey);

    const seed = hash(`${p.x}:${p.y}:${p.color}`);

    const pad = 0.13;
    const span = 1 - pad * 2;
    const cell = span / count;

    for (let g = 0; g < count; g++) {
      // Place this glyph's cell inside the quad, in plate pixel space.
      const gx = vertical ? pad : pad + g * cell;
      const gy = vertical ? pad + g * cell : pad;
      const gw = vertical ? span : cell * 0.88;
      const gh = vertical ? cell * 0.88 : span;

      const origin = add(add(tl, mul(ex, gx)), mul(ey, gy));
      const cx = mul(ex, gw); // cell's own x basis
      const cy = mul(ey, gh); // cell's own y basis

      const { family, char } = alienGlyph(
        (seed + Math.imul(g, 2654435761)) >>> 0,
      );

      // Work in a 100x100 design box mapped onto the cell, so glyph sizing is
      // independent of how large the cell lands on the plate.
      sc.save();
      sc.setTransform(
        cx[0] / 100,
        cx[1] / 100,
        cy[0] / 100,
        cy[1] / 100,
        origin[0],
        origin[1],
      );

      // Fit the glyph to the box by its real ink bounds. These faces have very
      // uneven side bearings across the three scripts, so trusting the advance
      // width would leave some signs floating off-centre.
      sc.font = `100px "${family}"`;
      const m = sc.measureText(char);
      const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      const scale =
        inkW > 0 && inkH > 0 ? (100 * 0.86) / Math.max(inkW, inkH) : 1;
      sc.font = `${100 * scale}px "${family}"`;

      const m2 = sc.measureText(char);
      const tx =
        50 - (m2.actualBoundingBoxRight - m2.actualBoundingBoxLeft) / 2;
      const ty =
        50 + (m2.actualBoundingBoxAscent - m2.actualBoundingBoxDescent) / 2;

      // Backlit-lightbox look: the panel is the light source, so glyphs read as
      // dark cut-outs blocking it, with a faint coloured bleed at their edges.
      // The bleed is a stroke around the same outline the fill covers.
      sc.lineJoin = "round";
      sc.strokeStyle = "rgba(120,40,160,0.55)";
      sc.lineWidth = 100 * 0.055;
      sc.strokeText(char, tx, ty);

      sc.fillStyle = "rgba(9,3,15,0.94)";
      sc.fillText(char, tx, ty);

      sc.restore();
    }

    // Phase + mask over the panel's quad.
    const ph = Math.round(((hash(`p${i}${p.color}`) % 997) / 997) * 255);
    pc.save();
    pc.scale(1 / PHASE_DIV, 1 / PHASE_DIV);
    pc.fillStyle = `rgb(${ph},255,0)`;
    pc.beginPath();
    p.quad.forEach((q, k) =>
      k ? pc.lineTo(q[0], q[1]) : pc.moveTo(q[0], q[1]),
    );
    pc.closePath();
    pc.fill();
    pc.restore();
  });

  sc.setTransform(1, 0, 0, 1, 0, 0);
  return { signs, phase };
}
