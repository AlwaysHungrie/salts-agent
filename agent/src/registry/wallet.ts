import type { WalletKeyKind, WalletKeyRow } from "./types";

/** A wallet key's id: short, and safe to put in a URL or a config column. */
const WALLET_ID = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const ADJECTIVES = [
  "Amber", "Brisk", "Calm", "Coral", "Crimson", "Dusky", "Golden", "Hazel", "Indigo", "Jade",
  "Lively", "Lunar", "Misty", "Noble", "Olive", "Quiet", "Rapid", "Rosy", "Silver", "Sunny",
  "Swift", "Tidal", "Velvet", "Wild",
];
const NOUNS = [
  "Badger", "Comet", "Cedar", "Falcon", "Fern", "Finch", "Harbor", "Heron", "Lynx", "Maple",
  "Meadow", "Otter", "Pebble", "Pine", "Raven", "Reef", "River", "Sparrow", "Summit", "Tiger",
  "Willow", "Wren",
];
const pickOne = (list: string[]) => list[Math.floor(Math.random() * list.length)];

/**
 * A nickname none of `taken` already uses: two random words, with a number added once
 * the word pairs run short.
 */
function freshNickname(taken: Set<string>): string {
  for (let tries = 0; ; tries++) {
    const name = `${pickOne(ADJECTIVES)} ${pickOne(NOUNS)}${tries > 20 ? ` ${tries}` : ""}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function walletKeys(storage: DurableObjectStorage, email: string): WalletKeyRow[] {
  const rows = storage.sql
    .exec(
      `SELECT k.id, k.email, k.nickname, k.kind, k.secret, k.created_at, k.openrouter_hash,
              (SELECT COUNT(*) FROM wallet_key_uses u WHERE u.key_id = k.id) AS agents
         FROM wallet_keys k
        WHERE k.email = ?
        ORDER BY k.created_at ASC, k.id ASC`,
      email.trim().toLowerCase()
    )
    .toArray();
  return rows as unknown as WalletKeyRow[];
}

/** One of `email`'s keys, or undefined when it is not theirs (or does not exist). */
export function walletKey(
  storage: DurableObjectStorage,
  email: string,
  id: string
): WalletKeyRow | undefined {
  return walletKeys(storage, email).find((k) => k.id === id);
}

/**
 * Add a key to `email`'s wallet under a nickname of its own, unique in that wallet.
 * Refused as `{ error }` (not thrown, so the route can answer 400) when the wallet is full
 * or already holds this key.
 */
export function addWalletKey(
  storage: DurableObjectStorage,
  email: string,
  key: { kind: WalletKeyKind; secret: string; openrouter_hash?: string },
  max: number
): WalletKeyRow | { error: string } {
  const owner = email.trim().toLowerCase();
  const existing = walletKeys(storage, owner);
  if (existing.some((k) => k.secret === key.secret)) return { error: "Key already imported" };
  if (existing.length >= max) return { error: `A wallet holds at most ${max} keys.` };
  const row: WalletKeyRow = {
    id: WALLET_ID(),
    email: owner,
    nickname: freshNickname(new Set(existing.map((k) => k.nickname.toLowerCase()))),
    kind: key.kind,
    secret: key.secret,
    created_at: Date.now(),
    agents: 0,
    openrouter_hash: key.openrouter_hash ?? "",
  };
  storage.sql.exec(
    `INSERT INTO wallet_keys (id, email, nickname, kind, secret, created_at, openrouter_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.email,
    row.nickname,
    row.kind,
    row.secret,
    row.created_at,
    row.openrouter_hash
  );
  return row;
}

/**
 * Remove one of `email`'s keys. Returns the agents that held it, for the caller to clear;
 * undefined when the key is not theirs.
 */
export function removeWalletKey(
  storage: DurableObjectStorage,
  email: string,
  id: string
): string[] | undefined {
  if (!walletKey(storage, email, id)) return undefined;
  const agents = storage.sql
    .exec(`SELECT agent_id FROM wallet_key_uses WHERE key_id = ?`, id)
    .toArray() as unknown as { agent_id: string }[];
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM wallet_keys WHERE id = ?`, id);
    storage.sql.exec(`DELETE FROM wallet_key_uses WHERE key_id = ?`, id);
  });
  return agents.map((a) => a.agent_id);
}

/** Record which wallet key an agent now holds; blank when it holds none (or a pasted one). */
export function setWalletKeyUse(storage: DurableObjectStorage, agentId: string, keyId: string) {
  if (!keyId) {
    storage.sql.exec(`DELETE FROM wallet_key_uses WHERE agent_id = ?`, agentId);
    return;
  }
  storage.sql.exec(
    `INSERT INTO wallet_key_uses (agent_id, key_id) VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET key_id = excluded.key_id`,
    agentId,
    keyId
  );
}
