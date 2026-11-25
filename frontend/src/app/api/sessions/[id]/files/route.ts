import { proxy } from "@/lib/proxy";
import { AGENT_URL } from "@/lib/agent";
import { agentHeaders } from "@/lib/upstream";

export const dynamic = "force-dynamic";

/** Attachments uploaded but not yet sent with a turn, or with `?scope=chat` every file in it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = new URL(request.url).searchParams.get("scope") === "chat" ? "?scope=chat" : "";
  return proxy(`/agents/session-agent/${encodeURIComponent(id)}/files${scope}`);
}

/**
 * Forward the multipart upload untouched. `proxy` cannot be used here: it would have
 * to buffer and re-encode the body, and the Worker needs the original boundary.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await fetch(`${AGENT_URL}/agents/session-agent/${encodeURIComponent(id)}/files`, {
      method: "POST",
      body: await request.arrayBuffer(),
      headers: {
        "content-type": request.headers.get("content-type") ?? "",
        ...(await agentHeaders()),
      },
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return Response.json({ error: `Cannot reach the agent Worker at ${AGENT_URL}.` }, { status: 502 });
  }
}
