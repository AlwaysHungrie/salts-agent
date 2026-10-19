// salts-tools computers: a laptop pairs from the browser (a code the signed-in user
// approves), is then linked to agents, and each link names the tools that agent gets
// from it. The Worker keeps each linked agent's side (SearXNG URL, MCP servers) in step.

/** A computer as stored. `tools` is its last report, as JSON; `gateway_token` never leaves the Worker. */
export type ComputerRow = {
  id: string;
  owner_email: string;
  name: string;
  cred_hash: string;
  tunnel_url: string;
  gateway_token: string;
  /** The token before the last change, still trusted while servers move over to the new one. */
  old_gateway_token: string;
  tools: string;
  version: string;
  last_seen: number;
  created_at: number;
};

/** One computer linked to one agent. `tools` is a JSON list of tool names switched on there. */
export type ComputerLink = {
  computer_id: string;
  agent_id: string;
  agent_name: string;
  tools: string;
  /** What the agent's side was last brought in step with; empty when it must be again. */
  synced: string;
};

export type PairingPoll =
  | { status: "pending" }
  | { status: "gone" }
  | { status: "approved"; computer_id: string; credential: string };

/** Drop pairings past their expiry. */
function prune(storage: DurableObjectStorage, now: number) {
  storage.sql.exec(`DELETE FROM salts_pairings WHERE expires_at <= ?`, now);
}

