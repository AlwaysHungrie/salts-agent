import { llmsIndex } from "@/lib/llms";

/**
 * `/llms.txt` (llmstxt.org): what Salts is, then the user guide as an index an AI agent
 * can read, each article linking its raw markdown at `/guide/<slug>.md`, built from the
 * same files as the pages. Read at salts.dev, which proxies it from this app.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(`${llmsIndex()}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
