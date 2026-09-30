import { DurableObject } from "cloudflare:workers";
import type { McpServerRow } from "../mcp";
import { applyMigrations } from "../schema";
import type { SettableConfigKey } from "../settings";
import { readAccess, seedAccess, setAccess, setGuestAccess } from "./access";
import { loadConfigRow, patchConfigRow, readMeta, writeMeta } from "./agent-config";
import {
  addMcpServer,
  getMcpServer,
  getMcpServerByState,
  listMcpServers,
  noteMcpError,
  performRefresh,
  removeMcpServer,
  updateMcpServer,
} from "./mcp-servers";
import { forget, recall, remember } from "./memories";
import { SESSION_REGISTRY_MIGRATIONS } from "./session-registry-schema";
import {
  claimWhatsappEvent,
  countSessions,
  createSession,
  detachChat,
  forChat,
  freeChatSessionId,
  getSession,
  listSessions,
  removeSession,
  renameSession,
  sessionCount,
  touchSession,
} from "./sessions";
import type { AccessRow, Config, Memory, MetaSettings, SessionPage, SessionRow } from "./types";
import {
  addSpend,
  addStorageBytes,
  spendState,
  spendThisMonth,
  storageRoom,
  storageState,
} from "./usage";

export class SessionRegistry extends DurableObject {
  private ready = false;
  /** Token refreshes in flight, by server id, so concurrent callers share one. */
  private refreshing = new Map<string, Promise<McpServerRow | undefined>>();

  /**
   * The agent's own tables. Ladder in `SESSION_REGISTRY_MIGRATIONS`; schema.ts says
   * why it is a ladder. One registry object per agent, so a new step lands on each
   * agent the first time that agent is touched after the deploy that added it.
   */
  private ensureSchema() {
    if (this.ready) return;
    applyMigrations(this.ctx, SESSION_REGISTRY_MIGRATIONS);
    this.ready = true;
  }

  /**
   * The external MCP servers, oldest first, credentials and all. Only the Worker
   * calls this: `server.ts` strips the secrets before anything reaches the browser.
   */
  mcpServers(): McpServerRow[] {
    this.ensureSchema();
    return listMcpServers(this.ctx.storage);
  }

  mcpServer(id: string): McpServerRow | undefined {
    this.ensureSchema();
    return getMcpServer(this.ctx.storage, id);
  }

  /** The server an in-flight OAuth callback belongs to, matched on its CSRF state. */
  mcpServerByState(state: string): McpServerRow | undefined {
    this.ensureSchema();
    return getMcpServerByState(this.ctx.storage, state);
  }

  addMcpServer(row: McpServerRow): McpServerRow {
    this.ensureSchema();
    return addMcpServer(this.ctx.storage, row);
  }

  /** A partial update: only the columns present are written. */
  updateMcpServer(id: string, patch: Partial<McpServerRow>): McpServerRow | undefined {
    this.ensureSchema();
    return updateMcpServer(this.ctx.storage, id, patch);
  }

  /**
   * The access token for a server, refreshed if it is spent.
   *
   * Refreshing lives here, in the one object that owns the row, because a turn can
   * call several of a server's tools at once and a provider that rotates refresh
   * tokens only honours the first of two concurrent refreshes. In-flight refreshes
   * are shared, so those callers wait on one request and all see the same result.
   *
   * `force` is for a call that has already been answered with a 401: the stored
   * expiry said the token was good, and the provider disagrees.
   */
  async refreshMcpToken(id: string, force = false): Promise<McpServerRow | undefined> {
    this.ensureSchema();
    const server = getMcpServer(this.ctx.storage, id);
    if (!server || server.auth !== "oauth" || !server.oauth_refresh_token) return server;

    const spent = server.oauth_expires_at > 0 && server.oauth_expires_at - Date.now() < 60_000;
    if (!force && !spent) return server;

    const existing = this.refreshing.get(id);
    if (existing) return await existing;

    const attempt = performRefresh(this.ctx.storage, server).finally(() =>
      this.refreshing.delete(id)
    );
    this.refreshing.set(id, attempt);
    return await attempt;
  }

  /** Notes what a failed call learned, so the card stops claiming the server works. */
  noteMcpError(id: string, message: string) {
    this.ensureSchema();
    return noteMcpError(this.ctx.storage, id, message);
  }

  removeMcpServer(id: string) {
    this.ensureSchema();
    return removeMcpServer(this.ctx.storage, id);
  }

  /**
   * Who may open this agent, and who administers it. **This is the authority.**
   *
   * Every access decision in the Worker is taken from here rather than from the
   * directory, because this object is one per agent and the directory is one for the
   * whole deployment: an access check that reads the directory puts every message
   * every user sends through a single thread in a single datacenter.
   *
   * `seeded` is what separates "this agent has no members" from "this agent has not
   * been asked yet". Agents created before access moved here have their list only in
   * the directory, and reading a missing row as an empty list would lock every one of
   * their users out the moment this deploys. So the unseeded state is explicit, and
   * the Worker answers it by seeding from the directory once — see `seedAccess`.
   */
  access(): AccessRow {
    this.ensureSchema();
    return readAccess(this.ctx.storage);
  }

