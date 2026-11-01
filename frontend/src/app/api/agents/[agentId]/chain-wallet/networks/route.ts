import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string }> };

export async function PUT(request: Request, { params }: Ctx) {
  const { agentId } = await params;
  return proxy(
    `/api/agents/${encodeURIComponent(agentId)}/chain-wallet/networks`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    },
  );
}
