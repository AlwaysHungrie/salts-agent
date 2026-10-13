import "server-only";
import { chat, createSession, deleteSession, uploadFile } from "./agent";
import { resumes, users, type ResumeDoc } from "./db";
import { Refusal } from "./http";
import { candidateIdFrom, deletedFrom } from "./llm";
import { ADD_CANDIDATE, deleteCandidateMessage, resumeUpdatableAt } from "./rules";

/** What the page sees of a resume: never the candidate id. */
export type ResumeView = Omit<ResumeDoc, "candidateId">;

/** Longer than a request may run, so a crashed upload frees itself. */
const BUSY_MS = 6 * 60 * 1000;

/** One message to the agent in a session of its own, deleted once it has answered. */
async function ask(title: string, message: string, file?: File): Promise<string> {
  const sessionId = await createSession(title);
  try {
    if (file) await uploadFile(sessionId, file);
    return await chat(sessionId, message);
  } finally {
    await deleteSession(sessionId).catch(() => {});
  }
}

/**
 * Make `file` the user's one resume. Their current candidate is deleted from the
 * agent's database first (a resume from the same person would otherwise update that
 * candidate rather than make a new one), then the new resume is added. The agent must
 * report the new candidate's id, or the upload has failed. A resume may be replaced
 * once every 6 hours.
 */
export async function addResume(userId: string, file: File): Promise<ResumeView> {
  const now = new Date();
  const held = await (await users()).findOneAndUpdate(
    { userId, $or: [{ resumeBusyUntil: { $exists: false } }, { resumeBusyUntil: { $lt: now } }] },
    { $set: { resumeBusyUntil: new Date(now.getTime() + BUSY_MS) } },
  );
  if (!held) throw new Refusal("Your resume is already being added. Wait for it to finish.", 409);

  try {
    const col = await resumes();
    const current = await col.findOne({ userId }, { sort: { createdAt: -1 } });
    if (current && resumeUpdatableAt(current.createdAt, now))
      throw new Refusal("You can update your resume once every 6 hours.", 429);
    const oldId = current ? (current.candidateId ?? (await candidateIdFrom(current.reply))) : null;
    if (oldId) {
      const reply = await ask(`Replace resume · ${userId}`, deleteCandidateMessage(oldId));
      if (!(await deletedFrom(reply, oldId)))
        throw new Refusal("Your previous resume couldn’t be removed, so the new one wasn’t added. Try again.", 502);
    }
    await col.deleteMany({ userId });

    const reply = await ask(`Resume · ${userId}`, ADD_CANDIDATE, file);
    const candidateId = await candidateIdFrom(reply);
    if (!candidateId) {
      console.error(`resume for ${userId} was not added; the agent said: ${reply.slice(0, 500)}`);
      throw new Refusal("Your resume wasn’t added. Try again.", 502);
    }
    const doc: ResumeDoc = { userId, candidateId, fileName: file.name, bytes: file.size, reply, createdAt: new Date() };
    await col.insertOne({ ...doc });
    return view(doc);
  } finally {
    await (await users()).updateOne({ userId }, { $unset: { resumeBusyUntil: "" } }).catch(() => {});
  }
}

/** A resume as the page sees it, with the line naming the candidate id taken out of the agent's reply. */
function view({ candidateId, userId, fileName, bytes, reply, createdAt }: ResumeDoc): ResumeView {
  return { userId, fileName, bytes, reply: candidateId ? withoutId(reply, candidateId) : reply, createdAt };
}

/** The reply without any line (a field or a table row) that mentions the id. */
export function withoutId(reply: string, id: string): string {
  const lower = id.toLowerCase();
  return reply
    .split("\n")
    .filter((line) => !line.toLowerCase().includes(lower))
    .join("\n");
}

/** The user's resume, as a list of at most one. */
export async function listResumes(userId: string): Promise<ResumeView[]> {
  const docs = await (await resumes()).find({ userId }).sort({ createdAt: -1 }).limit(1).toArray();
  return docs.map(view);
}
