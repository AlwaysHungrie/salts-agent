import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Count a card payment for a number order, then deliver the number. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return proxy(`/api/phone-numbers/orders/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
