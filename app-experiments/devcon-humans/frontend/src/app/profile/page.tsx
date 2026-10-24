import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ProfileEditor } from "@/components/ProfileEditor";
import { TerminalFrame } from "@/components/TerminalFrame";
import { account } from "@/lib/account";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The user's own profile: what is saved about them, and messages to add to it. */
export default async function ProfilePage() {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/");
  const { email, profile } = await account(session.userId);
  return (
    <TerminalFrame email={email} link={{ href: "/search", label: "BACK TO SEARCH" }}>
      <ProfileEditor name={session.name} initial={profile} />
    </TerminalFrame>
  );
}
