import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Chat } from "@/components/Chat";
import { ResumePanel } from "@/components/ResumePanel";
import { Wordmark } from "@/components/Wordmark";
import { parseUserId } from "@/lib/rules";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const userId = parseUserId(decodeURIComponent((await params).userId));
  if (!userId) notFound();
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session?.userId !== userId) redirect("/");
  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 sm:px-6 lg:h-dvh lg:px-8">
      <header className="flex items-center justify-between gap-4 py-4">
        <Link href="/" className="text-violet">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-semibold text-ink">Hello, {session.name}</span>
          <Link href="/" className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-card hover:text-ink">
            Switch badge
          </Link>
        </div>
      </header>
      <main className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-6 pb-6 lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)]">
        <ResumePanel userId={userId} name={session.name} />
        <Chat userId={userId} />
      </main>
    </div>
  );
}
