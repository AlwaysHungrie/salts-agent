import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Remove a key from the wallet, and from every agent holding it. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  return proxy(`/api/wallet/${encodeURIComponent(id)}`, { method: "DELETE" });
}
