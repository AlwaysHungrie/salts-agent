import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/**
 * Everything under `/api/salts`: pairing a salts-tools computer and managing the
 * computers paired. The Worker checks who is asking; this only forwards.
 */
async function forward(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const body =
    request.method === "GET" || request.method === "DELETE" ? undefined : await request.text();
  return proxy(`/api/salts/${path.map(encodeURIComponent).join("/")}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body,
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
