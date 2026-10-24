import "server-only";
import { MongoClient, type Collection } from "mongodb";

/**
 * A Devcon ticket holder. The id is derived from their pass; the pass itself is never kept.
 * Each has an agent of their own in the fleet (`userKey` reaches it) and one chat session at a time.
 */
export type UserDoc = {
  userId: string;
  name: string;
  /** The ticket's email: their agent in the fleet is found by it. */
  email: string;
  createdAt: Date;
  lastSeenAt: Date;
  agentId?: string;
  /** The agent's user API key. */
  userKey?: string;
  /** The id inside the find-humans secret the agent holds; the app mints the same secret from it. */
  findHumansId?: string;
  /** The session the search page talks to; replaced each time the page opens. */
  sessionId?: string;
  /** Set while the user's agent is being created, so two pickups cannot each make one. */
  provisioningUntil?: Date;
};

const DB = () => process.env.MONGODB_DB ?? "devcon-humans";

const globalForMongo = globalThis as unknown as { mongo?: Promise<MongoClient> };

async function client(): Promise<MongoClient> {
  // One client per process; dev reloads reuse it rather than leaking connections.
  globalForMongo.mongo ??= (async () => {
    const c = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
    await c.connect();
    await c.db(DB()).collection<UserDoc>("users").createIndex({ userId: 1 }, { unique: true });
    return c;
  })().catch((err) => {
    globalForMongo.mongo = undefined;
    throw err;
  });
  return globalForMongo.mongo;
}

export async function users(): Promise<Collection<UserDoc>> {
  return (await client()).db(DB()).collection<UserDoc>("users");
}
