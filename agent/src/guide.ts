import pages from "./guide.json";

/** One user-guide article, bundled from `frontend/content/guide` by `scripts/guide.mjs`. */
export type GuidePage = {
  /** File name without `.md`; also the web address `/guide/<slug>`. */
  slug: string;
  title: string;
  section: string;
  summary: string;
  /** The markdown, frontmatter removed. */
  body: string;
};

export const GUIDE: GuidePage[] = pages;

/** The page `slug` names, ignoring case and a trailing `.md`; undefined when none does. */
export function guidePage(slug: string): GuidePage | undefined {
  const wanted = slug.trim().toLowerCase().replace(/\.md$/, "");
  return GUIDE.find((p) => p.slug === wanted);
}

/** Every page as one line: slug, title and summary, grouped by section. */
export function guideIndex(): string {
  const sections = new Map<string, GuidePage[]>();
  for (const page of GUIDE)
    sections.set(page.section, [...(sections.get(page.section) ?? []), page]);
  return [...sections]
    .map(
      ([section, list]) =>
        `${section}:\n${list.map((p) => `- \`${p.slug}\` — ${p.title}. ${p.summary}`).join("\n")}`
    )
    .join("\n\n");
}

/**
 * A page's markdown with the guide's own site-relative links made absolute, so they open
 * from a chat. `base` is the web app's address, or null to leave them as they are.
 */
export function guideBody(page: GuidePage, base: string | null): string {
  const body = base ? page.body.replace(/\]\(\/(?!\/)/g, `](${base}/`) : page.body;
  return `# ${page.title}\n\n${body}`;
}
