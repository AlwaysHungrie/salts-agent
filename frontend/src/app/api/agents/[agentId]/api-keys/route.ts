import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

/** The agent's API keys the caller manages, by hint: never the keys themselves. */
export async function GET(_request: Request, { params }: Ctx) {
  const { agentId } = await params;
  return proxy(`/api/agents/${encodeURIComponent(agentId)}/api-keys`);
}
