/**
 * A challenge is two documents: the reasoning (the agent's instructions, private) and
 * the context (what visitors read before they start). Both live in the agent's own
 * `system_prompt`, so the Worker is the only store this app has. The context goes in
 * too because the agent should know exactly what the person it is talking to was shown.
 */
export const CONTEXT_MARKER = "<!-- socratic-salt:context -->";

const CONTEXT_HEADING =
  "# What the person you are talking with was shown before starting\n\n";

export function composePrompt(reasoning: string, context: string): string {
  const r = reasoning.trim();
  const c = context.trim();
  if (!c) return r;
  return `${r}\n\n${CONTEXT_MARKER}\n${CONTEXT_HEADING}${c}`;
}

export function splitPrompt(prompt: string): { reasoning: string; context: string } {
  const cut = prompt.indexOf(CONTEXT_MARKER);
  if (cut === -1) return { reasoning: prompt.trim(), context: "" };
  let context = prompt.slice(cut + CONTEXT_MARKER.length).trimStart();
  if (context.startsWith(CONTEXT_HEADING.trim())) {
    context = context.slice(CONTEXT_HEADING.trim().length);
  }
  return { reasoning: prompt.slice(0, cut).trim(), context: context.trim() };
}

/** The first prose paragraph of a markdown document, for a listing card. */
export function excerpt(markdown: string, max = 220): string {
  const paragraph =
    markdown
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => !/^(#|\||[-*] |\d+\. |>|```)/.test(p) && p.split(/\s+/).length > 6) ?? "";
  const plain = paragraph
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/**
 * Openers the context document suggests, for the empty chat: the list items under the
 * first heading that talks about asking, trying or starting. Surrounding quotes go.
 */
export function suggestions(markdown: string, max = 4): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{1,4}\s.*\b(ask|try|start|question)/i.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)?.[1]?.trim();
    if (!item) continue;
    out.push(item.replace(/^["“'](.*)["”']$/, "$1").trim());
    if (out.length === max) break;
  }
  return out;
}
