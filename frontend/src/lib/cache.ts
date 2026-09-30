"use client";

/**
 * What the pages last read, kept for as long as the tab is open.
 *
 * Every page here is a client component that reads its data on mount, so leaving one
 * and coming back used to start from nothing: an empty sidebar, a "Loading…", a
 * session closed that was open a second ago. Each page now draws what this holds at
 * once and reads again behind it — the network decides whether anything changes, not
 * whether anything shows.
 *
 * Module state, not React state: it has to outlive the components that fill it. It is
 * never persisted, so a reload, a sign-out or another tab starts clean.
 */
const store = new Map<string, unknown>();

/** Whose reads the store holds. */
let owner = "";

/**
 * Say who is reading. A different address from the last one empties the store, so
 * signing out or switching the back-door address never draws the previous account's
 * agents. Called while rendering, before anything is read from here.
 */
export function claim(email: string) {
  if (email === owner) return;
  store.clear();
  owner = email;
}

export function cached<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function remember<T>(key: string, value: T): T {
  store.set(key, value);
  return value;
}

/** Update a held value in place. Nothing happens when nothing is held. */
export function revise<T>(key: string, change: (value: T) => T) {
  if (store.has(key)) store.set(key, change(store.get(key) as T));
}

export function forget(key: string) {
  store.delete(key);
}

/** Keys, so the pages sharing a payload agree on its name. */
export const keys = {
  agents: "agents",
  /** `/api/agents/:id/config` — read by the chat, capabilities and settings pages. */
  config: (agentId: string) => `config:${agentId}`,
  sessions: (agentId: string) => `sessions:${agentId}`,
  /** The session that was open, so coming back lands on it rather than the welcome. */
  selected: (agentId: string) => `selected:${agentId}`,
  transcript: (sessionId: string) => `transcript:${sessionId}`,
  summary: (sessionId: string) => `summary:${sessionId}`,
};
