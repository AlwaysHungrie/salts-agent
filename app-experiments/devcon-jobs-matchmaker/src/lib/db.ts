import "server-only";
import { MongoClient, type Collection } from "mongodb";

/** The one agent session a user chats in, and how many messages they have sent to it. */
export type ChatDoc = { userId: string; sessionId: string; sent: number; createdAt: Date };

/** A resume a user uploaded, and what the agent said when it was added. */
export type ResumeDoc = {
  userId: string;
  fileName: string;
  bytes: number;
  reply: string;
  createdAt: Date;
};

const globalForMongo = globalThis as unknown as { mongo?: Promise<MongoClient> };

async function client(): Promise<MongoClient> {
  // One client per process; dev reloads reuse it rather than leaking connections.
  globalForMongo.mongo ??= (async () => {
    const c = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
    await c.connect();
    const db = c.db(process.env.MONGODB_DB ?? "devcon-jobs-matchmaker");
    await db.collection<ChatDoc>("chats").createIndex({ userId: 1 }, { unique: true });
    await db.collection<ResumeDoc>("resumes").createIndex({ userId: 1, createdAt: -1 });
    return c;
  })().catch((err) => {
    globalForMongo.mongo = undefined;
    throw err;
  });
  return globalForMongo.mongo;
}

async function db() {
  return (await client()).db(process.env.MONGODB_DB ?? "devcon-jobs-matchmaker");
}

export async function chats(): Promise<Collection<ChatDoc>> {
  return (await db()).collection<ChatDoc>("chats");
}

export async function resumes(): Promise<Collection<ResumeDoc>> {
  return (await db()).collection<ResumeDoc>("resumes");
}
