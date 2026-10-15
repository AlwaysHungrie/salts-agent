// The agents one salts-tools install serves. Each gets the address of every service it
// is set to (all of them unless chosen), and each must hold the same token in its
// SearXNG token field.

/** Agent ids typed at the setup prompt: space (or comma) separated, duplicates dropped. */
export function parseAgentIds(text) {
  return [...new Set(String(text).split(/[\s,]+/).filter(Boolean))];
}

/** The agent ids in a state file, including one written before there could be several. */
export function agentIdsOf(state) {
  if (Array.isArray(state?.agentIds)) return state.agentIds;
  return state?.agentId ? [state.agentId] : [];
}

/** "agent a" or "agents a, b", for log and terminal lines. */
export function agentsLabel(ids) {
  return `${ids.length === 1 ? "agent" : "agents"} ${ids.join(", ")}`;
}

/**
 * Whether this agent is sent this service's address. `agentServices[id]` lists the
 * services chosen for it; an agent with no list gets every service.
 */
export function servesAgent(state, id, name) {
  const chosen = state?.agentServices?.[id];
  return !Array.isArray(chosen) || chosen.includes(name);
}

/** The agents this service's address goes to. */
export function agentsFor(state, name) {
  return agentIdsOf(state).filter((id) => servesAgent(state, id, name));
}

/**
 * `agentServices` with `name` switched on or off for agent `id`. `all` is every service
 * there is, which an agent without a list of its own starts from.
 */
export function toggleService(state, id, name, all) {
  const chosen = state?.agentServices?.[id] ?? all;
  const next = chosen.includes(name) ? chosen.filter((n) => n !== name) : [...chosen, name];
  return { ...state?.agentServices, [id]: all.filter((n) => next.includes(n)) };
}
