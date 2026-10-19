import { guideSections } from "@/lib/guide";

/**
 * `/llms.txt`: the user guide as an index an AI agent can read (llmstxt.org). Each
 * article links its raw markdown at `/guide/<slug>.md`, built from the same files as
 * the pages, so an agent answering questions about Salts reads exactly what people do.
 */
export const dynamic = "force-static";

export function GET() {
  const sections = guideSections().map(
    (section) =>
      `## ${section.title}\n\n${section.guides
        .map((guide) => `- [${guide.title}](/guide/${guide.slug}.md): ${guide.summary}`)
        .join("\n")}`,
  );
  const text = [
    "# Salts",
    "> Salts runs a personal AI agent you talk to in the browser, on Telegram and on WhatsApp. This is its user guide: setup, costs, MCP servers, salts-tools, commands, fleets and the API.",
    ...sections,
  ].join("\n\n");
  return new Response(`${text}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
