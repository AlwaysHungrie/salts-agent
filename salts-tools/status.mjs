// What the dashboard says about each service and agent, worked out from state.json
// alone: the supervisor writes its progress there, and this reads it back.

/**
 * One service as `{ label, tone, note }`: a short word for its row, its colour
 * (good | busy | bad | off) and one line saying what is happening or what to do.
 * `running` is whether the supervisor is alive; `agents` the agent ids served.
 */
export function serviceStatus(state, name, running, agents) {
  const e = state.svc?.[name] ?? {};
  if (!running || !(state.services ?? []).includes(name)) return { label: "off", tone: "off", note: "" };
  if (e.error?.startsWith("push:")) {
    const agent = e.failedAgent;
    if (e.pushStatus === 401) {
      return {
        label: "token refused",
        tone: "bad",
        note: `agent ${agent} refused the token: paste it into that agent's SearXNG token field (c copies it)`,
      };
    }
    if (e.pushStatus === 409) {
      return {
        label: "name taken",
        tone: "bad",
        note: `agent ${agent} already has an MCP server "${name}" with another Authorization: delete it there, or set it to "Bearer <token>"`,
      };
    }
    if (e.pushStatus === 404) {
      return { label: "worker too old", tone: "bad", note: "the Worker has no /searxng routes yet: deploy it" };
    }
    if (e.pushStatus === 0) {
      return { label: "offline", tone: "busy", note: "cannot reach the Worker; retrying every 30s" };
    }
    return { label: "push failed", tone: "bad", note: `the Worker answered ${e.pushStatus}; retrying every 30s` };
  }
  if (e.error) return { label: "failing", tone: "bad", note: e.error };
  if (!e.up) return { label: "starting", tone: "busy", note: "starting up; the first run installs packages and can take minutes" };
  if (!state.url) return { label: "opening tunnel", tone: "busy", note: "waiting for cloudflared to hand out an address" };
  const served = agents.filter((id) => !e.removed?.[id]);
  if (agents.length && !served.length) {
    return { label: "removed", tone: "off", note: "removed in every agent; add it back there to use it" };
  }
  const done = served.filter((id) => e.agents?.[id] === state.url).length;
  if (done < served.length) {
    return { label: `connecting ${done}/${served.length}`, tone: "busy", note: "sending the address to the agents" };
  }
  return { label: "live", tone: "good", note: "" };
}

/**
 * One agent as `{ label, tone, note }`: whether it holds the current address of every
 * service that is on, and if not, which service is stuck on it and why.
 */
export function agentStatus(state, id, running) {
  const on = running ? (state.services ?? []) : [];
  if (!on.length) return { label: "nothing running", tone: "off", note: "" };
  const svc = state.svc ?? {};
  for (const name of on) {
    const e = svc[name] ?? {};
    if (e.failedAgent !== id || !e.error?.startsWith("push:")) continue;
    if (e.pushStatus === 401) {
      return { label: "token refused", tone: "bad", note: "paste the token into this agent's SearXNG token field (c copies it)" };
    }
    if (e.pushStatus === 409) {
      return {
        label: `${name} name taken`,
        tone: "bad",
        note: `this agent already has an MCP server "${name}" with another Authorization: delete it there, or set it to "Bearer <token>"`,
      };
    }
  }
  // A server the user removed in this agent is theirs to add back; it does not count.
  const removed = on.filter((name) => svc[name]?.removed?.[id]);
  const wanted = on.filter((name) => !removed.includes(name));
  const gone = removed.length ? `; removed here: ${removed.join(", ")}` : "";
  const connected = wanted.filter((name) => state.url && svc[name]?.agents?.[id] === state.url);
  if (connected.length === wanted.length) {
    return { label: "connected", tone: "good", note: `has ${connected.join(", ") || "nothing"}${gone}` };
  }
  return {
    label: `connecting ${connected.length}/${wanted.length}`,
    tone: "busy",
    note: (connected.length ? `has ${connected.join(", ")}` : "") + gone,
  };
}
