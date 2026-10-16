import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** The caller's OpenRouter wallet. */
export async function GET() {
  return proxy("/api/wallet");
}

/** Add a pasted key to it. */
export async function POST(request: Request) {
  return proxy("/api/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
