import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fleetId: string; role: string }> };

function path(fleetId: string, role: string) {
  return `/api/fleets/${encodeURIComponent(fleetId)}/api-keys/${encodeURIComponent(role)}`;
}

/** Generate the fleet key, replacing any it had. The answer carries the key, once. */
export async function POST(_request: Request, { params }: Ctx) {
  const { fleetId, role } = await params;
  return proxy(path(fleetId, role), { method: "POST" });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { fleetId, role } = await params;
  return proxy(path(fleetId, role), { method: "DELETE" });
}
