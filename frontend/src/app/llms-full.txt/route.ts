import { llmsFull } from "@/lib/llms";

/**
 * `/llms-full.txt`: everything `/llms.txt` links, in one file, so an agent can read the
 * whole guide in a single request. Read at salts.dev, which proxies it from this app.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(`${llmsFull()}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
