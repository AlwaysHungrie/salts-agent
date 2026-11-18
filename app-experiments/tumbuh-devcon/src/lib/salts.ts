import { WALLET_NETWORK } from "./chain";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

async function call<T>(path: string, key: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${need("SALTS_API_BASE")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`Salts ${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

/**
 * The email's agent in the fleet (created once, never twice), its wallet set to Base with
 * USDC, and the wallet's EVM address. Needs the wallet capability on in the fleet settings.
 */
export async function walletFor(email: string): Promise<string> {
  const key = need("FLEET_API_KEY");
  // The fleet id is part of the key: salt_fleet_<id>_<secret>.
  const fleet = key.split("_")[2];
  const base = `/api/fleets/${fleet}/agents`;
  let { agents } = await call<{ agents: { id: string }[] }>(
    `${base}?email=${encodeURIComponent(email)}`,
    key
  );
  if (!agents.length) {
    ({ agents } = await call<{ agents: { id: string }[] }>(base, key, {
      method: "POST",
      body: JSON.stringify({ allowed_emails: email }),
    }));
  }
  const id = agents[0].id;
  // The fleet key cannot touch an agent's wallet; a fresh user key for the agent can.
  const { key: agentKey } = await call<{ key: string }>(`${base}/${id}/api-keys/user`, key, {
    method: "POST",
  });
  const agentPath = `/api/agents/${id}/chain-wallet`;
  await call(`${agentPath}/networks`, agentKey, {
    method: "PUT",
    body: JSON.stringify({ networks: [WALLET_NETWORK] }),
  });
  const wallet = await call<{ evm: string }>(agentPath, agentKey);
  return wallet.evm;
}
