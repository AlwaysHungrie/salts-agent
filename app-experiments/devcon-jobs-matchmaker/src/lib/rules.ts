/**
 * What a user may send. Pure, so the browser and the server apply the same rules.
 */

/** Messages a user may send in one chat before they must clear it. */
export const MAX_MESSAGES = 25;

/** How often a user may clear their chat. */
export const CLEAR_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** How often a user may replace their resume. */
export const RESUME_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** When a resume added at `addedAt` may next be replaced, or null when it may be now. */
export function resumeUpdatableAt(addedAt: Date | string, now: Date = new Date()): Date | null {
  const at = new Date(new Date(addedAt).getTime() + RESUME_COOLDOWN_MS);
  return at > now ? at : null;
}

/** Longest message a user may send in one turn. */
export const MAX_MESSAGE_CHARS = 4000;

/** Largest resume accepted, in bytes. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The message a resume is sent to the agent with. */
export const ADD_CANDIDATE =
  "Add candidate. In your reply, always state the candidate id the tool returned, also when the resume was a " +
  "duplicate or updated an existing candidate.";

/**
 * The message a user's previous candidate is deleted with when they upload a new
 * resume. Only ever built from an id this app stored, never from anything the user sent.
 */
export function deleteCandidateMessage(candidateId: string): string {
  return (
    `Permanently delete candidate ${candidateId} with delete_candidate. The candidate asked for this ` +
    `themselves because they are replacing their resume, so it is already confirmed: do not ask again. ` +
    `Say whether it was deleted.`
  );
}

const USER_ID = /^[A-Za-z0-9._@-]{1,64}$/;

/** A user id, trimmed, or null when it is not one. Auth replaces this later. */
export function parseUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return USER_ID.test(id) ? id : null;
}

/**
 * Whether a request's body may exceed `limit` plus room for form encoding. A body that
 * does not declare its length counts as too large, since it is read before it is checked.
 */
export function tooLarge(request: { headers: Headers }, limit: number): boolean {
  const length = Number(request.headers.get("content-length") ?? NaN);
  return !Number.isFinite(length) || length > limit + 64 * 1024;
}

/** A file name safe to hand on: letters, digits, dot, dash, underscore and space only. */
export function safeFileName(name: string, fallback: string): string {
  const clean = name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[.\s]+/, "").slice(0, 100).trim();
  return clean || fallback;
}

/** Whether bytes start like a PDF. */
export function looksLikePdf(head: Uint8Array): boolean {
  return new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-";
}

/**
 * Whether a message reads as a command to the agent rather than something said to it.
 * Stricter than the agent's own parser: any line opening with `!` or `/` followed by a
 * word is refused, so no command reaches the session whatever its spelling.
 */
export function isCommand(text: string): boolean {
  return text
    .split("\n")
    .some((line) => /^[!/][A-Za-z]/.test(line.replace(/@[A-Za-z0-9_]{3,}/g, " ").trim()));
}

/** Why a chat message cannot be sent, or null when it can. */
export function messageProblem(text: string): string | null {
  if (!text.trim()) return "Type a message first.";
  if (text.length > MAX_MESSAGE_CHARS) return `Keep it under ${MAX_MESSAGE_CHARS} characters.`;
  if (isCommand(text)) return "Commands are not supported here. Use the buttons instead.";
  return null;
}

/** Why a file cannot be sent as a resume, or null when it can. */
export function resumeProblem(file: { name: string; type: string; size: number }): string | null {
  const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!pdf) return "Upload your resume as a PDF.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_RESUME_BYTES) return "Keep your resume under 10 MB.";
  return null;
}
