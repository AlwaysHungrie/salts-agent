// What the dashboard says about each service, worked out from state.json alone: the
// supervisor writes its progress there, and this reads it back.

/**
 * One service as `{ label, tone, note }`: a short word for its row, its colour
 * (good | busy | bad | off) and one line saying what is happening or what to do.
 * Every service runs whenever it can, so it is `live`, `live · not in use` (no agent
 * has it switched on) or `error`; `starting` only on the way up. `running` is whether
 * the supervisor is alive.
 */
export function serviceStatus(state, name, running) {
  const e = state.svc?.[name] ?? {};
  const tool = state.tools?.[name];
  if (tool?.state === "missing") return { label: "error", tone: "bad", note: `Can't run on this computer: ${tool.detail}` };
  if (!running) return { label: "stopped", tone: "off", note: `Salts tools isn't running. Press "s" to start it.` };
  if (e.error) return { label: "error", tone: "bad", note: e.error };
  if (!e.up) return { label: "starting", tone: "busy", note: "Starting up. The first run installs packages, which can take a few minutes." };
  if (!state.url) return { label: "starting", tone: "busy", note: "Waiting for Cloudflare to give it a public address." };
  if (!(state.services ?? []).includes(name)) {
    return { label: "live · not in use", tone: "off", note: "No agent uses this yet. Turn it on for an agent in the Agents tab." };
  }
  return { label: "live", tone: "good", note: "" };
}

/** The connection to the Worker as `{ label, tone, note }`, for the header and Settings. */
export function connectionStatus(state, running) {
  if (state.unpaired) {
    return { label: "disconnected", tone: "bad", note: "This computer was disconnected from Salts. Quit and run salts-tools again to connect it." };
  }
  if (!running) return { label: "not running", tone: "off", note: "" };
  if (state.reportError) return { label: "can't report", tone: "busy", note: state.reportError };
  if (!state.reportedAt) return { label: "connecting", tone: "busy", note: "" };
  return { label: "connected", tone: "good", note: "" };
}
