import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/**
 * The caller's OpenRouter wallet, with the currency card checkout prices in: rupees for
 * buyers in India, US dollars elsewhere. The country is Vercel's read of the caller's IP,
 * so no location prompt; where it is missing (local dev), dollars.
 */
export async function GET(request: Request) {
  const res = await proxy("/api/wallet");
  if (!res.ok) return res;
  const india = request.headers.get("x-vercel-ip-country") === "IN";
  return Response.json({ ...(await res.json()), card_currency: india ? "INR" : "USD" });
}

/** Add a pasted key to it. */
export async function POST(request: Request) {
  return proxy("/api/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
