import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** The actions forwarded to the Worker unchanged; anything else is a 404 here. */
const ACTIONS = ["connect", "disconnect"];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string; action: string }> },
) {
  const { agentId, action } = await params;
  if (!ACTIONS.includes(action)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return proxy(
    `/api/agents/${encodeURIComponent(agentId)}/google-calendar/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    },
  );
}
