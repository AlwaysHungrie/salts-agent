/**
 * What each street sign says: Marathi and Gujarati words (Devcon VIII is in Mumbai), and
 * the marks of Ethereum and other layer 1 chains, drawn as plain shapes in sign-canvas.
 *
 * Chosen per panel, in the order of src/data/scene-panels.json, so no mark repeats and each
 * word gets a panel it fits. A word is split into its aksharas, the units a vertical sign
 * stacks one per cell; a horizontal sign draws the whole word in one run so the letters join
 * as written.
 *
 * Fonts: Noto Sans Devanagari and Gujarati, bold, subset to exactly these words — change a
 * word and the subsets must be rebuilt with pyftsubset (--text with every word,
 * --layout-features='*', --flavor=woff2). SIL Open Font License 1.1, see public/fonts/OFL.txt.
 */

export type SignFace = { family: string; url: string };

export const SIGN_FACES: SignFace[] = [
  { family: "Sign Devanagari", url: "/fonts/NotoSansDevanagari-Bold-subset.woff2" },
  { family: "Sign Gujarati", url: "/fonts/NotoSansGujarati-Bold-subset.woff2" },
];

/** Chain marks, drawn as shapes: Ethereum's diamond, Ξ, a block, and the marks of Bitcoin, Solana, Base, Polygon and Arbitrum. */
export type SignIcon = "diamond" | "xi" | "block" | "bitcoin" | "solana" | "base" | "polygon" | "arbitrum";

/**
 * What one panel says: a word (`font` is a CSS font-family list), or marks. `scale` shrinks
 * it within the sign; `top` puts it at the top of the sign instead of the middle.
 */
export type Sign = ({ kind: "word"; font: string; aksharas: string[] } | { kind: "icons"; icons: SignIcon[] }) & {
  scale?: number;
  top?: boolean;
};

const marathi = (...aksharas: string[]): Sign => ({ kind: "word", font: '"Sign Devanagari"', aksharas });
const gujarati = (...aksharas: string[]): Sign => ({ kind: "word", font: '"Sign Gujarati"', aksharas });
const icons = (...icons: SignIcon[]): Sign => ({ kind: "icons", icons });

/** One per panel, by index into scene-panels.json. */
export const PANEL_SIGNS: Sign[] = [
  marathi("मि", "त्र"), // friend; the big sign on the right
  { ...icons("base", "polygon", "arbitrum"), scale: 0.75 },
  icons("diamond"),
  marathi("व", "डा", "पा", "व"),
  gujarati("ચા"), // tea
  icons("xi", "diamond"),
  { ...gujarati("ન", "મ", "સ્તે"), scale: 0.7 }, // greetings
  icons("solana"),
  { ...icons("bitcoin"), top: true },
  icons("block"),
];
