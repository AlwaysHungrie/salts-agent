import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** Count a payment the page lost track of, by its network and transaction id. */
export async function POST(request: Request) {
  return proxy("/api/wallet/purchases/recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
