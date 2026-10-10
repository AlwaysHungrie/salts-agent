// The agents one salts-tools install serves. Every one gets every service's address,
// and each must hold the same token in its SearXNG token field.

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
