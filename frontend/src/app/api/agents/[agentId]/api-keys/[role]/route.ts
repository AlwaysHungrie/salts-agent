import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agentId: string; role: string }> };

function path(agentId: string, role: string) {
  return `/api/agents/${encodeURIComponent(agentId)}/api-keys/${encodeURIComponent(role)}`;
}

/** Generate the role's key, replacing any it had. The answer carries the key, once. */
export async function POST(_request: Request, { params }: Ctx) {
  const { agentId, role } = await params;
  return proxy(path(agentId, role), { method: "POST" });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { agentId, role } = await params;
  return proxy(path(agentId, role), { method: "DELETE" });
}
