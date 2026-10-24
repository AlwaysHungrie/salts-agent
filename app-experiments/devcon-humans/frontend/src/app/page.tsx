import { cookies } from "next/headers";
import { AdminSignIn } from "@/components/AdminSignIn";
import { Chat } from "@/components/Chat";
import { SwitchBadge } from "@/components/SwitchBadge";
import { UserIdForm } from "@/components/UserIdForm";
import { Wordmark } from "@/components/Wordmark";
import { readSession, SESSION_COOKIE } from "@/lib/session";

/** The one page: the badge pickup until the user has a session, then their chat. */
export default async function Home() {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session)
    return (
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4 py-4">
          <Wordmark className="min-w-0 text-violet" />
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden font-display text-sm font-semibold text-ink sm:inline">Hello, {session.name}</span>
            <SwitchBadge />
          </div>
        </header>
        <main className="flex-1 pb-6">
          <Chat />
        </main>
      </div>
    );

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-5 lg:px-10">
      <main className="grid flex-1 grid-cols-[minmax(0,1fr)] content-start items-start gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-20">
        <section className="pt-10 lg:pt-24">
          <Wordmark className="text-violet" />
          <h1 className="mt-12 max-w-[14ch] font-display text-5xl leading-[0.98] font-bold tracking-[-0.03em] text-balance sm:text-6xl lg:text-7xl">
            Find the people worth meeting at Devcon 8.
          </h1>
          <p className="mt-6 max-w-[46ch] text-lg text-ink-2">
            This is an unofficial app and not associated with Devcon. Ask your agent who builds AI agents or who runs
            brand deals, or tell it what you do so others can find you.
          </p>
        </section>
        <div className="pb-16">
          <UserIdForm />
          <AdminSignIn />
        </div>
      </main>
    </div>
  );
}
