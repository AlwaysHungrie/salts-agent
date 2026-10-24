import { addColumnIfMissing, type Migration } from "../schema";
import { splitEmails } from "./emails";

/** The directory's migration ladder. Step 0 is the idempotent baseline; append, never edit. */
export const AGENT_DIRECTORY_MIGRATIONS: readonly Migration[] = [
  {
    name: "baseline",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agents (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           allowed_emails TEXT NOT NULL DEFAULT '',
           admin_email TEXT NOT NULL DEFAULT ''
         )`
      );
      // Bring forward rows created before an agent had an access list, and before the
      // admin was a person rather than everyone on that list.
      for (const col of [
        `allowed_emails TEXT NOT NULL DEFAULT ''`,
        `admin_email TEXT NOT NULL DEFAULT ''`,
        // Cached session count so admin stats are one query; -1 means never measured (backfilled
        // by the stats route).
        `session_count INTEGER NOT NULL DEFAULT -1`,
        // The fleet an agent was created into. Empty on every agent made before
        // fleets existed, which is exactly what "stands alone" means.
        `fleet_id TEXT NOT NULL DEFAULT ''`,
        `fleet_name TEXT NOT NULL DEFAULT ''`,
      ])
        addColumnIfMissing(sql, "agents", col);
      // Agents from before the admin split get the first listed address as admin.
      sql.exec(
        `UPDATE agents
            SET admin_email = lower(trim(
                  CASE WHEN instr(allowed_emails, char(10)) > 0
                       THEN substr(allowed_emails, 1, instr(allowed_emails, char(10)) - 1)
                       ELSE allowed_emails END))
          WHERE admin_email = ''`
      );

      // One row per address, which is what makes "the agents this person may open" an
      // index lookup instead of a walk over every agent in the deployment.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agent_members (
           agent_id TEXT NOT NULL,
           email TEXT NOT NULL,
           PRIMARY KEY (agent_id, email)
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agent_members_email ON agent_members(email)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agents_admin_email ON agents(admin_email)`);
      // Carries the sort key so a page of a large fleet is a range scan, not a sort.
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agents_fleet ON agents(fleet_id, created_at, id)`);

      // Only business accounts have a row; everyone else gets `default_agent_limit`.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS account_limits (
           email TEXT PRIMARY KEY,
           agent_limit INTEGER NOT NULL
         )`
      );

      // A fleet's own meta document: what new agents in it are created with. Kept here because
      // each agent's copy drifts as its users edit what they may.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS fleet_meta (
           fleet_id TEXT PRIMARY KEY,
           json TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );

      // A queue: approving folds the increase into `account_limits`, deleting drops the ask.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS business_requests (
           id TEXT PRIMARY KEY,
           email TEXT NOT NULL,
           requested_increase INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         )`
      );
    },
  },
  {
    // Deployment settings in the singleton directory, so ceilings change without a deploy
    // and no agent can raise its own. One JSON row: nested, and nothing queries its fields.
    name: "deployment settings",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS deployment_settings (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           json TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );
    },
  },
  {
    // Metadata tags let each app list only its own agents. Guests are an index copy of each
    // agent's guest settings; the registry stays the authority.
    name: "agent metadata and guests",
    up: (sql) => {
      addColumnIfMissing(sql, "agents", `metadata TEXT NOT NULL DEFAULT '{}'`);
      addColumnIfMissing(sql, "agents", `guests INTEGER NOT NULL DEFAULT 0`);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agent_guests (
           agent_id TEXT NOT NULL,
           email TEXT NOT NULL,
           PRIMARY KEY (agent_id, email)
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agent_guests_email ON agent_guests(email)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agents_guests ON agents(guests)`);
    },
  },
  {
    // salts-tools computers: paired from the browser, linked to agents, each link with the
    // tools that agent gets from that computer.
    name: "salts-tools computers",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS salts_pairings (
           user_code TEXT PRIMARY KEY,
           device_hash TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL,
           computer_id TEXT NOT NULL DEFAULT '',
           credential TEXT NOT NULL DEFAULT ''
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS salts_computers (
           id TEXT PRIMARY KEY,
           owner_email TEXT NOT NULL,
           name TEXT NOT NULL,
           cred_hash TEXT NOT NULL,
           tunnel_url TEXT NOT NULL DEFAULT '',
           gateway_token TEXT NOT NULL DEFAULT '',
           old_gateway_token TEXT NOT NULL DEFAULT '',
           tools TEXT NOT NULL DEFAULT '{}',
           version TEXT NOT NULL DEFAULT '',
           last_seen INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         )`
      );
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_salts_computers_owner ON salts_computers(owner_email)`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS salts_links (
           computer_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           tools TEXT NOT NULL DEFAULT '[]',
           synced TEXT NOT NULL DEFAULT '',
           PRIMARY KEY (computer_id, agent_id)
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_salts_links_agent ON salts_links(agent_id)`);
    },
  },
  {
    name: "openrouter wallet",
    up: (sql) => {
      // Each account's OpenRouter keys. A provisioned key's secret never leaves the Worker.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS wallet_keys (
           id TEXT PRIMARY KEY,
           email TEXT NOT NULL,
           nickname TEXT NOT NULL,
           kind TEXT NOT NULL,
           secret TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_keys_email ON wallet_keys(email)`);
      // Which agent holds which wallet key, so removing a key reaches every copy of it.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS wallet_key_uses (
           agent_id TEXT PRIMARY KEY,
           key_id TEXT NOT NULL
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_key_uses_key ON wallet_key_uses(key_id)`);
    },
  },
  {
    name: "wallet purchases",
    up: (sql) => {
      // A quote a buyer pays against. `tx` is unique, so one payment counts once.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS wallet_purchases (
           id TEXT PRIMARY KEY,
           email TEXT NOT NULL,
           key_id TEXT NOT NULL DEFAULT '',
           amount_usd REAL NOT NULL,
           network TEXT NOT NULL,
           asset TEXT NOT NULL,
           to_address TEXT NOT NULL,
           payer TEXT NOT NULL,
           units TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           tx TEXT,
           created_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL
         )`
      );
      sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_purchases_tx ON wallet_purchases(tx)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_purchases_email ON wallet_purchases(email)`);
    },
  },
  {
    name: "wallet provisioning",
    up: (sql) => {
      // A bought key's handle at OpenRouter, to remove it there too.
      addColumnIfMissing(sql, "wallet_keys", `openrouter_hash TEXT NOT NULL DEFAULT ''`);
      // When a paid purchase was taken up for delivery, so two confirms cannot both deliver.
      addColumnIfMissing(sql, "wallet_purchases", `claimed_at INTEGER NOT NULL DEFAULT 0`);
      // Values the owner sets for the deployment from the admin CLI: the OpenRouter
      // provisioning key, the payment addresses and Reown's project id.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS deployment_secrets (
           name TEXT PRIMARY KEY,
           value TEXT NOT NULL
         )`
      );
    },
  },
  {
    name: "fleet keys",
    up: (sql) => {
      // A fleet's API key, as a hash: what an app outside salts adds agents to the fleet with.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS fleet_keys (
           fleet_id TEXT PRIMARY KEY,
           hash TEXT NOT NULL,
           hint TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL DEFAULT 0
         )`
      );
    },
  },
];

export function migrateMembership(storage: DurableObjectStorage) {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const current = Number(
    (sql.exec(`SELECT version FROM schema_version LIMIT 1`).toArray()[0]?.version as
      number | undefined) ?? 0
  );

  // v1: membership moves from the newline-separated column to its own table. The
  // column is the only record of who was on which list, so it is read, not cleared.
  if (current < 1) {
    storage.transactionSync(() => {
      const rows = sql.exec(`SELECT id, allowed_emails FROM agents`).toArray() as unknown as {
        id: string;
        allowed_emails: string;
      }[];
      for (const row of rows) {
        for (const email of splitEmails(row.allowed_emails)) {
          sql.exec(
            `INSERT OR IGNORE INTO agent_members (agent_id, email) VALUES (?, ?)`,
            row.id,
            email
          );
        }
      }
      sql.exec(`DELETE FROM schema_version`);
      sql.exec(`INSERT INTO schema_version (version) VALUES (1)`);
    });
  }
}
