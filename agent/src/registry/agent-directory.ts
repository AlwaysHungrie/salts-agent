import { DurableObject } from "cloudflare:workers";
import { applyMigrations } from "../schema";
import type { DeploymentSettings, StoredSettings } from "../settings";
import {
  approveBusinessRequest,
  deleteBusinessRequest,
  fileBusinessRequest,
  listBusinessRequests,
} from "./business-requests";
import {
  agentLimits,
  businessAccounts,
  countByAdmin,
  counts,
  distinctUsers,
  getAgentLimit,
  listUsers,
  setAgentLimit,
  setSessionCount,
  unmeasuredAgents,
  userDetail,
} from "./directory-accounts";
import {
  createAgent,
  getAgent,
  removeAgent,
  renameAgent,
  setAgentGuests,
  setAllowedEmails,
  touchAgent,
} from "./directory-agents";
import {
  fleetMeta,
  listAgents,
  listFleetPage,
  listFleets,
  listGuestPage,
  listPage,
  removeFleetMeta,
  setFleetMeta,
} from "./directory-listing";
import { AGENT_DIRECTORY_MIGRATIONS, migrateMembership } from "./directory-schema";
import {
  clearSettings,
  directorySettings,
  setSettings,
  storedSettings,
} from "./directory-settings";
import type {
  AgentPage,
  AgentRow,
  BusinessRequest,
  BusinessRequestPage,
  FleetRow,
  MetadataFilter,
  UserDetail,
  UserPage,
} from "./types";

/**
 * The index of agents, in one well-known Durable Object (namespaces cannot be
 * enumerated). Everything an agent holds lives in its own `SessionRegistry`.
 */

export class AgentDirectory extends DurableObject {
  private ready = false;

  /**
   * The directory's tables. `migrateMembership` keeps its own `schema_version` for a
   * backfill that predates the ladder.
   */
  private ensureSchema() {
    if (this.ready) return;
    applyMigrations(this.ctx, AGENT_DIRECTORY_MIGRATIONS);
    migrateMembership(this.ctx.storage);
    this.ready = true;
  }

  /** Every agent, or those `email` administers or is a member of (two indexed lookups). */
  list(email?: string): AgentRow[] {
    this.ensureSchema();
    return listAgents(this.ctx.storage, email);
  }

  /**
   * One home-page page of agents `email` sees: those it administers outside its fleets,
   * plus every agent it is a member of, fleet or not (fleets are listed separately).
   */
  listPage(email: string, limit = 0, cursor = "", filter?: MetadataFilter): AgentPage {
    this.ensureSchema();
    return listPage(this.ctx.storage, email, limit, cursor, filter);
  }

  /**
   * One page of the agents `email` may message as a guest: guests switched on, and
   * either no guest list (anyone signed in) or `email` on it.
   */
  listGuestPage(email: string, limit = 0, cursor = "", filter?: MetadataFilter): AgentPage {
    this.ensureSchema();
    return listGuestPage(this.ctx.storage, email, limit, cursor, filter);
  }

  /** Mirror an agent's guest switch and list, as the registry holds them. */
  setGuests(id: string, guests: number, guestEmails: string) {
    this.ensureSchema();
    return setAgentGuests(this.ctx.storage, id, guests, guestEmails);
  }

  /** Fleets `email` administers, with agent counts. Not paged: tens of rows at most. */
  listFleets(email: string): FleetRow[] {
    this.ensureSchema();
    return listFleets(this.ctx.storage, email);
  }

  /** One page of the agents inside a fleet, oldest first — the order they were made in. */
  listFleetPage(fleetId: string, limit = 0, cursor = ""): AgentPage {
    this.ensureSchema();
    return listFleetPage(this.ctx.storage, fleetId, limit, cursor);
  }

  /**
   * The settings a fleet was created with, and that agents added to it are created
   * holding. Null when the fleet was never given any.
   */
  fleetMeta(fleetId: string): string {
    this.ensureSchema();
    return fleetMeta(this.ctx.storage, fleetId);
  }

  /** Write the fleet's settings. The document is stored whole, as the dialog sends it. */
  setFleetMeta(fleetId: string, json: string): void {
    this.ensureSchema();
    return setFleetMeta(this.ctx.storage, fleetId, json);
  }

  /** Forget a fleet's settings, once the last of its agents is gone. */
  removeFleetMeta(fleetId: string): void {
    this.ensureSchema();
    return removeFleetMeta(this.ctx.storage, fleetId);
  }

  get(id: string): AgentRow | undefined {
    this.ensureSchema();
    return getAgent(this.ctx.storage, id);
  }

  /**
   * Create an agent. `adminEmail` is written only here and never changes, falling back to
   * the first listed address when no caller is known.
   */
  create(
    id: string,
    name: string,
    allowedEmails: string,
    adminEmail: string,
    fleet?: { id: string; name: string },
    metadata: Record<string, string> = {}
  ): AgentRow {
    this.ensureSchema();
    return createAgent(this.ctx.storage, id, name, allowedEmails, adminEmail, fleet, metadata);
  }

  /** Replace the access list; the admin is separate and untouched. */
  setAllowedEmails(id: string, allowedEmails: string) {
    this.ensureSchema();
    return setAllowedEmails(this.ctx.storage, id, allowedEmails);
  }

