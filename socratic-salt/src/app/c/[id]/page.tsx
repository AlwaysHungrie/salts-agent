import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Chat } from "@/components/Chat";
import { ChallengeView } from "@/components/ChallengeView";
import { FrontDoor } from "@/components/FrontDoor";
import { Markdown } from "@/components/Markdown";
import { PageHead } from "@/components/PageHead";
import { getPublic, isOwner, mySession, transcript, type StoredMessage } from "@/lib/challenges";
import { suggestions } from "@/lib/prompt";
import { orNull } from "@/lib/worker";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const challenge = await orNull(getPublic((await params).id)).catch(() => null);
  return { title: challenge ? `${challenge.name} · Socratic Salt` : "Socratic Salt" };
}

export default async function ChallengePage({ params }: Props) {
  const { id } = await params;
  if (!(await auth()).userId) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <PageHead title="Socratic Salt." subtitle="Sign in to take on this challenge." signedIn={false} />
        <FrontDoor redirectUrl={`/c/${id}`} />
      </main>
    );
  }

  // The Worker answers only to the creator and the guests it lets in.
  const challenge = await orNull(getPublic(id));
  if (!challenge) notFound();

  const [owner, session] = await Promise.all([isOwner(id), mySession(id).catch(() => null)]);
  const initial: StoredMessage[] = session ? await transcript(session.id).catch(() => []) : [];

  return (
    <ChallengeView
      name={challenge.name}
      started={initial.length > 0}
      ownerOf={owner ? id : undefined}
      brief={
        challenge.public_notes ? (
          <Markdown className="text-[15px]">{challenge.public_notes}</Markdown>
        ) : (
          <p className="text-muted text-sm">
            {owner ? "No public notes yet. Add them in Settings." : "No brief for this one — make your case."}
          </p>
        )
      }
      chat={
        <Chat
          challengeId={id}
          name={challenge.name}
          initial={initial}
          openers={suggestions(challenge.public_notes)}
        />
      }
    />
  );
}
