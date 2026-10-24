import "server-only";
import { users } from "./db";
import { myProfile } from "./humans";
import type { MyProfile } from "./people";

/** The signed-in user's email and profile, for the page header. The profile is null when find-humans can't be reached. */
export async function account(userId: string): Promise<{ email: string; profile: MyProfile | null }> {
  const doc = await (await users()).findOne({ userId });
  const profile = await myProfile(userId).catch((err) => {
    console.error(err);
    return null;
  });
  return { email: doc?.email ?? "", profile };
}
