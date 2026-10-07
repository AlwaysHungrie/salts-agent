import { proxy } from "@/lib/proxy";
import { AGENT_URL } from "@/lib/agent";
import { agentHeaders } from "@/lib/upstream";

export const dynamic = "force-dynamic";

/** A file's bytes, streamed through as-is so an <img src> or a download link can point here. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await params;
  const res = await fetch(
    `${AGENT_URL}/agents/session-agent/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`,
    { headers: await agentHeaders() }
  );
  const headers: Record<string, string> = {
    "content-type": res.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
  };
  // A workbook downloads under its own name rather than opening in the tab.
  const disposition = res.headers.get("content-disposition");
  if (disposition) headers["content-disposition"] = disposition;
  return new Response(res.body, { status: res.status, headers });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await params;
  return proxy(
    `/agents/session-agent/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" }
  );
}
