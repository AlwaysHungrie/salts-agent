import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string; step?: string[] }> };

/** The Worker's path: the agent's WhatsApp for Business setup, or one step of it. */
async function path({ params }: Ctx) {
  const { agentId, step } = await params;
  const tail = step?.length === 1 ? `/${encodeURIComponent(step[0])}` : "";
  return `/api/agents/${encodeURIComponent(agentId)}/whatsapp-business${tail}`;
}

export async function GET(_request: Request, ctx: Ctx) {
  return proxy(await path(ctx));
}

export async function POST(request: Request, ctx: Ctx) {
  return proxy(await path(ctx), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
