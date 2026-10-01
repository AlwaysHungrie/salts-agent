/**
 * The agent's two API keys, one per role. Only a hash is stored: the key itself is shown
 * once, when it is generated, and a lost key is replaced rather than recovered.
 */

export type ApiKeyRole = "admin" | "user";
export const API_KEY_ROLES: readonly ApiKeyRole[] = ["admin", "user"];

/** What a settings page may know about a key: that it exists, and how to recognise it. */
export type ApiKeyInfo = { role: ApiKeyRole; hint: string; created_at: number };

export function listApiKeys(storage: DurableObjectStorage): ApiKeyInfo[] {
  return storage.sql
    .exec(`SELECT role, hint, created_at FROM api_keys ORDER BY role`)
    .toArray() as ApiKeyInfo[];
}

export function apiKeyHash(storage: DurableObjectStorage, role: ApiKeyRole): string {
  const row = storage.sql.exec(`SELECT hash FROM api_keys WHERE role = ?`, role).toArray()[0] as
    { hash: string } | undefined;
  return row?.hash ?? "";
}

/** Replace the role's key: the old one stops working the moment this returns. */
export function setApiKey(
  storage: DurableObjectStorage,
  role: ApiKeyRole,
  hash: string,
  hint: string
): ApiKeyInfo {
  const created_at = Date.now();
  storage.sql.exec(
    `INSERT INTO api_keys (role, hash, hint, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET
       hash = excluded.hash, hint = excluded.hint, created_at = excluded.created_at`,
    role,
    hash,
    hint,
    created_at
  );
  return { role, hint, created_at };
}

export function removeApiKey(storage: DurableObjectStorage, role: ApiKeyRole): void {
  storage.sql.exec(`DELETE FROM api_keys WHERE role = ?`, role);
}
