import fs from "node:fs";
import path from "node:path";

/**
 * The user guide, as files.
 *
 * Everything the guide says lives in `frontend/content/guide/*.md`. This module is the
 * only thing that reads them: it splits the frontmatter off, sorts the articles, and
 * groups them into the sections the sidebar draws. Adding an article means adding one
 * markdown file — no route, no import, no list to keep in sync. Editing one on GitHub
 * and merging it is the whole release: the pages are built from these files.
 *
 * Frontmatter is plain `key: value` lines:
 *
 *   ---
 *   title: Get an OpenRouter key
 *   section: Get started
 *   order: 3
 *   summary: One sentence, shown on the index and under the title.
 *   featured: true
 *   ---
 *
 * `featured` is optional; only featured articles are listed on the guide's front page.
 * Every article is still in the sidebar and in search.
 *
 * Ported from `landing-page/lib/docs.ts`, which does the same for the public docs.
 */

export type Guide = {
  /** File name without the extension. Also the URL: `/guide/<slug>`. */
  slug: string;
  title: string;
  section: string;
  order: number;
  summary: string;
  /** Listed on the guide's front page. */
  featured: boolean;
  /** The markdown, frontmatter removed. */
  body: string;
};

export type GuideSection = { title: string; guides: Guide[] };

/**
 * Section order on the sidebar and on the index. A section not named here still
 * renders — it sorts to the end, alphabetically — so a new group of articles is never
 * silently dropped.
 */
const SECTION_ORDER = [
  "Get started",
  "Managing costs",
  "Telegram",
  "WhatsApp",
  "MCP servers",
  "Advanced use",
  "Fleets",
];

const DIR = path.join(process.cwd(), "content", "guide");

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n+/, "") };
}

let cache: Guide[] | null = null;

/** Every article, sorted by section order then by the `order` in its frontmatter. */
export function allGuides(): Guide[] {
  if (cache) return cache;

  const guides = fs
    .readdirSync(DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(DIR, name), "utf8"));
      const slug = name.replace(/\.md$/, "");
      return {
        slug,
        title: meta.title ?? slug,
        section: meta.section ?? "Get started",
        order: Number(meta.order ?? 999),
        summary: meta.summary ?? "",
        featured: meta.featured === "true",
        body,
      };
    });

  const rank = (section: string) => {
    const at = SECTION_ORDER.indexOf(section);
    return at === -1 ? SECTION_ORDER.length : at;
  };

  guides.sort(
    (a, b) =>
      rank(a.section) - rank(b.section) ||
      a.section.localeCompare(b.section) ||
      a.order - b.order ||
      a.title.localeCompare(b.title),
  );

  cache = guides;
  return guides;
}

/** The articles grouped for the sidebar, in reading order. `featuredOnly` keeps the front page's picks. */
export function guideSections({ featuredOnly = false } = {}): GuideSection[] {
  const sections: GuideSection[] = [];
  for (const guide of allGuides()) {
    if (featuredOnly && !guide.featured) continue;
    const last = sections[sections.length - 1];
    if (last && last.title === guide.section) last.guides.push(guide);
    else sections.push({ title: guide.section, guides: [guide] });
  }
  return sections;
}

export function getGuide(slug: string): Guide | undefined {
  return allGuides().find((guide) => guide.slug === slug);
}

/** What comes before and after this article, so a reader can keep going. */
export function neighbours(slug: string): { previous?: Guide; next?: Guide } {
  const guides = allGuides();
  const at = guides.findIndex((guide) => guide.slug === slug);
  if (at === -1) return {};
  return { previous: guides[at - 1], next: guides[at + 1] };
}
