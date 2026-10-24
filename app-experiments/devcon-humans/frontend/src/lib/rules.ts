/**
 * What a user may send. Pure, so the browser and the server apply the same rules.
 */

/** Longest message a user may send in one turn. */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * Whether a request's body may exceed `limit` plus room for form encoding. A body that
 * does not declare its length counts as too large, since it is read before it is checked.
 */
export function tooLarge(request: { headers: Headers }, limit: number): boolean {
  const length = Number(request.headers.get("content-length") ?? NaN);
  return !Number.isFinite(length) || length > limit + 64 * 1024;
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
  if (isCommand(text)) return "Commands are not supported here.";
  return null;
}
