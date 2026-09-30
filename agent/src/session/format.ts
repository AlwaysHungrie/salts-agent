import type { Schedule } from "agents";
import { type UIMessage } from "ai";
import type { ScheduledTask } from "../capabilities";
import type { TurnStep } from "./types";

/** `a`, `a and b`, `a, b and c` — what a sentence needs and `join` does not give. */
export function inWords(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * One chat-safe line for a failure (the raw error can be a huge provider payload); the
 * full text goes to the log.
 */
export function reportable(error: unknown, session: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  console.error(`turn error in session ${session}: ${raw.slice(0, 4000)}`);

  // The platform's own failures name internals — SQL statements, isolates, reset
  // reasons — and none of that is an answer to the person who asked a question.
  if (/code was updated|reset because its code/i.test(raw)) {
    return "Session restarted before your message was processed.";
  }
  if (/exceeded its memory limit|Exceeded Memory/i.test(raw)) {
    return "This session ran out of memory and was reset. Send a new message or start a new conversation.";
  }
  if (/Durable Object.*(reset|reload)|isolate/i.test(raw)) {
    return "The session crashed while answering. Send a new message or start a new conversation.";
  }
  if (/Type validation failed|invalid_union|Invalid input/i.test(raw)) {
    return "The provider sent back a response this client could not read.";
  }
  if (/rate.?limit|429/i.test(raw)) return "The provider is rate limiting this key.";
  if (/credit|quota|402/i.test(raw)) return "The provider rejected the call for credits or quota.";
  if (/context length|too large|413/i.test(raw))
    return "That turn was too large for the model's context.";

  // Anything unrecognised: the first line only, short enough to read.
  const first = raw.split("\n")[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first || "The turn failed.";
}

/**
 * What the chat says when a turn does not complete. The status and Think's error
 * distinguish "try again" from "reset this session" and from provider refusals.
 */
export function turnFailure(status: string, error?: string): string {
  const why = error ? ` (${reportable(error, "turn")})` : "";
  if (status === "aborted") return `That turn was cut short${why}. Ask again?`;
  if (status === "skipped") {
    return `That turn was skipped${why} — an earlier one is probably still running. Give it a moment, then ask again.`;
  }
  // The model refusing the request is not the session being broken, and telling
  // someone to reset a session that is fine costs them the conversation for nothing.
  if (/provider|upstream|rate.?limit|credit|quota|context length|too large/i.test(error ?? "")) {
    return `The model could not answer that${why}. Nothing here is broken — this is the provider, so it is worth trying again, or switching model in settings.`;
  }
  return `That turn did not finish${why}. If it keeps happening, !unstick clears this session's turn state.`;
}

/** Every text part of a message, joined — what the transcript API calls its content. */
export function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * The turn's text and tool steps, read back off Think's stored message (a failed tool
 * keeps its outcome).
 */
export function stepsOf(message: UIMessage): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      const last = steps[steps.length - 1];
      if (last?.kind === "text") last.text += part.text;
      else steps.push({ kind: "text", text: part.text });
      continue;
    }
    if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") continue;
    const called = part as { type: string; toolName?: string; state?: string };
    const name = called.toolName ?? called.type.replace(/^tool-/, "");
    const ok = called.state !== "output-error";
    const last = steps[steps.length - 1];
    if (last?.kind === "tools") last.tools.push({ name, ok });
    else steps.push({ kind: "tools", tools: [{ name, ok }] });
  }
  return steps;
}

export function describeSchedule(schedule: Schedule<{ prompt: string }>): ScheduledTask {
  const when =
    schedule.type === "cron"
      ? `cron ${(schedule as { cron: string }).cron}`
      : new Date(schedule.time * 1000).toISOString();
  return { id: schedule.id, prompt: schedule.payload?.prompt ?? "", when };
}
