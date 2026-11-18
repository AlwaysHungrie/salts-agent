import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** A new account's one free key. */
export async function POST() {
  return proxy("/api/wallet/starter", { method: "POST" });
}
