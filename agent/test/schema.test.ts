import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addColumnIfMissing, applyMigrations, schemaVersion, type Migration } from "../src/schema";

/**
 * The migration runner, against real Durable Object SQLite.
 *
 * Deliberately not against a mock. The whole reason this file exists is that schema
 * changes reach production one object at a time, lazily, with no operator watching —
 * so the properties that matter are the ones a fake would be happy to fake: that a
 * step runs exactly once, that a failure leaves the version where it was, and that a
 * half-applied step is not recorded as applied.
 *
 * `SessionRegistry` is borrowed as a host for a scratch database. Which class it is
 * does not matter; what matters is that the storage is the real thing.
 */

function host() {
  // A fresh name per test, so each one gets its own empty SQLite.
  return env.SessionRegistry.get(env.SessionRegistry.idFromName(crypto.randomUUID()));
}

/** Records the order steps ran in, so "exactly once" is observable. */
function ladder(log: string[]): Migration[] {
  return [
    {
      name: "one",
      up: (sql) => {
        log.push("one");
        sql.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`);
      },
    },
    {
      name: "two",
      up: (sql) => {
        log.push("two");
        sql.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY)`);
      },
    },
  ];
}

describe("applyMigrations", () => {
  let log: string[];
  beforeEach(() => {
    log = [];
  });

  it("applies every step and reports the version reached", async () => {
    const stub = host();
    const version = await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log)));
    expect(version).toBe(2);
    expect(log).toEqual(["one", "two"]);
  });

  it("runs each step exactly once across repeated calls", async () => {
    const stub = host();
    await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log)));
    await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log)));
    await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log)));
    // The second and third calls are what a cold start after a deploy looks like.
    // Re-running `up` there would re-run any backfill written into it.
    expect(log).toEqual(["one", "two"]);
  });

  it("runs only the steps appended since the last run", async () => {
    const stub = host();
    await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log).slice(0, 1)));
    expect(log).toEqual(["one"]);

    const grown = [
      ...ladder(log),
      {
        name: "three",
        up: (sql: Parameters<Migration["up"]>[0]) => {
          log.push("three");
          sql.exec(`CREATE TABLE t3 (id INTEGER PRIMARY KEY)`);
        },
      },
    ];
    const version = await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, grown));
    expect(version).toBe(3);
    // "one" is not repeated: this is the ladder doing the thing the old
    // `catch {}` pattern could never do.
    expect(log).toEqual(["one", "two", "three"]);
  });

  it("is a no-op when already at the end of the ladder", async () => {
    const stub = host();
    await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log)));
    log.length = 0;
    const version = await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, ladder(log)));
    expect(version).toBe(2);
    expect(log).toEqual([]);
  });

  it("names the failing step in the error", async () => {
    const stub = host();
    const broken: Migration[] = [
      { name: "fine", up: (sql) => sql.exec(`CREATE TABLE ok (id INTEGER PRIMARY KEY)`) },
      {
        name: "explodes",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    await expect(
      runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, broken))
    ).rejects.toThrow(/migration 2 \(explodes\) failed: boom/);
  });

  it("leaves the version at the last good step when one fails", async () => {
    const stub = host();
    const broken: Migration[] = [
      { name: "fine", up: (sql) => sql.exec(`CREATE TABLE ok (id INTEGER PRIMARY KEY)`) },
      {
        name: "explodes",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    await expect(
      runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, broken))
    ).rejects.toThrow();

    const version = await runInDurableObject(stub, (_i, ctx) => schemaVersion(ctx.storage.sql));
    // Not 2. The next request into this object has to retry the failed rung, which is
    // what makes a transient failure recoverable without anyone intervening.
    expect(version).toBe(1);
  });

  it("does not record a step whose write failed partway", async () => {
    const stub = host();
    const partial: Migration[] = [
      {
        name: "half",
        up: (sql) => {
          sql.exec(`CREATE TABLE half (id INTEGER PRIMARY KEY)`);
          sql.exec(`INSERT INTO half (id) VALUES (1)`);
          throw new Error("failed after writing");
        },
      },
    ];
    await expect(
      runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, partial))
    ).rejects.toThrow();

    const state = await runInDurableObject(stub, (_i, ctx) => {
      const version = schemaVersion(ctx.storage.sql);
      let rows = -1;
      try {
        rows = (
          ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM half`).toArray()[0] as { n: number }
        ).n;
      } catch {
        rows = -1; // The table itself was rolled back, which is the stronger outcome.
      }
      return { version, rows };
    });
    expect(state.version).toBe(0);
    // The step ran inside a transaction with the version write, so its partial work is
    // gone too: either the table does not exist, or it is empty. Never "row present,
    // version not advanced", which would double the row on the retry.
    expect(state.rows).toBeLessThanOrEqual(0);
  });

  it("retries a failed step successfully once the cause is gone", async () => {
    const stub = host();
    let fail = true;
    const flaky: Migration[] = [
      {
        name: "flaky",
        up: (sql) => {
          if (fail) throw new Error("transient");
          sql.exec(`CREATE TABLE later (id INTEGER PRIMARY KEY)`);
        },
      },
    ];
    await expect(
      runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, flaky))
    ).rejects.toThrow();
    fail = false;
    const version = await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, flaky));
    expect(version).toBe(1);
  });

  it("reports version 0 for a database that has never been migrated", async () => {
    const stub = host();
    const version = await runInDurableObject(stub, (_i, ctx) => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           version INTEGER NOT NULL,
           applied_at INTEGER NOT NULL)`
      );
      return schemaVersion(ctx.storage.sql);
    });
    expect(version).toBe(0);
  });

  it("accepts an empty ladder", async () => {
    const stub = host();
    expect(await runInDurableObject(stub, (_i, ctx) => applyMigrations(ctx, []))).toBe(0);
  });
});

