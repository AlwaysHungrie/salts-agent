/**
 * Bought keys, made at OpenRouter with the deployment's provisioning key (set from the
 * admin CLI). A key's limit is the credit bought, so it can spend no more than was paid
 * for; the deployment's OpenRouter credit is shared by every bought key.
 */

const KEYS = "https://openrouter.ai/api/v1/keys";

/** OpenRouter refused or did not answer; the purchase stays paid, to deliver later. */
export class ProvisioningError extends Error {}

async function call<T>(provisioning: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${KEYS}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${provisioning}`, "content-type": "application/json" },
    });
  } catch {
    throw new ProvisioningError("OpenRouter didn't answer.");
  }
  if (!res.ok) throw new ProvisioningError(`OpenRouter refused (${res.status}).`);
  return (await res.json()) as T;
}

/** Make a key held to `limit` dollars. `name` is what OpenRouter's dashboard lists it by. */
export async function createKey(
  provisioning: string,
  name: string,
  limit: number
): Promise<{ secret: string; openrouter_hash: string }> {
  const made = await call<{ key?: string; data?: { hash?: string } }>(provisioning, "", {
    method: "POST",
    body: JSON.stringify({ name, limit }),
  });
  if (!made.key || !made.data?.hash) throw new ProvisioningError("OpenRouter made no key.");
  return { secret: made.key, openrouter_hash: made.data.hash };
}

export async function deleteKey(provisioning: string, hash: string) {
  await call(provisioning, `/${encodeURIComponent(hash)}`, { method: "DELETE" });
}

/** Whether `key` is a provisioning key: only one may list the account's keys. */
export async function isProvisioningKey(key: string): Promise<boolean> {
  try {
    await call(key, "?offset=0");
    return true;
  } catch {
    return false;
  }
}
