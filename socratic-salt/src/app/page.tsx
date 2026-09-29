import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Plus } from "lucide-react";
import { myChallenges, openChallenges, type ChallengeCard } from "@/lib/challenges";
import { FrontDoor } from "@/components/FrontDoor";
import { PageHead, Row, SectionTitle } from "@/components/PageHead";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { userId } = await auth();
  if (!userId) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <PageHead title="Socratic Salt." subtitle="Each agent argues one position. Change its mind." signedIn={false} />
        <FrontDoor />
      </main>
    );
  }

  let mine: ChallengeCard[] = [];
  let open: ChallengeCard[] = [];
  let canCreate = false;
  let failure = "";
  try {
    const [owned, invited] = await Promise.all([myChallenges(), openChallenges()]);
    mine = owned.challenges;
    canCreate = owned.canCreate;
    const ownedIds = new Set(mine.map((c) => c.id));
    open = invited.filter((c) => !ownedIds.has(c.id));
  } catch (err) {
    failure = (err as Error).message;
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <PageHead title="Socratic Salt." subtitle="Each agent argues one position. Change its mind." />
      {failure && <p className="text-muted py-4 text-sm leading-[1.43]">{failure}</p>}

      <SectionTitle>Open to you</SectionTitle>
      <div className="space-y-2">
        {open.length === 0 && (
          <p className="text-muted px-1 text-sm leading-[1.43]">No one has invited you to a challenge yet.</p>
        )}
        {open.map((c) => (
          <Row key={c.id} href={`/c/${c.id}`} title={c.name} detail={c.excerpt} />
        ))}
      </div>

      <SectionTitle>Your challenges</SectionTitle>
      <div className="space-y-2">
        {mine.map((c) => (
          <Row key={c.id} href={`/c/${c.id}`} title={c.name} detail={c.excerpt} />
        ))}
        {canCreate ? (
          <Link
            href="/new"
            className="from-accent/12 hover:to-accent/5 flex min-h-17 items-center gap-3 rounded-2xl bg-linear-to-r to-transparent px-5 py-4 font-semibold transition"
          >
            <Plus size={18} strokeWidth={2} /> New challenge
          </Link>
        ) : (
          <p className="text-muted px-1 text-sm leading-[1.43]">
            You have reached your agent limit, so you cannot create another challenge.
          </p>
        )}
      </div>
    </main>
  );
}
