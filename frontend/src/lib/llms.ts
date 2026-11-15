import { guideSections } from "@/lib/guide";

/**
 * What `/llms.txt` and `/llms-full.txt` tell an AI agent about Salts (llmstxt.org).
 * Both are read at salts.dev, which proxies them from this app. Every fact here is
 * also on the landing page or in the guide; keep the two in step when either changes.
 */
const SITE = "https://salts.dev";

const ABOUT = `# Salts

> Salts runs personal AI agents you talk to in the browser, on Telegram and on WhatsApp. An agent costs nothing while idle; each reply is paid from your own OpenRouter key, from about $0.001 to $0.03 depending on the model. No subscription. Open source (Apache 2.0).

Key facts:

- Website: ${SITE}. Web app: https://app.salts.dev. Source: https://github.com/AlwaysHungrie/salts-agent
- Channels: web chat, a Telegram bot, a WhatsApp number. Text, links, photos, PDFs and voice notes in; text and voice notes out.
- Capabilities, each a switch: web search, reading links and files, image input, image generation, voice notes, reminders and scheduled tasks, memory, spreadsheets, Notion, GitHub, and any MCP server.
- Models: any model on OpenRouter, switchable per agent.
- Hosted limits: 5 agents per account, 256 chat sessions and 50 MB of files per agent. Self-hosting on your own Cloudflare account removes them.
- Fleets: one person creates and pays for agents for a whole community, with a spend limit per member. Members' conversations stay private.
- API: every agent can be reached with an API key. OpenAPI spec: https://api.salts.dev/openapi.json`;

/** `/llms.txt`: the overview, then every guide article as a link to its markdown. */
export function llmsIndex(): string {
  const sections = guideSections().map(
    (section) =>
      `## ${section.title}\n\n${section.guides
        .map((guide) => `- [${guide.title}](${SITE}/guide/${guide.slug}.md): ${guide.summary}`)
        .join("\n")}`,
  );
  return [
    ABOUT,
    `The user guide follows: setup, costs, channels, MCP servers, salts-tools, fleets and the API. Every article is in one file at ${SITE}/llms-full.txt.`,
    ...sections,
  ].join("\n\n");
}

/** `/llms-full.txt`: the overview and every guide article in full, in guide order. */
export function llmsFull(): string {
  const articles = guideSections().flatMap((section) =>
    section.guides.map(
      (guide) =>
        `# ${guide.title}\n\nSource: ${SITE}/guide/${guide.slug}\n\n> ${guide.summary}\n\n${guide.body.trim()}`,
    ),
  );
  return [ABOUT, ...articles].join("\n\n---\n\n");
}
