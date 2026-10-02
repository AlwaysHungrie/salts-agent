import { DurableObject } from "cloudflare:workers";
import type { McpServerRow } from "../mcp";
import { applyMigrations } from "../schema";
import type { SettableConfigKey } from "../settings";
import { readAccess, seedAccess, setAccess, setGuestAccess } from "./access";
import {
  type ApiKeyInfo,
  type ApiKeyRole,
  apiKeyHash,
  listApiKeys,
  removeApiKey,
  setApiKey,
} from "./api-keys";
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

  /** Apply this agent's migration ladder once per object lifetime. */
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
   * The server's access token, refreshed if spent. Refreshes are shared per server, since a
   * rotating provider honours only the first of two concurrent ones. `force` follows a 401.
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
   * Who may open this agent and who administers it: the authority for every access check
   * (the directory is only an index). `seeded` = 0 means not yet copied from the directory.
   */
  access(): AccessRow {
    this.ensureSchema();
    return readAccess(this.ctx.storage);
  }

  /**
   * Write the access list, and the admin only if none is set: an admin can never be
   * reassigned. Marks the row seeded.
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

  /** Which API keys exist, without the keys. */
  apiKeys(): ApiKeyInfo[] {
    this.ensureSchema();
    return listApiKeys(this.ctx.storage);
  }

  /** The stored hash of the role's key, or "" when it has none. Only the Worker calls this. */
  apiKeyHash(role: ApiKeyRole): string {
    this.ensureSchema();
    return apiKeyHash(this.ctx.storage, role);
  }

  setApiKey(role: ApiKeyRole, hash: string, hint: string): ApiKeyInfo {
    this.ensureSchema();
    return setApiKey(this.ctx.storage, role, hash, hint);
  }

  removeApiKey(role: ApiKeyRole): void {
    this.ensureSchema();
    return removeApiKey(this.ctx.storage, role);
  }

  /**
   * Copy the directory's list once for an unseeded agent; never overwrites. No `await`, so
   * concurrent callers are serialised by the object and the second sees `seeded = 1`.
   */
  seedAccess(allowedEmails: string, adminEmail: string): AccessRow {
    this.ensureSchema();
    return seedAccess(this.ctx.storage, allowedEmails, adminEmail);
  }

  /**
   * Move the agent's byte total. It can drift if a session dies mid-report, but it only
   * caps uploads and is clamped at zero.
   */
  addStorageBytes(delta: number): void {
    this.ensureSchema();
    return addStorageBytes(this.ctx.storage, delta);
  }

  /** Bytes held and the ceiling, which callers pass from the cached deployment settings. */
  storageState(limit: number): { bytes: number; limit: number } {
    this.ensureSchema();
    return storageState(this.ctx.storage, limit);
  }

  /** How many more bytes this agent may take. Never negative. */
  storageRoom(limit: number): number {
    this.ensureSchema();
    return storageRoom(this.ctx.storage, limit);
  }

  /** Add a finished turn's cost (failed turns still spent tokens) to this month. */
  addSpend(usd: number): void {
    this.ensureSchema();
    return addSpend(this.ctx.storage, usd);
  }

  /** What this agent has spent in the current calendar month, in US dollars. */
  spendThisMonth(): number {
    this.ensureSchema();
    return spendThisMonth(this.ctx.storage);
  }

  /** This month's spend and its ceiling (0 = none), for the turn gate and the dialog. */
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
   * The settings row, seeded on first read from `defaultModel` and `config_defaults`.
   * Defaults only seed; `MetaSettings.locked` is what holds a setting in place.
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

  /** The session a Telegram chat (and topic) already maps to, if any. */
  forChat(chatId: string, threadId = ""): SessionRow | undefined {
    this.ensureSchema();
    return forChat(this.ctx.storage, chatId, threadId);
  }

  /**
   * A free session id for a chat: its own id, or a `-gN` generation when `!new` left the
   * old session under that name. Shared with `!new` so tasks land where messages will.
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
   * Claim a WhatsApp delivery: true the first time, false for repeats of the `wamid`.
   * The object serialises requests, so concurrent duplicates cannot both pass.
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

  /** Detach a session from its chat; the next message there starts a new session. */
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

  /** Memories span the agent's sessions, never other agents. */
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

  /** Drop all of this agent's storage (called on agent delete, after its sessions). */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
}
