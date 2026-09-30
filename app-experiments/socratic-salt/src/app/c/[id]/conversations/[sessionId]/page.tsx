import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { allSessions, isOwner, transcript } from "@/lib/challenges";
import { Transcript } from "@/components/Transcript";
import { PageHead } from "@/components/PageHead";

export const dynamic = "force-dynamic";

/** One challenger's conversation, as the creator reads it: no composer, no edits. */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId: raw } = await params;
  const sessionId = decodeURIComponent(raw);
  if (!(await auth()).userId) redirect(`/c/${id}`);
  if (!(await isOwner(id))) notFound();
  const session = (await allSessions(id)).find((s) => s.id === sessionId);
  if (!session) notFound();
  const messages = await transcript(sessionId);

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 md:px-8 md:py-14">
      <PageHead
        title={session.owner_email || "Conversation."}
        subtitle="Read-only."
        back={{ href: `/c/${id}/conversations`, label: "Conversations" }}
      />
      <div className="mt-6">
        {messages.length === 0 ? (
          <p className="text-muted text-sm">Nothing said yet.</p>
        ) : (
          <Transcript rows={messages} />
        )}
      </div>
    </main>
  );
}
