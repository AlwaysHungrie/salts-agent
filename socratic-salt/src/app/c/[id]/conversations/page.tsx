import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { allSessions, isOwner, getPublic, transcript } from "@/lib/challenges";
import { latestStance } from "@/lib/stance";
import { PageHead } from "@/components/PageHead";
import { Row } from "@/components/Row";

export const dynamic = "force-dynamic";

const when = (ms: number) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(ms);

export default async function ConversationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await auth()).userId) redirect(`/c/${id}`);
  if (!(await isOwner(id))) notFound();
  const [challenge, sessions] = await Promise.all([getPublic(id), allSessions(id)]);
  // Each conversation's latest tally or conclusion, so outcomes read without opening them.
  const stances = await Promise.all(
    sessions.map((s) =>
      transcript(s.id)
        .then((messages) =>
          latestStance(messages.filter((m) => m.role === "assistant").map((m) => m.content)),
        )
        .catch(() => null),
    ),
  );
  const concluded = stances.filter((s) => s?.concluded).length;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <PageHead
        title="Conversations."
        subtitle={`Everyone who has taken on ${challenge.name}. ${concluded} of ${sessions.length} reached a conclusion.`}
        back={{ href: `/c/${id}`, label: "Back to the debate" }}
      />
      <div className="mt-4 space-y-2">
        {sessions.length === 0 && <p className="text-muted px-1 text-sm leading-[1.43]">No one has taken it on yet.</p>}
        {sessions.map((s, i) => {
          const stance = stances[i];
          return (
            <Row
              key={s.id}
              href={`/c/${id}/conversations/${encodeURIComponent(s.id)}`}
              title={s.owner_email || "Unknown"}
              detail={`${stance?.summary || s.title} · ${when(s.updated_at)}`}
              aside={
                stance?.concluded && (
                  <span className="bg-ink shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white">
                    Concluded
                  </span>
                )
              }
            />
          );
        })}
      </div>
    </main>
  );
}
