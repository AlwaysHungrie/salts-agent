import { auth } from "@clerk/nextjs/server";
import {
  myChallenges,
  openChallenges,
  type ChallengeCard,
} from "@/lib/challenges";
import { FrontDoor } from "@/components/FrontDoor";
import { HomeTabs } from "@/components/HomeTabs";
import { PageHead } from "@/components/PageHead";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { userId } = await auth();
  if (!userId) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <PageHead
          title="Socratic Salt."
          subtitle="Resolve your dilema with the wisdom of the internet"
          signedIn={false}
        />
        <FrontDoor />
      </main>
    );
  }

  let mine: ChallengeCard[] = [];
  let all: ChallengeCard[] = [];
  let canCreate = false;
  let failure = "";
  try {
    const [owned, invited] = await Promise.all([
      myChallenges(),
      openChallenges(),
    ]);
    mine = owned.challenges;
    canCreate = owned.canCreate;
    // Everything you can take on: what you were let into, and what you made.
    const seen = new Set(invited.map((c) => c.id));
    all = [...invited, ...mine.filter((c) => !seen.has(c.id))];
  } catch (err) {
    failure = (err as Error).message;
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <PageHead
        title="Socratic Salt."
        subtitle="Resolve your dilema with the wisdom of the internet"
      />
      {failure && (
        <p className="text-muted py-4 text-sm leading-[1.43]">{failure}</p>
      )}
      <HomeTabs all={all} mine={mine} canCreate={canCreate} />
    </main>
  );
}
