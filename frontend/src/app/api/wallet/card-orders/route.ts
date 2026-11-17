import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** Make a Razorpay order for a new key. */
export async function POST(request: Request) {
  return proxy("/api/wallet/card-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
