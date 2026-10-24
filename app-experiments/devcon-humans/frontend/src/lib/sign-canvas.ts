import type { SignIcon } from "@/data/sign-words";
import { hash, signFor } from "./sign-script";

export type Panel = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  depth: number;
  orient: string;
  quad: number[][];
  /** Another panel of the same physical sign (split by wires), to flicker in step with. */
  flickerWith?: number;
  /** Draw the sign upright, square to its long edge, instead of slanted with the quad. */
  upright?: boolean;
};

/**
 * Bakes the street signs (Marathi and Gujarati words, Ethereum marks) into two offscreen
 * textures the scene shader samples alongside the plate.
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

type Draw = { icon: SignIcon } | { font: string; text: string };

// Backlit-lightbox look: the panel is the light source, so signs read as dark cut-outs
// blocking it, with a faint coloured bleed at their edges.
const BLEED = "rgba(120,40,160,0.55)";
const INK = "rgba(9,3,15,0.94)";

/** Text fitted to a boxW × 100 box by its real ink bounds, not its advance width. */
function drawText(sc: CanvasRenderingContext2D, font: string, text: string, boxW: number) {
  sc.font = `100px ${font}`;
  const m = sc.measureText(text);
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const scale = inkW > 0 && inkH > 0 ? Math.min((boxW * 0.9) / inkW, (100 * 0.86) / inkH) : 1;
  sc.font = `${100 * scale}px ${font}`;

  const m2 = sc.measureText(text);
  const tx = boxW / 2 - (m2.actualBoundingBoxRight - m2.actualBoundingBoxLeft) / 2;
  const ty = 50 + (m2.actualBoundingBoxAscent - m2.actualBoundingBoxDescent) / 2;

  // The bleed is a stroke around the same outline the fill covers.
  sc.lineJoin = "round";
  sc.strokeStyle = BLEED;
  sc.lineWidth = 100 * 0.055;
  sc.strokeText(text, tx, ty);
  sc.fillStyle = INK;
  sc.fillText(text, tx, ty);
}

/**
 * A chain mark, drawn in a 100 × 100 square centred in the boxW × 100 box (shrunk when the box
 * is narrower). Marks are ink shapes and heavy ink lines; a coin's symbol is cut out of the
 * ink, so the sign's own light shows through it.
 */
