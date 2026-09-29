import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { allSessions, isOwner, getPublic } from "@/lib/challenges";
import { PageHead, Row } from "@/components/PageHead";

export const dynamic = "force-dynamic";

const when = (ms: number) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(ms);

export default async function ConversationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await auth()).userId) redirect(`/c/${id}`);
  if (!(await isOwner(id))) notFound();
  const [challenge, sessions] = await Promise.all([getPublic(id), allSessions(id)]);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <PageHead
        title="Conversations."
        subtitle={`Everyone who has taken on ${challenge.name}.`}
        back={{ href: `/c/${id}`, label: "Back to the debate" }}
      />
      <div className="mt-4 space-y-2">
        {sessions.length === 0 && <p className="text-muted px-1 text-sm leading-[1.43]">No one has taken it on yet.</p>}
        {sessions.map((s) => (
          <Row
            key={s.id}
            href={`/c/${id}/conversations/${encodeURIComponent(s.id)}`}
            title={s.owner_email || "Unknown"}
            detail={`${s.title} · ${when(s.updated_at)}`}
          />
        ))}
      </div>
    </main>
  );
}