  rename(id: string, name: string) {
    this.ensureSchema();
    return renameAgent(this.ctx.storage, id, name);
  }

  /**
   * Record that an agent was used, at most every `TOUCH_INTERVAL`: this is the only hot-path
   * write to the single directory object, and it only feeds a "last used" date.
   */
  touch(id: string) {
    this.ensureSchema();
    return touchAgent(this.ctx.storage, id);
  }

  /**
   * The deployment settings, complete, or `SettingsIncompleteError`. Other objects read
   * them through the cached `deploymentSettings`.
   */
  settings(): DeploymentSettings {
    this.ensureSchema();
    return directorySettings(this.ctx.storage);
  }

  /** The document as stored, complete or not. What the admin CLI reads and edits. */
  storedSettings(): StoredSettings {
    this.ensureSchema();
    return storedSettings(this.ctx.storage);
  }

  /**
   * Validate and merge a settings patch. A rejection is returned as `{ error }`, not
   * thrown: a thrown error crosses RPC as a plain `Error` and the route could not answer 400.
   */
  setSettings(patch: unknown): { settings: StoredSettings; missing: string[] } | { error: string } {
    this.ensureSchema();
    return setSettings(this.ctx.storage, patch);
  }

  /**
   * Drop the stored document. Not routed: with nothing to fall back to, this leaves
   * the deployment refusing every request, so it is for tests of exactly that.
   */
  clearSettings(): void {
    this.ensureSchema();
    return clearSettings(this.ctx.storage);
  }

  /**
   * How many agents `email` may administer: its `account_limits` row, else the
   * deployment's `default_agent_limit`.
   */
  getAgentLimit(email: string): number {
    this.ensureSchema();
    return getAgentLimit(this.ctx.storage, email);
  }

  /** Set `email`'s agent ceiling. A business account is just a row here; owner route only. */
  setAgentLimit(email: string, limit: number) {
    this.ensureSchema();
    return setAgentLimit(this.ctx.storage, email, limit);
  }

  /** How many agents `email` currently administers — the count `getAgentLimit` bounds. */
  countByAdmin(email: string): number {
    this.ensureSchema();
    return countByAdmin(this.ctx.storage, email);
  }

  /** Deployment-wide counts in one query; sessions come from the cached per-agent counter. */
  counts(): {
    users: number;
    agents: number;
    sessions: number;
    business_accounts: number;
    open_requests: number;
  } {
    this.ensureSchema();
    return counts(this.ctx.storage);
  }

  /**
   * A page of every known address (admins and members) in email order, optionally filtered.
   * The cursor is the last email, so additions mid-scroll cannot skip or repeat rows.
   */
  listUsers(limit = 20, cursor = "", query = ""): UserPage {
    this.ensureSchema();
    return listUsers(this.ctx.storage, limit, cursor, query);
  }

  /**
   * One address's view for the admin CLI: its agent limit, and every agent it
   * administers or may open, with that agent's session count.
   */
  userDetail(email: string): UserDetail {
    this.ensureSchema();
    return userDetail(this.ctx.storage, email);
  }

  /** Agents whose session count has never been measured — the backfill `counts()` needs. */
  unmeasuredAgents(): string[] {
    this.ensureSchema();
    return unmeasuredAgents(this.ctx.storage);
  }

  /** Record how many sessions an agent has, after one was created, forked or deleted. */
  setSessionCount(id: string, count: number) {
    this.ensureSchema();
    return setSessionCount(this.ctx.storage, id, count);
  }

  /** Every address that administers or may open at least one agent. Admin stats only. */
  distinctUsers(): number {
    this.ensureSchema();
    return distinctUsers(this.ctx.storage);
  }

  /** How many accounts have a raised agent limit — the deployment's business accounts. */
  businessAccounts(): number {
    this.ensureSchema();
    return businessAccounts(this.ctx.storage);
  }

  /** Every agent's admin's raised limit, keyed by email — for the stats route to join against `list()`. */
  agentLimits(): Record<string, number> {
    this.ensureSchema();
    return agentLimits(this.ctx.storage);
  }

  remove(id: string) {
    this.ensureSchema();
    return removeAgent(this.ctx.storage, id);
  }

  /** File a request to raise `email`'s agent limit by `increase`. Returns the queued row. */
  fileBusinessRequest(email: string, increase: number): BusinessRequest {
    this.ensureSchema();
    return fileBusinessRequest(this.ctx.storage, email, increase);
  }

  /**
   * A page of open requests, oldest first, with each account's current limit and agent
   * count. Keyset cursor on `created_at:id`.
   */
  listBusinessRequests(limit = 20, cursor = ""): BusinessRequestPage {
    this.ensureSchema();
    return listBusinessRequests(this.ctx.storage, limit, cursor);
  }

  /** Drop a request without acting on it — the owner declined it. */
  deleteBusinessRequest(id: string) {
    this.ensureSchema();
    return deleteBusinessRequest(this.ctx.storage, id);
  }

  /**
   * Grant a request: add its increase to the account's limit and dequeue it. Undefined
   * when it is already gone (resolved, or a double click).
   */
  approveBusinessRequest(id: string): { email: string; agent_limit: number } | undefined {
    this.ensureSchema();
    return approveBusinessRequest(this.ctx.storage, id);
  }
}
