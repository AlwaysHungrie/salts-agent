/**
 * Checks on the classifier's JSON answers. Pure, so they are tested without the model.
 * A model can be wrong or talked round; these make sure a wrong answer can only refuse.
 */

export type Screen = "ok" | "off_topic" | "removal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const field = (answer: unknown, key: string): unknown =>
  answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>)[key] : undefined;

/** The id, lowercased, only when it is a UUID the reply itself contains: never one the model made up. */
export function parseCandidateId(answer: unknown, reply: string): string | null {
  const id = field(answer, "candidateId");
  if (typeof id !== "string" || !UUID.test(id.trim())) return null;
  const clean = id.trim().toLowerCase();
  return reply.toLowerCase().includes(clean) ? clean : null;
}

/** Gone means deleted now or never there; any other outcome keeps the old candidate. */
export function parseDeleted(answer: unknown): boolean {
  const outcome = field(answer, "outcome");
  return outcome === "deleted" || outcome === "not_found";
}

/** Anything but a plain "ok" or a known refusal reads as off topic, so a muddled answer refuses. */
export function parseScreen(answer: unknown): Screen {
  const verdict = field(answer, "verdict");
  return verdict === "ok" || verdict === "removal" ? verdict : "off_topic";
}

/** What the user is told when a message is screened out. */
export const SCREENED: Record<Exclude<Screen, "ok">, string> = {
  off_topic: "The matchmaker only talks about jobs, teams and candidates at Devcon. Try asking about those.",
  removal: "Candidates can’t be removed from chat. To replace your resume, upload a new one.",
};
