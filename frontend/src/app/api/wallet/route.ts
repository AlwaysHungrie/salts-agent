import { buyerInIndia } from "@/lib/country";
import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/**
 * The caller's OpenRouter wallet, with the currency card checkout prices in: rupees for
 * buyers in India, US dollars elsewhere. See `buyerInIndia` for how the
 * country is read: no location prompt.
 */
export async function GET(request: Request) {
  const res = await proxy("/api/wallet");
  if (!res.ok) return res;
  return Response.json({
    ...(await res.json()),
    card_currency: buyerInIndia(request) ? "INR" : "USD",
  });
}

/** Add a pasted key to it. */
export async function POST(request: Request) {
  return proxy("/api/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
