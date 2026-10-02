import "server-only";
import { MongoClient, type Collection } from "mongodb";

/** The one agent session a user chats in, and how many messages they have sent to it. */
export type ChatDoc = { userId: string; sessionId: string; sent: number; createdAt: Date };

/** The one resume a user has uploaded, the candidate the agent made of it, and what it said. */
export type ResumeDoc = {
  userId: string;
  /** Absent on resumes added before ids were kept; read from `reply` when needed. */
  candidateId?: string;
  fileName: string;
  bytes: number;
  reply: string;
  createdAt: Date;
};

/** A Devcon ticket holder. The id is derived from their pass; the pass itself is never kept. */
export type UserDoc = {
  userId: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date;
  /** Set while a resume upload runs, so two uploads cannot each leave a candidate behind. */
  resumeBusyUntil?: Date;
  /** When the user last cleared their chat; they may clear it once per CLEAR_COOLDOWN_MS. */
  chatClearedAt?: Date;
};

const globalForMongo = globalThis as unknown as { mongo?: Promise<MongoClient> };

async function client(): Promise<MongoClient> {
  // One client per process; dev reloads reuse it rather than leaking connections.
  globalForMongo.mongo ??= (async () => {
    const c = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
    await c.connect();
    const db = c.db(process.env.MONGODB_DB ?? "devcon-jobs-matchmaker");
    await db.collection<ChatDoc>("chats").createIndex({ userId: 1 }, { unique: true });
    await db.collection<UserDoc>("users").createIndex({ userId: 1 }, { unique: true });
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

export async function users(): Promise<Collection<UserDoc>> {
  return (await db()).collection<UserDoc>("users");
}