describe("addColumnIfMissing", () => {
  it("adds a column that is not there", async () => {
    const stub = host();
    const names = await runInDurableObject(stub, (_i, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      addColumnIfMissing(sql, "t", `extra TEXT NOT NULL DEFAULT ''`);
      sql.exec(`INSERT INTO t (id) VALUES (1)`);
      return Object.keys(sql.exec(`SELECT * FROM t`).toArray()[0]);
    });
    expect(names).toContain("extra");
  });

  it("is silent when the column is already there", async () => {
    const stub = host();
    await runInDurableObject(stub, (_i, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, extra TEXT NOT NULL DEFAULT '')`);
      // This is the case the whole helper exists for: an object created after the
      // column shipped runs the same baseline as one created before it.
      expect(() => addColumnIfMissing(sql, "t", `extra TEXT NOT NULL DEFAULT ''`)).not.toThrow();
    });
  });

  it("preserves existing rows when adding a column", async () => {
    const stub = host();
    const row = await runInDurableObject(stub, (_i, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      sql.exec(`INSERT INTO t (id) VALUES (7)`);
      addColumnIfMissing(sql, "t", `extra TEXT NOT NULL DEFAULT 'filled'`);
      return sql.exec(`SELECT id, extra FROM t`).toArray()[0];
    });
    // The default is what every pre-existing row gets. If this were null the column
    // would be unreadable by code that declared it NOT NULL.
    expect(row).toEqual({ id: 7, extra: "filled" });
  });

  it("rethrows an error that is not a duplicate column", async () => {
    const stub = host();
    // The bug the old `catch {}` could hide: a statement that fails for a real reason
    // being swallowed, leaving the object serving a schema nobody checked.
    await expect(
      runInDurableObject(stub, (_i, ctx) =>
        addColumnIfMissing(ctx.storage.sql, "no_such_table", `c TEXT`)
      )
    ).rejects.toThrow();
  });

  it("rethrows a malformed column definition", async () => {
    const stub = host();
    await expect(
      runInDurableObject(stub, (_i, ctx) => {
        ctx.storage.sql.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
        addColumnIfMissing(ctx.storage.sql, "t", `this is not valid sql`);
      })
    ).rejects.toThrow();
  });
});
