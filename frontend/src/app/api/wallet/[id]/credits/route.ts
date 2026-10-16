import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Add credit to a key bought here. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  return proxy(`/api/wallet/${encodeURIComponent(id)}/credits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
