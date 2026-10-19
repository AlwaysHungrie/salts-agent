import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Ask the Worker to read a payment back from the chain and count it. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return proxy(`/api/wallet/purchases/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
