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
 * The list of agents, in one well-known Durable Object.
 *
 * Same reason the session index exists: a Durable Object namespace can be addressed
 * by name but not enumerated, so "which agents exist" has to be written down
 * somewhere. This holds names only — everything an agent *is* lives in its own
 * `SessionRegistry`, which is why deleting an agent is two steps, not one.
 */

export class AgentDirectory extends DurableObject {
  private ready = false;

  /**
   * The deployment-wide directory tables. Ladder in `AGENT_DIRECTORY_MIGRATIONS`.
   *
   * `migrate()` still runs after it, and still keeps its own `schema_version` row: it
   * guards a data backfill that predates this ladder, and renumbering it against the
   * ladder's version would mean deciding what an already-written `1` meant. Leaving
   * the two counters separate costs one extra table and no ambiguity.
   */
  private ensureSchema() {
    if (this.ready) return;
    applyMigrations(this.ctx, AGENT_DIRECTORY_MIGRATIONS);
    migrateMembership(this.ctx.storage);
    this.ready = true;
  }

  /**
   * Every agent, or — given an email — only the ones that address may open.
   *
   * Two ways onto the list, and both are an index lookup: the address administers the
   * agent, or it is one of the agent's members. An admin sees the agent they made
   * whether or not they are also on its access list — administering one you cannot
   * open is the ordinary case now that the two are separate.
   *
   * The match is exact on both sides. Addresses are stored already lowercased and
   * trimmed, by `normalizeEmails` on the way in, so there is nothing to normalize
   * here beyond the address being asked about.
   */
  list(email?: string): AgentRow[] {
    this.ensureSchema();
    return listAgents(this.ctx.storage, email);
  }

  /**
   * One page of the agents `email` sees on the home page, excluding the agents
   * inside fleets it administers.
   *
   * Those are left out because a fleet is read as a fleet: it is listed once, by
   * name and size, and its agents are only fetched when it is opened. Pouring a
   * thousand of them into this page would push everything else off the end of a
   * list that is meant to be a handful of doors.
   *
   * What is never left out is an agent you are a *member* of, fleet or not. To its
   * member it is simply their agent — the fleet is how it is administered, which is
   * a different matter — and an agent somebody has to go looking for inside a
   * collapsed fleet is one they will assume was never made. That includes a fleet
   * you administer yourself and put your own address in: it shows up here as yours,
   * and again inside the fleet as one of its agents, because it is both.
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

  /**
   * The fleets `email` administers, each with the number of agents in it.
   *
   * Not paged. A fleet is one create call, so this is a list of decisions somebody
   * made by hand — tens of rows where the agents under them are thousands — and it
   * is the counts, not the agents, that this page is built from.
   */
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
   * `adminEmail` is the address that made the agent. It is the only time it is ever
   * written: there is no route that changes it, because an agent whose administrator
   * can be handed over is one that can be taken.
   *
   * It falls back to the first address on the access list, which is what an unguarded
   * deployment — where there is no signed-in caller to name — has to go on.
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

  /**
   * Replace the access list. The caller keeps their own address on it: a user who
   * could edit themselves out would lock everyone, themselves included, out of an
   * agent that only they could have unlocked. The admin is untouched either way —
   * it is not part of this list and is never rewritten.
   */
  setAllowedEmails(id: string, allowedEmails: string) {
    this.ensureSchema();
    return setAllowedEmails(this.ctx.storage, id, allowedEmails);
  }

  rename(id: string, name: string) {
    this.ensureSchema();
    return renameAgent(this.ctx.storage, id, name);
  }

  /**
   * Note that an agent was used, at most once every `TOUCH_INTERVAL`.
   *
   * This runs on every message, and it is the only *write* the hot path makes to the
   * directory — one object, one thread, for the whole deployment. A row write is also
   * about a thousand times the cost of a row read, so skipping the ones that would
   * change nothing anybody can see is the cheapest win available here.
   *
   * Nothing is lost by coarsening it. `list()` orders agents by `created_at`, so this
   * column decides no ordering at all; it is the "last used" date the home page
   * shows, and a few minutes of lag in a date is invisible. Session ordering is a
   * different column in a different object — `SessionRegistry.touch` — and is left
   * exact, because the sidebar really does reorder on it after every turn.
   */
  touch(id: string) {
    this.ensureSchema();
    return touchAgent(this.ctx.storage, id);
  }

  /**
   * The deployment's own knobs, complete — or `SettingsIncompleteError` naming what
   * is not set yet. There are no shipped values to fill a gap with; see `settings.ts`.
   *
   * Every other object reads this through `deploymentSettings` in `settings.ts`,
   * which caches it per isolate — this method is one RPC hop and gets called on paths
   * that run per turn.
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
   * Merge a patch into the stored document and return it, with what is still unset.
   *
   * Validation happens here rather than in the route so the stored document cannot be
   * made invalid by any caller, and so the merge and the cross-field checks
   * (`message_page` against `max_message_page`) see the same state.
   *
   * A rejection comes back as `{ error }` rather than as a throw. A thrown
   * `SettingsError` crossing a Durable Object RPC boundary arrives at the Worker as a
   * plain `Error`, so the route could not tell a value it should answer 400 for from a
   * failure it should answer 500 for — and answering 500 to "that number is too big"
   * is the difference between a dialog that can be corrected and one that looks broken.
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
   * How many agents `email` may administer — itself included.
   *
   * The deployment's `default_agent_limit` unless the owner has raised this one
   * account, which is what `account_limits` holds: absence is the ordinary case.
   */
  getAgentLimit(email: string): number {
    this.ensureSchema();
    return getAgentLimit(this.ctx.storage, email);
  }

  /**
   * Set how many agents `email` may administer. This is what "business account" is:
   * there is no separate flag, only a raised ceiling — a row here at all is the mark
   * of one. Only ever called from the owner's own admin route.
   */
  setAgentLimit(email: string, limit: number) {
    this.ensureSchema();
    return setAgentLimit(this.ctx.storage, email, limit);
  }

  /** How many agents `email` currently administers — the count `getAgentLimit` bounds. */
  countByAdmin(email: string): number {
    this.ensureSchema();
    return countByAdmin(this.ctx.storage, email);
  }

  /**
   * The whole admin dashboard in one query: how many accounts, agents and sessions
   * the deployment holds. Sessions come from the cached per-agent counter rather
   * than from the session registries, which is what keeps this to a single read.
   */
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
   * One page of every address the deployment knows — each admin and each member — in
   * email order, narrowed to those containing `query` when there is one. Admin CLI only.
   *
   * `cursor` is the last email of the previous page: the list is keyed on the address
   * itself, so a user added mid-scroll cannot make a page skip or repeat a row.
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
   * One page of open requests, oldest first, each carrying what the owner needs to
   * decide: the limit it would raise and how many agents that account already runs.
   *
   * Paged rather than returned whole because the queue has no ceiling — anyone signed
   * in can file one. `cursor` is keyset on `created_at`, with `id` breaking ties, so a
   * request filed mid-scroll cannot make the page skip or repeat a row.
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
   * Grant a request: fold its increase into the account's limit, then remove it from
   * the queue. Undefined when the request is already gone — resolved, or raced by a
   * second click — so the route can tell the caller nothing happened.
   */
  approveBusinessRequest(id: string): { email: string; agent_limit: number } | undefined {
    this.ensureSchema();
    return approveBusinessRequest(this.ctx.storage, id);
  }
}
