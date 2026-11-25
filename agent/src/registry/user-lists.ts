import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type Migration } from "../schema";

/**
 * One account's lists: named, ordered lists of short entries (groceries, books to read,
 * people to call). One object per account, named by the owner's email, so every agent the
 * account owns and every session of each reads and writes the same lists.
 */

export type ListItem = { id: number; text: string };

/** A list without its entries: what the model is shown at the start of every turn. */
export type ListSummary = {
  id: number;
  name: string;
  description: string;
  items: number;
  updated_at: number;
};

export type UserList = Omit<ListSummary, "items"> & { items: ListItem[] };

/** The ceilings a write is checked against, from the deployment settings. */
export type ListLimits = { lists: number; items: number; chars: number };

export const USER_LISTS_MIGRATIONS: readonly Migration[] = [
  {
    name: "baseline",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS lists (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE COLLATE NOCASE,
           description TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS list_items (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           list_id INTEGER NOT NULL,
           text TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS list_items_list ON list_items (list_id, id)`);
    },
  },
];

/** A list name as stored: one line, trimmed. Names are matched without regard to case. */
export function listName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 100);
}

export class UserLists extends DurableObject {
  private ready = false;

  private ensureSchema() {
    if (this.ready) return;
    applyMigrations(this.ctx, USER_LISTS_MIGRATIONS);
    this.ready = true;
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec(query, ...(bindings as never[])).toArray() as T[];
  }

  private find(name: string): Omit<ListSummary, "items"> {
    const row = this.rows<Omit<ListSummary, "items">>(
      `SELECT id, name, description, updated_at FROM lists WHERE name = ? LIMIT 1`,
      listName(name)
    )[0];
    if (!row) throw new Error(`there is no list called "${listName(name)}"`);
    return row;
  }

  private touch(id: number) {
    this.ctx.storage.sql.exec(`UPDATE lists SET updated_at = ? WHERE id = ?`, Date.now(), id);
  }

  private itemsOf(id: number): ListItem[] {
    return this.rows<ListItem>(`SELECT id, text FROM list_items WHERE list_id = ? ORDER BY id`, id);
  }

  /** Every list with how many entries it holds, most recently changed first. */
  index(): ListSummary[] {
    this.ensureSchema();
    return this.rows<ListSummary>(
      `SELECT l.id, l.name, l.description, l.updated_at,
              (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS items
       FROM lists l ORDER BY l.updated_at DESC, l.id DESC`
    );
  }

  /** Every list with its entries, for the files view. */
  all(): UserList[] {
    return this.index().map(({ items: _count, ...list }) => ({
      ...list,
      items: this.itemsOf(list.id),
    }));
  }

  read(name: string): UserList {
    this.ensureSchema();
    const list = this.find(name);
    return { ...list, items: this.itemsOf(list.id) };
  }

  create(name: string, description: string, limits: ListLimits): ListSummary {
    this.ensureSchema();
    const clean = listName(name);
    if (!clean) throw new Error("a list needs a name");
    const taken = this.rows(`SELECT id FROM lists WHERE name = ? LIMIT 1`, clean)[0];
    if (taken) throw new Error(`a list called "${clean}" already exists`);
    const count = this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM lists`)[0].n;
    if (count >= limits.lists) {
      throw new Error(`the ${limits.lists} list limit is reached; delete a list first`);
    }
    const now = Date.now();
    const desc = description.trim().slice(0, limits.chars);
    const { id } = this.rows<{ id: number }>(
      `INSERT INTO lists (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)
       RETURNING id`,
      clean,
      desc,
      now,
      now
    )[0];
    return { id, name: clean, description: desc, items: 0, updated_at: now };
  }

  /** Append entries in order. All or none: a batch that would pass the limit adds nothing. */
  add(name: string, texts: string[], limits: ListLimits): ListItem[] {
    this.ensureSchema();
    const list = this.find(name);
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    if (clean.length === 0) throw new Error("nothing to add");
    const long = clean.find((t) => t.length > limits.chars);
    if (long) throw new Error(`an entry may be at most ${limits.chars} characters`);
    const count = this.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?`,
      list.id
    )[0].n;
    if (count + clean.length > limits.items) {
      throw new Error(
        `"${list.name}" would pass the ${limits.items} entry limit (it holds ${count})`
      );
    }
    const now = Date.now();
    const added = this.ctx.storage.transactionSync(() =>
      clean.map(
        (text) =>
          this.rows<ListItem>(
            `INSERT INTO list_items (list_id, text, created_at) VALUES (?, ?, ?)
             RETURNING id, text`,
            list.id,
            text,
            now
          )[0]
      )
    );
    this.touch(list.id);
    return added;
  }

  edit(name: string, itemId: number, text: string, limits: ListLimits): ListItem {
    this.ensureSchema();
    const list = this.find(name);
    const clean = text.trim();
    if (!clean) throw new Error("an entry cannot be empty; remove it instead");
    if (clean.length > limits.chars) {
      throw new Error(`an entry may be at most ${limits.chars} characters`);
    }
    const row = this.rows<ListItem>(
      `UPDATE list_items SET text = ? WHERE id = ? AND list_id = ? RETURNING id, text`,
      clean,
      itemId,
      list.id
    )[0];
    if (!row) throw new Error(`"${list.name}" has no entry #${itemId}`);
    this.touch(list.id);
    return row;
  }

  /** Remove entries by id; returns how many went. Ids not on the list are ignored. */
  remove(name: string, itemIds: number[]): number {
    this.ensureSchema();
    const list = this.find(name);
    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      for (const id of itemIds) {
        removed += this.rows(
          `DELETE FROM list_items WHERE id = ? AND list_id = ? RETURNING id`,
          id,
          list.id
        ).length;
      }
    });
    if (removed > 0) this.touch(list.id);
    return removed;
  }

  /** Delete a list and every entry on it; returns its name as stored. */
  drop(name: string): string {
    this.ensureSchema();
    const list = this.find(name);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM list_items WHERE list_id = ?`, list.id);
      this.ctx.storage.sql.exec(`DELETE FROM lists WHERE id = ?`, list.id);
    });
    return list.name;
  }
}
