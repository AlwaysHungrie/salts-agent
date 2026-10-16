import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** Buy a new key. */
export async function POST(request: Request) {
  return proxy("/api/wallet/purchases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