  /**
   * Write the access list, and — only if it has never been written — the admin.
   *
   * `admin_email` is set once, at creation, and no route moves it: an agent whose
   * administrator can be handed over is one that can be taken. That rule is enforced
   * here rather than trusted to callers, so a `setAccess` carrying an admin for an
   * agent that already has one silently keeps the one it has.
   *
   * Writing anything at all marks the row seeded, so the directory is never consulted
   * for this agent again.
   */
  setAccess(patch: { allowed_emails?: string; admin_email?: string }): AccessRow {
    this.ensureSchema();
    return setAccess(this.ctx.storage, patch);
  }

  /**
   * Switch guests on or off and replace their list. Separate from `setAccess` because
   * it is a different decision, made by the admin rather than by any user.
   */
  setGuests(patch: { guests?: number; guest_emails?: string }): AccessRow {
    this.ensureSchema();
    return setGuestAccess(this.ctx.storage, patch);
  }

  /**
   * Adopt the directory's copy, once, for an agent that predates this table.
   *
   * Does nothing to an agent that has already been seeded, which is what makes it
   * safe for two requests to arrive at the same unseeded agent at once: the method
   * body has no `await` in it, so a Durable Object runs it to completion before the
   * second caller starts, and the second caller then finds `seeded = 1` and reads
   * what the first one wrote. They would be writing identical rows in any case — both
   * read the same directory row — so the race is benign even where it is visible.
   *
   * It is deliberately not `setAccess`: this may only ever *fill in* an agent nobody
   * has written access for, never overwrite a decision already recorded here.
   */
  seedAccess(allowedEmails: string, adminEmail: string): AccessRow {
    this.ensureSchema();
    return seedAccess(this.ctx.storage, allowedEmails, adminEmail);
  }

  /**
   * Move the agent's byte total, up on an upload and down when files go.
   *
   * A running total, so it can drift from the truth if a session dies between
   * writing a file and reporting it. It is clamped at zero and it is only ever a
   * ceiling on uploads, so drift costs somebody a few megabytes of headroom rather
   * than losing their files.
   */
  addStorageBytes(delta: number): void {
    this.ensureSchema();
    return addStorageBytes(this.ctx.storage, delta);
  }

  /**
   * What the agent is holding, and the ceiling it is held against.
   *
   * The ceiling is passed in for the same reason `config` takes the default model: an
   * agent's registry is not the object that decides deployment-wide numbers, and a
   * cross-object read on every upload would be an RPC hop per file. Callers get it
   * from `deploymentSettings(env)`, which caches it.
   */
  storageState(limit: number): { bytes: number; limit: number } {
    this.ensureSchema();
    return storageState(this.ctx.storage, limit);
  }

  /** How many more bytes this agent may take. Never negative. */
  storageRoom(limit: number): number {
    this.ensureSchema();
    return storageRoom(this.ctx.storage, limit);
  }

  /**
   * Bank what a turn cost against this month.
   *
   * Called by the session that spent it, after the turn is over — the cost is only
   * known once OpenRouter has answered, and a turn that failed still spent whatever
   * tokens it generated.
   */
  addSpend(usd: number): void {
    this.ensureSchema();
    return addSpend(this.ctx.storage, usd);
  }

  /** What this agent has spent in the current calendar month, in US dollars. */
  spendThisMonth(): number {
    this.ensureSchema();
    return spendThisMonth(this.ctx.storage);
  }

  /**
   * This month's spend and the ceiling it is measured against, in one read.
   *
   * One call because both halves are wanted at the same moments and by the same
   * callers: the gate in front of every turn, and the dialog that shows where the
   * agent stands. `limit` of 0 means there is no ceiling.
   */
  spendState(): { usd: number; limit: number; month: string } {
    this.ensureSchema();
    return spendState(this.ctx.storage);
  }

  /** The agent's defaults, or the empty set when nobody has set any. */
  meta(): MetaSettings {
    this.ensureSchema();
    return readMeta(this.ctx.storage);
  }

  /** Replaces the whole document: the dialog always sends the settings entire. */
  setMeta(next: MetaSettings): MetaSettings {
    this.ensureSchema();
    return writeMeta(this.ctx.storage, next);
  }

  /**
   * Reads the settings row, seeding it from the deployment's defaults on first use.
   *
   * `seed` is the deployment's `config_defaults`, applied over the factory values and
   * only ever on the first read — an agent that already has a row keeps what it has,
   * because a default is where a setting starts, not what it is held to. Locking a
   * setting so the agent cannot move it is what `MetaSettings.locked` is for.
   */
  config(defaultModel: string, seed: Pick<Config, SettableConfigKey>): Config {
    this.ensureSchema();
    return loadConfigRow(this.ctx.storage, defaultModel, seed);
  }

