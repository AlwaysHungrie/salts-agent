import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** The fleet's key, as a key list: its hint and date, never the key. */
export async function GET(_request: Request, { params }: { params: Promise<{ fleetId: string }> }) {
  const { fleetId } = await params;
  return proxy(`/api/fleets/${encodeURIComponent(fleetId)}/api-keys`);
}
