import { addColumnIfMissing, type Migration } from "../schema";
import { splitEmails } from "./emails";

/**
 * The directory's tables, in the order they were introduced.
 *
 * Step 0 is the baseline, written idempotently because the live directory object
 * already has all of it. Append below; do not edit it.
 */
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
        // A cached count of the agent's sessions, kept here so the admin dashboard is
        // one query against this object instead of one round trip per agent. `-1` means
        // "never measured" — the rows that existed before this column did — and the
        // stats route fills those in once, by asking each session registry directly.
        `session_count INTEGER NOT NULL DEFAULT -1`,
        // The fleet an agent was created into. Empty on every agent made before
        // fleets existed, which is exactly what "stands alone" means.
        `fleet_id TEXT NOT NULL DEFAULT ''`,
        `fleet_name TEXT NOT NULL DEFAULT ''`,
      ])
        addColumnIfMissing(sql, "agents", col);
      // Agents made before the split have no admin, and no record of who created them:
      // everyone on the list was both user and administrator. The first address on the
      // list is the closest thing to the creator that was ever written down — the
      // create dialog seeds the box with their own address — so it inherits the role.
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
      // One fleet's agents, in page order. A fleet is the one list here that can run
      // to thousands of rows, so the index carries the sort key as well as the
      // grouping key: a page of it is a range scan, never a sort of the whole fleet.
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agents_fleet ON agents(fleet_id, created_at, id)`);

      // Absence is the ordinary case: an account with no row here administers at most
      // `default_agent_limit` agent. A row is only ever written by the owner's own
      // admin route, so this table's whole contents are the deployment's business
      // accounts.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS account_limits (
           email TEXT PRIMARY KEY,
           agent_limit INTEGER NOT NULL
         )`
      );

      // A fleet's own meta document: the settings every agent in it was created
      // holding, and the ones an agent added later is created holding.
      //
      // Kept here rather than read off any one of the fleet's agents, because an
      // agent's own meta document drifts — it is overwritten wholesale each time the
      // fleet's is applied, and between applications its users change what they are
      // allowed to change. This row is what the fleet *means*, which is a different
      // question from what any agent currently holds.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS fleet_meta (
           fleet_id TEXT PRIMARY KEY,
           json TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );

      // A queue, not a log: a request sits here until the owner resolves it, then it's
      // gone — approving folds the increase into `account_limits` and deleting just
      // clears the ask. Nothing downstream reads a resolved request, so there is
      // nothing worth keeping one around for.
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
    // The deployment's own knobs, in the one object there is exactly one of.
    //
    // Here rather than in a `wrangler` var because the point is to change a ceiling
    // without a deploy, and here rather than in each agent's own registry because a
    // ceiling is the deployment's answer, not an agent's — an agent that could raise
    // its own `max_sessions` would not have a limit.
    //
    // One row holding a JSON patch: the document is nested, nothing queries a field
    // of it, and it holds only what this deployment has decided for itself, so a
    // column per setting would be a migration per setting for no lookup.
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
    // Metadata: free-form tags an app attaches to the agents it makes, so each app
    // lists only its own (`with`) and the others can leave them out (`without`).
    //
    // Guests: an index copy of each agent's guest switch and list, so "the agents
    // this address may message" is a query. The registry stays the authority.
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