  setConfig(
    patch: Partial<Config>,
    defaultModel: string,
    seed: Pick<Config, SettableConfigKey>
  ): Config {
    this.ensureSchema();
    return patchConfigRow(this.ctx.storage, patch, defaultModel, seed);
  }

  /** How many sessions this agent has. Admin stats only — the hot path pages instead. */
  sessionCount(): number {
    this.ensureSchema();
    return sessionCount(this.ctx.storage);
  }

  /** `owner`, when given, narrows the page to the sessions that address started. */
  list(limit: number, cursor = "", owner = ""): SessionPage {
    this.ensureSchema();
    return listSessions(this.ctx.storage, limit, cursor, owner);
  }

  /** How many sessions this agent holds. What `max_sessions` is measured against. */
  countSessions(): number {
    this.ensureSchema();
    return countSessions(this.ctx.storage);
  }

  create(
    id: string,
    title: string,
    objectId: string,
    origin: Pick<
      SessionRow,
      "source" | "chat_id" | "chat_type" | "chat_username" | "chat_thread_id"
    > = {
      source: "web",
      chat_id: "",
      chat_type: "",
      chat_username: "",
      chat_thread_id: "",
    },
    /** The deployment's `max_sessions`, passed in by the caller. See `storageState`. */
    maxSessions: number,
    /** Who started it on the web. Written once; an update keeps the first owner. */
    owner = ""
  ): SessionRow {
    this.ensureSchema();
    return createSession(this.ctx.storage, id, title, objectId, origin, maxSessions, owner);
  }

  /**
   * The session a Telegram conversation maps to, if it has one already. A topic is its
   * own conversation, so the thread is matched too — a group's own session (thread '')
   * never answers for a topic inside it.
   */
  forChat(chatId: string, threadId = ""): SessionRow | undefined {
    this.ensureSchema();
    return forChat(this.ctx.storage, chatId, threadId);
  }

  /**
   * A session id for a chat that has none yet. Normally that is the chat's own id,
   * but `!new` leaves the previous session in place under exactly that name — so a
   * generation is appended until the name is free. Without this the "new" session
   * would be the old Durable Object again, which is the one thing it must not be.
   *
   * It lives here rather than at the webhook because `!new` needs the same answer:
   * the session it hands its scheduled tasks to has to be the one the next message
   * lands in.
   */
  freeChatSessionId(
    agentId: string,
    chatId: string,
    threadId = "",
    channel: "tg" | "wa" = "tg"
  ): string {
    this.ensureSchema();
    return freeChatSessionId(this.ctx.storage, agentId, chatId, threadId, channel);
  }

  /**
   * Claim one WhatsApp delivery, returning true the first time and false for every
   * repeat of the same `wamid`.
   *
   * A Durable Object handles one request at a time, so the read and the write cannot
   * interleave: two simultaneous deliveries of the same message are serialised here,
   * and exactly one of them is told to go on. That is the whole reason the check is
   * in the registry and not in the webhook's own code.
   */
  claimWhatsappEvent(id: string): boolean {
    this.ensureSchema();
    return claimWhatsappEvent(this.ctx.storage, id);
  }

  /** One session by id, or nothing. */
  get(id: string): SessionRow | undefined {
    this.ensureSchema();
    return getSession(this.ctx.storage, id);
  }

  /**
   * Cut a session loose from its Telegram chat without touching what it holds. The
   * chat stops resolving to it, so the next message there starts somewhere new, while
   * the conversation stays readable in the browser exactly as it was left.
   */
  detachChat(id: string) {
    this.ensureSchema();
    return detachChat(this.ctx.storage, id);
  }

  touch(id: string) {
    this.ensureSchema();
    return touchSession(this.ctx.storage, id);
  }

  rename(id: string, title: string) {
    this.ensureSchema();
    return renameSession(this.ctx.storage, id, title);
  }

  remove(id: string) {
    this.ensureSchema();
    return removeSession(this.ctx.storage, id);
  }

  /**
   * Memory spans the agent on purpose: a fact worth keeping ("I use pnpm") is worth
   * keeping in the agent's next session too, which is the whole point of remembering
   * it. It stops there — one agent never reads another's memories.
   */
  remember(text: string, sessionId: string): Memory {
    this.ensureSchema();
    return remember(this.ctx.storage, text, sessionId);
  }

  /**
   * Substring search, newest first. Small enough a table that scanning it beats
   * carrying an embedding model around; `query` empty returns the most recent.
   */
  recall(query: string, limit = 20): Memory[] {
    this.ensureSchema();
    return recall(this.ctx.storage, query, limit);
  }

  forget(id: number) {
    this.ensureSchema();
    return forget(this.ctx.storage, id);
  }

  /**
   * Drop everything this agent owns. Called when the agent itself is deleted, after
   * its sessions have been destroyed: a Durable Object is billed for the bytes it
   * holds, so an emptied-but-living registry still costs.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
}
