/**
 * Versioned migrations for a Durable Object's own SQLite, applied lazily per object.
 * Step 0 is the idempotent baseline; later steps run exactly once and may fail loudly,
 * leaving the version unadvanced. Tracked in `schema_migrations`.
 */

/** The SQL surface a migration is handed. Narrower than the storage object on purpose. */
export type MigrationSql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

export type Migration = {
  /** What this step does, in a few words. Read by `schemaStatus`, and by whoever is on call. */
  readonly name: string;
  readonly up: (sql: MigrationSql) => void;
};

/** The storage context a Durable Object exposes to this runner. */
type MigrationCtx = {
  storage: {
    sql: MigrationSql;
    transactionSync<T>(fn: () => T): T;
  };
};

/**
 * Apply pending steps and return the version reached. Each step and its record commit
 * in one `transactionSync`; a throwing step fails this request only.
 */
export function applyMigrations(ctx: MigrationCtx, migrations: readonly Migration[]): number {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     version INTEGER NOT NULL,
     applied_at INTEGER NOT NULL
   )`);

  let current = readVersion(sql);

  for (let i = current; i < migrations.length; i++) {
    const step = migrations[i];
    const next = i + 1;
    try {
      ctx.storage.transactionSync(() => {
        step.up(sql);
        sql.exec(
          `INSERT INTO schema_migrations (id, version, applied_at) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
          next,
          Date.now()
        );
      });
    } catch (err) {
      // Name the rung. Without this the message is whatever SQLite said about a
      // statement, with no clue which migration ran it.
      throw new Error(
        `migration ${next} (${step.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    current = next;
  }

  return current;
}

/** How far this object has got, without running anything. */
export function schemaVersion(sql: MigrationSql): number {
  return readVersion(sql);
}

function readVersion(sql: MigrationSql): number {
  const row = sql.exec(`SELECT version FROM schema_migrations WHERE id = 1`).toArray()[0];
  return Number(row?.version ?? 0);
}

/**
 * `ALTER TABLE ... ADD COLUMN`, tolerating only an existing column; other errors rethrow.
 * For the baseline only: later steps use `sql.exec`, where a duplicate is a real bug.
 */
export function addColumnIfMissing(sql: MigrationSql, table: string, column: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (message.includes("duplicate column")) return;
    throw err;
  }
}
