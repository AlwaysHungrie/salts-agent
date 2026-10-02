/**
 * What a user may send. Pure, so the browser and the server apply the same rules.
 */

/** Messages a user may send in one chat before they must clear it. */
export const MAX_MESSAGES = 25;

/** Longest message a user may send in one turn. */
export const MAX_MESSAGE_CHARS = 4000;

/** Largest resume accepted, in bytes. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The message a resume is sent to the agent with. */
export const ADD_CANDIDATE = "Add candidate";

const USER_ID = /^[A-Za-z0-9._@-]{1,64}$/;

/** A user id, trimmed, or null when it is not one. Auth replaces this later. */
export function parseUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return USER_ID.test(id) ? id : null;
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
