import type { Attachment } from "./types";

export const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|log|html?|xml|css|jsx?|tsx?|py|rb|go|rs|java|kt|c|h|cpp|sh|sql)$/i;

/** Where parses are kept: outside the workspace tree the model is shown. */
export const PARSE_CACHE_DIR = ".parse-cache";

/** Where an attachment's bytes sit in the workspace. */
export function uploadPath(id: string, name: string): string {
  return `uploads/${id}/${safeName(name)}`;
}

/** A file name the workspace can hold: no separators, no traversal, never empty. */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[/\\]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 100) || "file";
}

export function isAudioAttachment(a: Attachment): boolean {
  return a.mime.startsWith("audio/") || a.mime.startsWith("video/");
}

/** A PDF by mime, or by name when the browser sends no type at all. */
export function isPdf(mime: string, name: string): boolean {
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}

/** Attachment rows carry a whole file; the API sends everything except the bytes. */
export function publicAttachment(a: Attachment) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    bytes: a.bytes,
    chars: a.text.length,
    // Enough of the text (or of an audio transcript, once one exists) for the UI.
    preview: a.kind === "text" ? a.text.slice(0, 400) : "",
    /** Whether a first-page image exists to draw on the file card. */
    thumb: a.thumb_path !== "",
  };
}

export function isTextLike(mime: string, name: string): boolean {
  return (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    TEXT_EXTENSIONS.test(name)
  );
}

export function formatMb(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} kB`;
}

/** The audio format OpenRouter expects; unknown containers are reported here. */
export function audioFormat(mime: string, name: string): string {
  const subtype = mime.split("/")[1]?.split(";")[0]?.toLowerCase() ?? "";
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const candidate = AUDIO_FORMATS[subtype] ?? AUDIO_FORMATS[extension];
  if (!candidate) {
    throw new Error(
      `${name} is not an audio format transcription accepts. WAV, MP3 and Ogg Opus work.`
    );
  }
  return candidate;
}

/** Ogg is accepted because every voice note is Ogg Opus; the transcription model decides. */
export const AUDIO_FORMATS: Record<string, string> = {
  wav: "wav",
  wave: "wav",
  "x-wav": "wav",
  mp3: "mp3",
  mpeg: "mp3",
  mpga: "mp3",
  ogg: "ogg",
  opus: "ogg",
};
