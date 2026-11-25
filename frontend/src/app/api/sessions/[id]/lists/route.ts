import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** The owner's lists with their entries, shared by every agent and session. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxy(`/agents/session-agent/${encodeURIComponent(id)}/lists`);
}
