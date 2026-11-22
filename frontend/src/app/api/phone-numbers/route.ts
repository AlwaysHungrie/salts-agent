import { buyerInIndia } from "@/lib/country";
import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/**
 * The caller's Business Phone Numbers, with the currency a bought number is charged in:
 * rupees for buyers in India, US dollars elsewhere. See `buyerInIndia` for how the country
 * is read.
 */
export async function GET(request: Request) {
  const res = await proxy("/api/phone-numbers");
  if (!res.ok) return res;
  return Response.json({
    ...(await res.json()),
    card_currency: buyerInIndia(request) ? "INR" : "USD",
  });
}

/** Add a number the caller already owns. */
export async function POST(request: Request) {
  return proxy("/api/phone-numbers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
