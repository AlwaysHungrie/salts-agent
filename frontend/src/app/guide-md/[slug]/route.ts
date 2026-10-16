import { allGuides, getGuide } from "@/lib/guide";

/**
 * One guide article as raw markdown, served at `/guide/<slug>.md` (a rewrite in
 * `next.config.ts`) for AI agents; `/llms.txt` lists them. Built per file, like the page.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return allGuides().map((guide) => ({ slug: guide.slug }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guide = getGuide((await params).slug);
  if (!guide) return new Response("Not found\n", { status: 404 });
  return new Response(`# ${guide.title}\n\n> ${guide.summary}\n\n${guide.body}`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
