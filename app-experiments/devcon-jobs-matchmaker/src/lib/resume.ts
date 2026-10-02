import "server-only";
import { chat, createSession, deleteSession, uploadFile } from "./agent";
import { resumes, type ResumeDoc } from "./db";
import { ADD_CANDIDATE } from "./rules";

/**
 * Hand a resume to the agent: a session of its own, the PDF, "Add candidate", and the
 * session deleted once the agent has answered, whatever the answer.
 */
export async function addResume(userId: string, file: File): Promise<ResumeDoc> {
  const sessionId = await createSession(`Resume · ${userId}`);
  let reply: string;
  try {
    await uploadFile(sessionId, file);
    reply = await chat(sessionId, ADD_CANDIDATE);
  } finally {
    await deleteSession(sessionId).catch(() => {});
  }
  const doc: ResumeDoc = { userId, fileName: file.name, bytes: file.size, reply, createdAt: new Date() };
  await (await resumes()).insertOne({ ...doc });
  return doc;
}

export async function listResumes(userId: string): Promise<ResumeDoc[]> {
  return (await resumes())
    .find({ userId }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
}