/** Open a pairing. False when too many are already waiting (nobody approves a flood). */
export function startPairing(
  storage: DurableObjectStorage,
  p: {
    userCode: string;
    deviceHash: string;
    name: string;
    now: number;
    ttl: number;
    maxPending: number;
  }
): boolean {
  prune(storage, p.now);
  const waiting = Number(storage.sql.exec(`SELECT COUNT(*) AS n FROM salts_pairings`).one().n);
  if (waiting >= p.maxPending) return false;
  storage.sql.exec(
    `INSERT INTO salts_pairings (user_code, device_hash, name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    p.userCode,
    p.deviceHash,
    p.name,
    p.now,
    p.now + p.ttl
  );
  return true;
}

/** A live pairing by the code the user sees, or undefined when unknown or expired. */
export function pairing(
  storage: DurableObjectStorage,
  userCode: string,
  now: number
): { name: string; approved: boolean } | undefined {
  const row = storage.sql
    .exec(
      `SELECT name, computer_id FROM salts_pairings WHERE user_code = ? AND expires_at > ?`,
      userCode,
      now
    )
    .toArray()[0] as { name: string; computer_id: string } | undefined;
  return row && { name: row.name, approved: !!row.computer_id };
}

/**
 * Approve a waiting pairing: the computer is created for `email`, linked to `agentIds`
 * with no tools on, and its credential held for the computer's next poll. False when the
 * code is unknown, expired or already approved.
 */
export function approvePairing(
  storage: DurableObjectStorage,
  userCode: string,
  now: number,
  c: { computerId: string; email: string; credHash: string; credential: string; agentIds: string[] }
): boolean {
  const live = pairing(storage, userCode, now);
  if (!live || live.approved) return false;
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO salts_computers (id, owner_email, name, cred_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
      c.computerId,
      c.email,
      live.name,
      c.credHash,
      now
    );
    for (const agentId of c.agentIds) setLink(storage, c.computerId, agentId, []);
    storage.sql.exec(
      `UPDATE salts_pairings SET computer_id = ?, credential = ? WHERE user_code = ?`,
      c.computerId,
      c.credential,
      userCode
    );
  });
  return true;
}

/** The computer's poll: once approved, its credential, handed over once and then forgotten. */
export function pollPairing(
  storage: DurableObjectStorage,
  deviceHash: string,
  now: number
): PairingPoll {
  prune(storage, now);
  const row = storage.sql
    .exec(
      `SELECT user_code, computer_id, credential FROM salts_pairings WHERE device_hash = ?`,
      deviceHash
    )
    .toArray()[0] as { user_code: string; computer_id: string; credential: string } | undefined;
  if (!row) return { status: "gone" };
  if (!row.computer_id) return { status: "pending" };
  storage.sql.exec(`DELETE FROM salts_pairings WHERE user_code = ?`, row.user_code);
  return { status: "approved", computer_id: row.computer_id, credential: row.credential };
}

export function computer(storage: DurableObjectStorage, id: string): ComputerRow | undefined {
  return storage.sql
    .exec(`SELECT * FROM salts_computers WHERE id = ?`, id)
    .toArray()[0] as unknown as ComputerRow | undefined;
}

/** The computers `email` paired, newest first. */
export function computersOf(storage: DurableObjectStorage, email: string): ComputerRow[] {
  return storage.sql
    .exec(`SELECT * FROM salts_computers WHERE owner_email = ? ORDER BY created_at DESC`, email)
    .toArray() as unknown as ComputerRow[];
}

/**
 * Write what the computer reports. A new gateway token keeps the previous one as
 * `old_gateway_token`, so servers made with it are still recognised as this computer's.
 * An empty tunnel (one being replaced) keeps the last address rather than clearing it.
 */
export function reportComputer(
  storage: DurableObjectStorage,
  id: string,
  r: { tunnel_url: string; gateway_token: string; tools: string; version: string; now: number }
) {
  storage.sql.exec(
    `UPDATE salts_computers SET
       old_gateway_token = CASE WHEN gateway_token != ? AND gateway_token != '' THEN gateway_token ELSE old_gateway_token END,
       gateway_token = ?, tunnel_url = CASE WHEN ? != '' THEN ? ELSE tunnel_url END,
       tools = ?, version = ?, last_seen = ?
     WHERE id = ?`,
    r.gateway_token,
    r.gateway_token,
    r.tunnel_url,
    r.tunnel_url,
    r.tools,
    r.version,
    r.now,
    id
  );
}

const LINK_COLUMNS = `l.computer_id, l.agent_id, a.name AS agent_name, l.tools, l.synced`;

/** A computer's links to agents that still exist, by agent name. */
export function linksOf(storage: DurableObjectStorage, computerId: string): ComputerLink[] {
  return storage.sql
    .exec(
      `SELECT ${LINK_COLUMNS} FROM salts_links l JOIN agents a ON a.id = l.agent_id
       WHERE l.computer_id = ? ORDER BY a.name`,
      computerId
    )
    .toArray() as unknown as ComputerLink[];
}

/** Every computer linked to one agent. */
export function linksOfAgent(storage: DurableObjectStorage, agentId: string): ComputerLink[] {
  return storage.sql
    .exec(
      `SELECT ${LINK_COLUMNS} FROM salts_links l JOIN agents a ON a.id = l.agent_id
       WHERE l.agent_id = ?`,
      agentId
    )
    .toArray() as unknown as ComputerLink[];
}

/** Marks a new link: its first sync adopts what this computer already put on the agent. */
export const ADOPT = "adopt";

/**
 * Link an agent with these tools on, or change an existing link's tools; its side is
 * brought in step again. A new link starts as ADOPT.
 */
export function setLink(
  storage: DurableObjectStorage,
  computerId: string,
  agentId: string,
  tools: string[]
) {
  storage.sql.exec(
    `INSERT INTO salts_links (computer_id, agent_id, tools, synced) VALUES (?, ?, ?, '${ADOPT}')
     ON CONFLICT (computer_id, agent_id) DO UPDATE SET tools = excluded.tools, synced = ''`,
    computerId,
    agentId,
    JSON.stringify(tools)
  );
}

export function markSynced(
  storage: DurableObjectStorage,
  computerId: string,
  agentId: string,
  synced: string
) {
  storage.sql.exec(
    `UPDATE salts_links SET synced = ? WHERE computer_id = ? AND agent_id = ?`,
    synced,
    computerId,
    agentId
  );
}

export function removeLink(storage: DurableObjectStorage, computerId: string, agentId: string) {
  storage.sql.exec(
    `DELETE FROM salts_links WHERE computer_id = ? AND agent_id = ?`,
    computerId,
    agentId
  );
}

export function removeComputer(storage: DurableObjectStorage, id: string) {
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM salts_links WHERE computer_id = ?`, id);
    storage.sql.exec(`DELETE FROM salts_computers WHERE id = ?`, id);
  });
}
