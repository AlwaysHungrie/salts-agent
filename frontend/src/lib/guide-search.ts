import { allGuides } from "./guide";
import { slugify } from "./guide-markdown";

/**
 * The search index, built once at build time and served as one static file.
 *
 * One entry per `##` section rather than per article: a reader searching for
 * "whitelist" wants the paragraph about whitelists, not the article it sits in, and a
 * heading anchor puts them on it.
 *
 * Ported from `landing-page/lib/search.ts`.
 */
export type SearchEntry = {
  /** Where it goes: `/guide/<slug>` plus the heading anchor, when there is one. */
  slug: string;
  hash: string;
  /** The article's title, always. */
  title: string;
  /** The section of the guide the article belongs to — "Get started", and so on. */
  group: string;
  /** The `##` heading this entry covers, empty for an article's opening. */
  heading: string;
  /** The prose, markdown stripped, for matching and for the snippet. */
  text: string;
};

/** Markdown to plain prose: what a reader sees, not what the file holds. */
function strip(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, " ")
    .replace(/^\s*\{\{[^}]*\}\}\s*$/gm, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/^\s*([-*]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?(\[!warning\])?/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchIndex(): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const guide of allGuides()) {
    // The opening of the article: its summary, plus whatever precedes the first
    // heading. This is the entry a search for the article's own name should hit.
    const [opening, ...rest] = guide.body.split(/^##\s+/m);
    entries.push({
      slug: guide.slug,
      hash: "",
      title: guide.title,
      group: guide.section,
      heading: "",
      text: `${guide.summary} ${strip(opening)}`.trim(),
    });

    for (const chunk of rest) {
      const newline = chunk.indexOf("\n");
      // Backticks are markup, and the dialog shows the heading as plain text.
      const heading = (newline === -1 ? chunk : chunk.slice(0, newline)).replace(/`/g, "").trim();
      const body = newline === -1 ? "" : chunk.slice(newline + 1);
      entries.push({
        slug: guide.slug,
        hash: slugify(heading),
        title: guide.title,
        group: guide.section,
        heading,
        text: strip(body),
      });
    }
  }

  return entries;
}