function drawIcon(sc: CanvasRenderingContext2D, icon: SignIcon, boxW: number) {
  const fit = Math.min(1, boxW / 100);
  sc.translate((boxW - 100 * fit) / 2, (100 - 100 * fit) / 2);
  sc.scale(fit, fit);
  sc.lineJoin = "round";

  // Each run of points is one polyline; `true` closes it.
  const poly = (path: Path2D, closed: boolean, ...pts: Vec[]) => {
    pts.forEach(([x, y], k) => (k ? path.lineTo(x, y) : path.moveTo(x, y)));
    if (closed) path.closePath();
    return path;
  };
  const hexagon = (cx: number, cy: number, r: number) =>
    poly(new Path2D(), true, ...Array.from({ length: 6 }, (_, k): Vec => {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    }));
  const fill = (path: Path2D) => {
    sc.strokeStyle = BLEED;
    sc.lineWidth = 5.5;
    sc.stroke(path);
    sc.fillStyle = INK;
    sc.fill(path);
  };
  const line = (path: Path2D, width: number) => {
    sc.strokeStyle = BLEED;
    sc.lineWidth = width + 5.5;
    sc.stroke(path);
    sc.strokeStyle = INK;
    sc.lineWidth = width;
    sc.stroke(path);
  };
  const cut = (draw: () => void) => {
    sc.save();
    sc.globalCompositeOperation = "destination-out";
    sc.fillStyle = sc.strokeStyle = "#000";
    draw();
    sc.restore();
  };
  const coin = () => {
    const disc = new Path2D();
    disc.arc(50, 50, 46, 0, Math.PI * 2);
    fill(disc);
  };

  switch (icon) {
    case "diamond": // the two halves of the ether octahedron
      fill(poly(new Path2D(), true, [50, 6], [78, 52], [50, 67], [22, 52]));
      fill(poly(new Path2D(), true, [50, 73], [78, 58], [50, 94], [22, 58]));
      break;
    case "xi": {
      const path = new Path2D();
      path.rect(18, 12, 64, 13);
      path.rect(28, 44, 44, 12);
      path.rect(18, 75, 64, 13);
      fill(path);
      break;
    }
    case "bitcoin": // a coin with ₿ cut out of it, tilted as on the logo
      coin();
      cut(() => {
        sc.translate(50, 50);
        sc.rotate(0.24);
        sc.translate(-50, -50);
        const b = new Path2D();
        poly(b, false, [36, 24], [36, 76]);
        b.moveTo(36, 24);
        b.lineTo(54, 24);
        b.bezierCurveTo(69, 24, 69, 49, 54, 49);
        b.lineTo(36, 49);
        b.moveTo(36, 49);
        b.lineTo(57, 49);
        b.bezierCurveTo(73, 49, 73, 76, 57, 76);
        b.lineTo(36, 76);
        poly(b, false, [44, 12], [44, 24]);
        poly(b, false, [55, 12], [55, 24]);
        poly(b, false, [44, 76], [44, 88]);
        poly(b, false, [55, 76], [55, 88]);
        sc.lineWidth = 11;
        sc.stroke(b);
      });
      break;
    case "base": // a coin with a bar cut in from the left
      coin();
      cut(() => sc.fillRect(0, 43, 62, 14));
      break;
    case "polygon": // two linked hexagons
      line(hexagon(36, 58, 24), 8);
      line(hexagon(64, 42, 24), 8);
      break;
    case "arbitrum": // a hexagon with two slanted strokes, an A, inside
      line(hexagon(50, 50, 44), 7);
      line(poly(new Path2D(), false, [32, 74], [48, 30]), 9);
      line(poly(new Path2D(), false, [50, 74], [66, 30]), 9);
      break;
    case "solana": // three slanted bars, the middle one facing the other way
      fill(poly(new Path2D(), true, [30, 14], [92, 14], [70, 32], [8, 32]));
      fill(poly(new Path2D(), true, [8, 41], [70, 41], [92, 59], [30, 59]));
      fill(poly(new Path2D(), true, [30, 68], [92, 68], [70, 86], [8, 86]));
      break;
    case "block": { // a cube, three faces showing
      const path = poly(new Path2D(), true, [50, 12], [84, 31], [84, 69], [50, 88], [16, 69], [16, 31]);
      poly(path, false, [16, 31], [50, 50], [84, 31]);
      poly(path, false, [50, 50], [50, 88]);
      line(path, 9);
      break;
    }
  }
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
    const vertical = len(ey) >= len(ex);
    const sign = signFor(i);

    // What goes in which cells: a word across a horizontal sign is one run, so its letters
    // join as written; a vertical sign stacks it an akshara per cell, and its marks one per cell.
    const draws: Draw[] = !sign
      ? []
      : sign.kind === "icons"
        ? sign.icons.map((icon) => ({ icon }))
        : vertical
          ? sign.aksharas.map((text) => ({ font: sign.font, text }))
          : [{ font: sign.font, text: sign.aksharas.join("") }];

    const pad = 0.13;
    const span = 1 - pad * 2;
    // Cells about as long as the sign is wide, so a short word on a tall sign stays together,
    // centred, instead of spreading out.
    const [alongPx, acrossPx] = vertical ? [len(ey), len(ex)] : [len(ex), len(ey)];
    const size = sign?.scale ?? 1;
    const cell = Math.min(span / Math.max(draws.length, 1), (acrossPx * span * 1.15) / alongPx) * size;
    const start = sign?.top ? pad : pad + (span - cell * draws.length) / 2;
    const across = span * size;
    const side = pad + (span - across) / 2;

    draws.forEach((draw, k) => {
      // This cell inside the quad, as fractions of its edges.
      const along = start + k * cell + cell * 0.06;
      const length = cell * 0.88;
      const gx = vertical ? side : along;
      const gy = vertical ? along : side;
      const gw = vertical ? across : length;
      const gh = vertical ? length : across;

      // The cell's own axes in plate pixels: along the quad's edges, or, for an upright sign,
      // square to its long edge so nothing is sheared.
      const center = add(add(tl, mul(ex, gx + gw / 2)), mul(ey, gy + gh / 2));
      let cx: Vec, cy: Vec;
      if (!p.upright) {
        cx = mul(ex, gw);
        cy = mul(ey, gh);
      } else if (vertical) {
        cy = mul(ey, gh);
        const across: Vec = [cy[1] / len(cy), -cy[0] / len(cy)];
        cx = mul(across, Math.abs(ex[0] * across[0] + ex[1] * across[1]) * gw);
      } else {
        cx = mul(ex, gw);
        const down: Vec = [-cx[1] / len(cx), cx[0] / len(cx)];
        cy = mul(down, Math.abs(ey[0] * down[0] + ey[1] * down[1]) * gh);
      }
      const origin = sub(sub(center, mul(cx, 0.5)), mul(cy, 0.5));

      // A box 100 high and as wide as the cell really is, so nothing is stretched: sizing is
      // independent of how large the cell lands on the plate, and glyphs keep their shape.
      const boxW = (100 * len(cx)) / Math.max(len(cy), 1e-6);
      sc.save();
      sc.setTransform(cx[0] / boxW, cx[1] / boxW, cy[0] / 100, cy[1] / 100, origin[0], origin[1]);
      if ("icon" in draw) drawIcon(sc, draw.icon, boxW);
      else drawText(sc, draw.font, draw.text, boxW);
      sc.restore();
    });

    // Phase + mask over the panel's quad.
    const k = p.flickerWith ?? i;
    const ph = Math.round(((hash(`p${k}${panels[k].color}`) % 997) / 997) * 255);
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
