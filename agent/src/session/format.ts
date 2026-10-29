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

/** Said when a turn ran out of tool rounds and its reply does not say how to go on. */
export const OUT_OF_ROUNDS =
  'I ran out of steps before finishing this. Say "continue" and I will carry on from here.';

/** Said when all a reply held was a tool call written out as text. */
export const NO_ANSWER =
  "I stopped before I could answer this. Ask again, or tell me what to try differently.";

/**
 * Tool-call markup that models write out as text when they may not call tools: GLM's
 * `<tool_call>`, DeepSeek's DSML and its older `tool▁calls` tokens. Opener, then closer.
 */
const TOOL_MARKUP: [string, string][] = [
  ["<tool_call>", "</tool_call>"],
  ["<｜DSML｜tool_calls>", "</｜DSML｜tool_calls>"],
  ["<｜tool▁calls▁begin｜>", "<｜tool▁calls▁end｜>"],
  ["<|tool▁calls▁begin|>", "<|tool▁calls▁end|>"],
];

/**
 * Cuts tool-call markup out of text that arrives in pieces. A piece that could be the
 * start of an opener is held back until the next one settles it; markup never closed
 * is cut to the end. `dropped` says whether anything was cut.
 */
export function toolMarkupFilter() {
  let held = "";
  let closer = "";
  const filter = {
    dropped: false,
    push(piece: string): string {
      held += piece;
      let out = "";
      for (;;) {
        if (closer) {
          const end = held.indexOf(closer);
          if (end < 0) {
            held = held.slice(-(closer.length - 1));
            return out;
          }
          held = held.slice(end + closer.length);
          closer = "";
          continue;
        }
        let first: { at: number; open: string; close: string } | undefined;
        for (const [open, close] of TOOL_MARKUP) {
          const at = held.indexOf(open);
          if (at >= 0 && (!first || at < first.at)) first = { at, open, close };
        }
        if (first) {
          out += held.slice(0, first.at);
          held = held.slice(first.at + first.open.length);
          closer = first.close;
          filter.dropped = true;
          continue;
        }
        let keep = 0;
        for (const [open] of TOOL_MARKUP) {
          for (let n = Math.min(open.length - 1, held.length); n > keep; n--) {
            if (held.endsWith(open.slice(0, n))) keep = n;
          }
        }
        out += held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);
        return out;
      }
    },
    flush(): string {
      const rest = closer ? "" : held;
      held = "";
      closer = "";
      return rest;
    },
  };
  return filter;
}

/** Text with any tool-call markup cut out. */
export function stripToolMarkup(text: string): string {
  const filter = toolMarkupFilter();
  return filter.push(text) + filter.flush();
}

/**
 * The stored reply with leaked tool-call markup cut from its text, so a reload, the
 * transcript and the next turn's history never carry it. A reply left with no text says
 * why it stopped. Undefined when there was nothing to cut.
 */
export function withoutToolMarkup(message: UIMessage, outOfRounds: boolean): UIMessage | undefined {
  let cut = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "text") return part;
    const text = stripToolMarkup(part.text);
    if (text === part.text) return part;
    cut = true;
    return { ...part, text };
  });
  if (!cut) return undefined;
  const cleaned = { ...message, parts };
  if (textOf(cleaned).trim()) return cleaned;
  return {
    ...cleaned,
    parts: [...parts, { type: "text", text: outOfRounds ? OUT_OF_ROUNDS : NO_ANSWER }],
  };
}

/**
 * A reply as a chat should get it. Some models, told to stop calling tools, write the
 * call out as text in their own markup; that is never an answer, so it is cut, and a
 * reply that was nothing else says so. A turn that ran out of rounds says so, unless the
 * reply already offers "continue".
 */
export function chatReply(text: string, outOfRounds: boolean): string {
  const cleaned = stripToolMarkup(text).trim();
  if (!outOfRounds || /\bcontinue\b/i.test(cleaned)) {
    return cleaned || (text.trim() ? NO_ANSWER : "");
  }
  return cleaned ? `${cleaned}\n\n${OUT_OF_ROUNDS}` : OUT_OF_ROUNDS;
}

/** Every text part of a message, joined — what the transcript API calls its content. */
export function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** How much of one tool call's input, and of its result, a later turn sees. */
const NOTE_INPUT_CHARS = 400;
const NOTE_OUTPUT_CHARS = 600;
/** And of all the calls in one reply. */
const NOTES_CHARS = 4000;

const oneLine = (value: unknown, max: number): string => {
  const text = (typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * Whether a stored tool call failed: an error the SDK recorded, or a failure one of our
 * tools returned as its output (`runTool` reports those as text, so the SDK sees a result).
 */
function failed(call: { state?: string; output?: unknown }, name: string): boolean {
  if (call.state === "output-error") return true;
  return typeof call.output === "string" && call.output.startsWith(`Tool ${name} failed:`);
}

/**
 * What a reply's successful tool calls were given and found, shortened. Later turns are
 * sent replies as text only, so without this a model forgets the ids and cells a tool
 * gave it and spends the next turn guessing or looking them up again. Failed calls are
 * left out: what went wrong was already said.
 *
 * It travels on the next user message, never inside the reply: a weaker model reads its
 * own past replies as the shape of a reply, and copies a list of calls into its answer
 * as text ("→ Sent the file") instead of calling the tool.
 */
export function toolNotesOf(message: UIMessage): string {
  const lines: string[] = [];
  let used = 0;
  for (const part of message.parts) {
    if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") continue;
    const call = part as {
      type: string;
      toolName?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
    };
    if (call.state !== "output-available") continue;
    const name = call.toolName ?? call.type.replace(/^tool-/, "");
    if (failed(call, name)) continue;
    const line = `- ${name}(${oneLine(call.input, NOTE_INPUT_CHARS)}) → ${oneLine(call.output, NOTE_OUTPUT_CHARS)}`;
    if (used + line.length > NOTES_CHARS) {
      lines.push("- …more calls left out");
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return "";
  return `[Record of the tools your previous reply called, results shortened. Reuse the ids and cells they gave rather than looking them up again. This is a record, not a way to act: to do any of it again, call the tool. Never write calls like these in a reply.]\n${lines.join("\n")}`;
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
    const called = part as { type: string; toolName?: string; state?: string; output?: unknown };
    const name = called.toolName ?? called.type.replace(/^tool-/, "");
    const ok = !failed(called, name);
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
