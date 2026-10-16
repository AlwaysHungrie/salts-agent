// What the dashboard says about each service, worked out from state.json alone: the
// supervisor writes its progress there, and this reads it back.

/**
 * One service as `{ label, tone, note }`: a short word for its row, its colour
 * (good | busy | bad | off) and one line saying what is happening or what to do.
 * `running` is whether the supervisor is alive; `app` the page tools are chosen on.
 */
export function serviceStatus(state, name, running, app) {
  const e = state.svc?.[name] ?? {};
  const tool = state.tools?.[name];
  if (tool?.state === "missing") return { label: "missing", tone: "bad", note: tool.detail };
  if (!running) return { label: "off", tone: "off", note: "salts-tools is not running: press s to start it" };
  if (!(state.services ?? []).includes(name)) {
    return { label: "off", tone: "off", note: `no agent uses it: switch it on for one at ${app}` };
  }
  if (e.error) return { label: "failing", tone: "bad", note: e.error };
  if (!e.up) return { label: "starting", tone: "busy", note: "starting up; the first run installs packages and can take minutes" };
  if (!state.url) return { label: "opening tunnel", tone: "busy", note: "waiting for cloudflared to hand out an address" };
  if (state.reportError) return { label: "not reported", tone: "busy", note: state.reportError };
  return { label: "live", tone: "good", note: "" };
}

/** The connection to the Worker as `{ label, tone, note }`, for the header and Settings. */
export function connectionStatus(state, running) {
  if (state.unpaired) {
    return { label: "disconnected", tone: "bad", note: "disconnected in the browser: run salts-tools again to connect" };
  }
  if (!running) return { label: "not running", tone: "off", note: "" };
  if (state.reportError) return { label: "can't report", tone: "busy", note: state.reportError };
  if (!state.reportedAt) return { label: "connecting", tone: "busy", note: "" };
  return { label: "connected", tone: "good", note: "" };
}
