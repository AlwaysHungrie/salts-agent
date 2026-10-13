// The drawing and keyboard pieces of the dashboard, the same ones admin-cli uses: rows
// of padded columns, a whole-screen repaint per change, and raw keypresses split apart.

export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const INV = "\x1b[7m";
export const OFF = "\x1b[0m";

/**
 * A cell's colour. Each one ends with its own reset rather than OFF, so a coloured cell
 * inside the inverted selection row leaves the rest of the row inverted.
 */
const TONES = {
  good: ["\x1b[32m", "\x1b[39m"],
  busy: ["\x1b[33m", "\x1b[39m"],
  bad: ["\x1b[31m", "\x1b[39m"],
  off: ["\x1b[2m", "\x1b[22m"],
};

export const paint = (text, tone) => (TONES[tone] ? `${TONES[tone][0]}${text}${TONES[tone][1]}` : text);

export const pad = (s, n) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** `text` broken at spaces into at most `lines` lines of `n`, the last cut with "…" if need be. */
export function wrap(text, n, lines = 2) {
  const out = [];
  let rest = text.trim();
  while (rest && out.length < lines) {
    if (rest.length <= n || out.length === lines - 1) {
      out.push(pad(rest, n).trimEnd());
      break;
    }
    let cut = rest.lastIndexOf(" ", n);
    if (cut <= 0) cut = n;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return out;
}

/**
 * One row's text, exactly `width` columns: each column padded to its width, the last
 * (width 0) taking what is left. A cell is a string, or `{ text, tone }` to colour it.
 */
export function rowText(cells, columns, width) {
  let out = "";
  let used = 0;
  columns.forEach(([, w], i) => {
    const cell = cells[i] ?? "";
    const { text, tone } = typeof cell === "string" ? { text: cell } : cell;
    const room = Math.max(0, width - used);
    const shown = w && w < room ? `${pad(text, w)} ` : pad(text, room);
    used += shown.length;
    out += paint(shown, tone);
  });
  return used < width ? out + " ".repeat(width - used) : out;
}

/**
 * Split one read into individual keypresses. A terminal usually delivers one at a
 * time, but not always — an arrow key is three bytes, and a held key or a paste can
 * arrive as one chunk — so escape sequences are kept whole and everything else is
 * one character.
 */
export function keys(chunk) {
  const out = [];
  for (let i = 0; i < chunk.length; ) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
      out.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      out.push(chunk[i]);
      i++;
    }
  }
  return out;
}

/** Keep a list's window on its selection, scrolling a row at a time. */
export function follow(pos, count, size) {
  pos.sel = Math.max(0, Math.min(pos.sel, count - 1));
  if (pos.sel < pos.top) pos.top = pos.sel;
  if (pos.sel > pos.top + size - 1) pos.top = pos.sel - size + 1;
  pos.top = Math.max(0, Math.min(pos.top, Math.max(0, count - size)));
}
