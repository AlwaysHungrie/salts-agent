import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** A Razorpay order for a new US number, or for more time on a bought one. */
export async function POST(request: Request) {
  return proxy("/api/phone-numbers/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
