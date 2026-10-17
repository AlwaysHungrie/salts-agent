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
import {
  approvePairing,
  type ComputerLink,
  type ComputerRow,
  computer,
  computersOf,
  linksOf,
  linksOfAgent,
  markSynced,
  type PairingPoll,
  pairing,
  pollPairing,
  removeComputer,
  removeLink,
  reportComputer,
  setLink,
  startPairing,
} from "./directory-computers";
import { AGENT_DIRECTORY_MIGRATIONS, migrateMembership } from "./directory-schema";
import {
  claimPurchase,
  createPurchase,
  deploymentValue,
  fulfilNewKey,
  markPurchasePaid,
  purchase,
  releasePurchase,
  setDeploymentValue,
  txCounted,
} from "./wallet-purchases";
import {
  addWalletKey,
  removeWalletKey,
  setWalletKeyUse,
  walletKey,
  walletKeys,
} from "./wallet";
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
  WalletKeyKind,
  WalletKeyRow,
  WalletPurchase,
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
    this.ctx.storage.sql.exec(`DELETE FROM salts_links WHERE agent_id = ?`, id);
    setWalletKeyUse(this.ctx.storage, id, "");
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

  // ─── OpenRouter wallet (see wallet.ts) ──────────────────────────────────────────

  /** Every key in `email`'s wallet, secrets included: the routes decide what is shown. */
  walletKeys(email: string): WalletKeyRow[] {
    this.ensureSchema();
    return walletKeys(this.ctx.storage, email);
  }

  /** One of `email`'s keys; undefined when it is someone else's. */
  walletKey(email: string, id: string): WalletKeyRow | undefined {
    this.ensureSchema();
    return walletKey(this.ctx.storage, email, id);
  }

  addWalletKey(
    email: string,
    key: { kind: WalletKeyKind; secret: string; openrouter_hash?: string },
    max: number
  ): WalletKeyRow | { error: string } {
    this.ensureSchema();
    return addWalletKey(this.ctx.storage, email, key, max);
  }

  /** Remove a key; the agents that held it are returned for the caller to clear. */
  removeWalletKey(email: string, id: string): string[] | undefined {
    this.ensureSchema();
    return removeWalletKey(this.ctx.storage, email, id);
  }

  setWalletKeyUse(agentId: string, keyId: string) {
    this.ensureSchema();
    return setWalletKeyUse(this.ctx.storage, agentId, keyId);
  }

  /** Record a quote; `{ error }` when its amount clashes with another open one. */
  createPurchase(p: Omit<WalletPurchase, "id" | "status" | "tx" | "claimed_at">): WalletPurchase | { error: string } {
    this.ensureSchema();
    return createPurchase(this.ctx.storage, p);
  }

  purchase(email: string, id: string): WalletPurchase | undefined {
    this.ensureSchema();
    return purchase(this.ctx.storage, email, id);
  }

  txCounted(tx: string): boolean {
    this.ensureSchema();
    return txCounted(this.ctx.storage, tx);
  }

  /** Count a verified payment once: false when `tx` already paid for something. */
  markPurchasePaid(id: string, tx: string): boolean {
    this.ensureSchema();
    return markPurchasePaid(this.ctx.storage, id, tx);
  }

  /** Take up a paid purchase for delivery: false while another confirm holds it. */
  claimPurchase(id: string): boolean {
    this.ensureSchema();
    return claimPurchase(this.ctx.storage, id, Date.now());
  }

  releasePurchase(id: string) {
    this.ensureSchema();
    releasePurchase(this.ctx.storage, id);
  }

  /** Deliver a paid purchase as a new key; undefined when it is not waiting for one. */
  fulfilNewKey(id: string, key: { secret: string; openrouter_hash: string }): WalletKeyRow | undefined {
    this.ensureSchema();
    return fulfilNewKey(this.ctx.storage, id, key);
  }

  /** The OpenRouter provisioning key bought keys are made with; "" when not set. */
  provisioningKey(): string {
    this.ensureSchema();
    return deploymentValue(this.ctx.storage, "openrouter_provisioning_key");
  }

  setProvisioningKey(value: string) {
    this.ensureSchema();
    setDeploymentValue(this.ctx.storage, "openrouter_provisioning_key", value);
  }

  /** Where purchases are paid to, per family; "" where none is set. */
  paymentAddresses(): { evm: string; solana: string } {
    this.ensureSchema();
    return {
      evm: deploymentValue(this.ctx.storage, "payment_address_evm"),
      solana: deploymentValue(this.ctx.storage, "payment_address_solana"),
    };
  }

  /** Set one family's payment address; blank switches that family off. */
  setPaymentAddress(family: "evm" | "solana", value: string) {
    this.ensureSchema();
    setDeploymentValue(this.ctx.storage, `payment_address_${family}`, value);
  }

  // ─── salts-tools computers (see directory-computers.ts) ─────────────────────────

  startPairing(p: Parameters<typeof startPairing>[1]): boolean {
    this.ensureSchema();
    return startPairing(this.ctx.storage, p);
  }

  pairing(userCode: string, now: number): { name: string; approved: boolean } | undefined {
    this.ensureSchema();
    return pairing(this.ctx.storage, userCode, now);
  }

  approvePairing(userCode: string, now: number, c: Parameters<typeof approvePairing>[3]): boolean {
    this.ensureSchema();
    return approvePairing(this.ctx.storage, userCode, now, c);
  }

  pollPairing(deviceHash: string, now: number): PairingPoll {
    this.ensureSchema();
    return pollPairing(this.ctx.storage, deviceHash, now);
  }

  computer(id: string): ComputerRow | undefined {
    this.ensureSchema();
    return computer(this.ctx.storage, id);
  }

  computersOf(email: string): ComputerRow[] {
    this.ensureSchema();
    return computersOf(this.ctx.storage, email);
  }

  reportComputer(id: string, r: Parameters<typeof reportComputer>[2]) {
    this.ensureSchema();
    return reportComputer(this.ctx.storage, id, r);
  }

  computerLinks(computerId: string): ComputerLink[] {
    this.ensureSchema();
    return linksOf(this.ctx.storage, computerId);
  }

  agentComputerLinks(agentId: string): ComputerLink[] {
    this.ensureSchema();
    return linksOfAgent(this.ctx.storage, agentId);
  }

  setComputerLink(computerId: string, agentId: string, tools: string[]) {
    this.ensureSchema();
    return setLink(this.ctx.storage, computerId, agentId, tools);
  }

  markComputerLinkSynced(computerId: string, agentId: string, synced: string) {
    this.ensureSchema();
    return markSynced(this.ctx.storage, computerId, agentId, synced);
  }

  removeComputerLink(computerId: string, agentId: string) {
    this.ensureSchema();
    return removeLink(this.ctx.storage, computerId, agentId);
  }

  removeComputer(id: string) {
    this.ensureSchema();
    return removeComputer(this.ctx.storage, id);
  }
}
