/**
 * Where a debate stands, read back out of the agent's own replies. The protocol has
 * every reply end with a "Where we stand" block, or a "Conclusion" once it gets there,
 * so the latest one is the state of the discussion.
 */
export type Stance = {
  concluded: boolean;
  /** The block's markdown, heading dropped. */
  body: string;
  /** One line: the current recommendation, or the decision concluded. */
  summary: string;
};

const MARKER = /\*\*(Where we stand|Conclusion)\b[^\n]*/gi;

const plain = (s: string) =>
  s
    .replace(/\*\*|__/g, "")
    .replace(/^[\s:—-]+/, "")
    .trim();

export function stanceOf(text: string): Stance | null {
  const found = [...text.matchAll(MARKER)].at(-1);
  if (!found || found.index === undefined) return null;
  const concluded = found[1].toLowerCase() === "conclusion";
  const heading = found[0];
  const rest = text.slice(found.index + heading.length).replace(/^\s*\n/, "").trim();

  if (concluded) {
    // "**Conclusion: Keep Salt.**", "**Conclusion**: Keep Salt." or the verdict on the next line.
    const inline = plain(heading.replace(/^\*\*Conclusion/i, ""));
    const summary = inline || plain(rest.split("\n").find((l) => l.trim()) ?? "");
    const body = inline ? rest : rest.split("\n").slice(1).join("\n").trim();
    return { concluded, body: body || rest, summary };
  }

  // The recommendation is the summary; the body keeps the rest of the tally.
  const line = rest.match(/^\s*[-*]\s*(?:\*\*)?Recommendation(?:\*\*)?:?(?:\*\*)?\s*(.+)$/im);
  if (!line) return { concluded, body: rest, summary: "" };
  return { concluded, body: rest.replace(line[0], "").trim(), summary: plain(line[1]) };
}

/** The latest stance across a conversation's replies, oldest first. */
export function latestStance(replies: string[]): Stance | null {
  for (let i = replies.length - 1; i >= 0; i--) {
    const s = stanceOf(replies[i]);
    if (s) return s;
  }
  return null;
}
