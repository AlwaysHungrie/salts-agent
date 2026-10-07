import { describeSessionFailure } from "@/lib/agent";

/**
 * Why an upload failed. The Worker's own refusals are shown; internal-looking errors are
 * replaced with a plain sentence naming the file.
 */
export function uploadFailure(name: string, error?: string): string {
  const raw = error?.trim();
  if (!raw) return `Could not upload ${name}.`;
  const platform = describeSessionFailure(raw);
  if (platform) return platform;
  // Anything long, or shaped like an internal error, is not a sentence for a user.
  if (
    raw.length > 160 ||
    /^[A-Za-z]*Error\b|SQL |stack|at \w+\.|<[a-z!]/i.test(raw)
  ) {
    return `Could not upload ${name}.`;
  }
  return raw;
}

/** m:ss, for player positions and durations. */
export function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The wall-clock time a message was sent, without the date the sidebar already shows. */
export function timeOfDay(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A PDF by mime, or by name when the browser sends no type at all. */
export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** The file types the attach button offers, given which input capabilities are on. */
export function acceptFor(ready: Set<string>): string {
  const accept: string[] = [];
  if (ready.has("file_ingest"))
    accept.push(
      "text/*",
      "application/pdf",
      ".pdf",
      ".md",
      ".csv",
      ".json",
      ".yaml",
      ".ts",
      ".tsx",
      ".py",
      // Workbooks go to an MCP server that reads them; the Worker refuses them without one.
      ".xlsx",
      ".xlsm",
    );
  if (ready.has("vision")) accept.push("image/*");
  // OpenRouter takes WAV and MP3 audio; other containers are rejected on upload.
  if (ready.has("audio_input"))
    accept.push("audio/wav", "audio/mpeg", ".wav", ".mp3");
  return accept.join(",");
}
