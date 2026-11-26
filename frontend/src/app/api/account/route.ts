import { auth, clerkClient } from "@clerk/nextjs/server";
import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

/** What still blocks deactivating the signed-in account: `{ blockers }`. */
export async function GET() {
  return proxy("/api/account");
}

/**
 * Deactivate the signed-in account: the Worker clears its data (or refuses with the
 * blockers), and only then is the Clerk sign-in deleted, so a refusal leaves the user
 * signed in with nothing lost.
 */
export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const res = await proxy("/api/account", { method: "DELETE" });
  if (!res.ok) return res;

  try {
    await (await clerkClient()).users.deleteUser(userId);
  } catch {
    return Response.json(
      {
        error:
          "Your Salts data was deleted, but your sign-in could not be removed. Contact support to finish.",
      },
      { status: 502 },
    );
  }
  return Response.json({ ok: true });
}
