import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Oracle } from "@/components/Oracle";
import { TerminalFrame } from "@/components/TerminalFrame";
import { account } from "@/lib/account";
import { profileState } from "@/lib/people";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Search, the signed-in user's first view. Without a session, back to the front page to sign in. */
export default async function SearchPage() {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/");
  const { email, profile } = await account(session.userId);
  return (
    <TerminalFrame email={email} link={{ href: "/profile", label: `VIEW PROFILE (${profileState(profile)})` }}>
      <Oracle />
    </TerminalFrame>
  );
}
