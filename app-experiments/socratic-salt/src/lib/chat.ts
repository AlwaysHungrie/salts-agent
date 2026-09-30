import type { UIMessage } from "ai";

/** A tool the agent ran mid-turn, so the chat can say what it is doing. */
export type ToolData = { name: string; done: boolean; ok?: boolean };

export type ChatUIMessage = UIMessage<never, { tool: ToolData }>;

/** Longest message a visitor may send in one turn. */
export const MAX_MESSAGE = 4000;

export function toolLabel(name: string, done: boolean): string {
  if (name === "web_search") return done ? "Searched the web" : "Searching the web…";
  if (name === "fetch_url") return done ? "Read a page" : "Reading a page…";
  return done ? `Used ${name}` : `Using ${name}…`;
}
