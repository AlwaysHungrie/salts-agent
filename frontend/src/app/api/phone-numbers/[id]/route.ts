import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Remove a number from the caller's Business Phone Numbers. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  return proxy(`/api/phone-numbers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
