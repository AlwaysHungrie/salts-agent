import { unzipSync } from "fflate";

/**
 * The artwork inside a .pkpass, read in the browser to dress the upload box once a ticket is
 * chosen: its logo (the @2x copy when there is one) and its card colours. Nothing here
 * verifies the pass; the server does that.
 */
export type PassArt = {
  logo: Uint8Array | null;
  background: string | null;
  foreground: string | null;
  label: string | null;
};

/** Larger files are not opened here; the server refuses them anyway. */
export const MAX_ART_PASS_BYTES = 5 * 1024 * 1024;

const WANTED = ["pass.json", "logo@2x.png", "logo.png"];

/** A pass colour, if it is one CSS can take as given: hex or `rgb(r, g, b)`. */
function colour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ||
    /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(v)
    ? v
    : null;
}

/** The pass's artwork, or null when the bytes are not a readable pass. */
export function passArt(bytes: Uint8Array): PassArt | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) =>
        WANTED.includes(f.name) && f.originalSize <= MAX_ART_PASS_BYTES,
    });
  } catch {
    return null;
  }
  let pass: Record<string, unknown> = {};
  try {
    pass = files["pass.json"]
      ? JSON.parse(new TextDecoder().decode(files["pass.json"]))
      : {};
  } catch {
    // Colours are optional; the images may still be there.
  }
  return {
    logo: files["logo@2x.png"] ?? files["logo.png"] ?? null,
    background: colour(pass.backgroundColor),
    foreground: colour(pass.foregroundColor),
    label: colour(pass.labelColor),
  };
}
