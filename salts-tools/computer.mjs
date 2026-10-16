// This computer and the Worker: pairing it to the user's account, and the report it
// sends every heartbeat. The Worker answers each report with the agents this computer
// serves and the tools switched on for them, which is what the supervisor runs.

/** POST/PUT/DELETE `path` on the Worker. `{ status, body }`; status 0 when it is unreachable. */
export async function call(worker, path, { method = "POST", body, credential } = {}) {
  try {
    const res = await fetch(`${worker}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: {} };
  }
}

/** Open a pairing for this computer: `{ user_code, device_code, expires_in, interval }`. */
export async function startPairing(worker, name) {
  const { status, body } = await call(worker, "/salts/pair", { body: { name } });
  if (status !== 200) {
    throw new Error(
      status === 0
        ? `Couldn't reach ${worker}. Are you offline?`
        : status === 404
          ? `${worker} doesn't support pairing yet.`
          : body.error || `Salts returned an error (${status}).`
    );
  }
  return body;
}

/**
 * Wait for the user to approve the pairing in the browser. Resolves with the credential,
 * or undefined when the code expired first.
 */
export async function waitForApproval(worker, pairing, { sleep, onWait = () => {} }) {
  const until = Date.now() + pairing.expires_in * 1000;
  while (Date.now() < until) {
    await sleep(pairing.interval * 1000);
    const { status, body } = await call(worker, "/salts/pair/poll", {
      body: { device_code: pairing.device_code },
    });
    if (status === 200 && body.status === "approved") return body.credential;
    if (status === 200 && body.status === "gone") return undefined;
    onWait(status);
  }
  return undefined;
}

/** What `state` says about one service, as the Worker reads it. */
function toolState(name, { wanted, missing, svc, ports }) {
  if (missing) return { state: "missing", detail: missing };
  if (!wanted.includes(name)) return { state: "off", detail: "" };
  if (svc?.error) return { state: "failed", detail: svc.error };
  if (ports[name]) return { state: "ready", detail: "" };
  return { state: "starting", detail: "" };
}

/**
 * The tools part of a report: every service this computer can run, its state, and what
 * the Worker needs to put it on an agent (its kind, the headers it wants filled in, the
 * capabilities it needs switched on).
 */
export function toolsReport(services, { wanted, missing, svc, ports }) {
  const out = {};
  for (const [name, s] of Object.entries(services)) {
    out[name] = {
      kind: s.kind,
      label: s.label,
      headers: s.headers ?? [],
      needs: s.needs ?? [],
      ...toolState(name, { wanted, missing: missing[name], svc: svc[name], ports }),
    };
  }
  return out;
}

/** The services the Worker's answer wants running, limited to ones this CLI knows. */
export function wantedServices(answer, known) {
  const wanted = Array.isArray(answer?.wanted) ? answer.wanted : [];
  return known.filter((name) => wanted.includes(name));
}

/** The command that opens `url` in the default browser here. */
export function openCommand(url, platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/**
 * The agent id in what the user typed: the id itself, or any link to one of the agent's
 * pages on the Salts site (`…/a/<id>/…`). "" when there is nothing to go on.
 */
export function agentIdFrom(text) {
  const typed = String(text ?? "").trim();
  const inLink = typed.match(/\/a\/([^/?#\s]+)/);
  if (!inLink) return typed;
  try {
    return decodeURIComponent(inLink[1]);
  } catch {
    return inLink[1];
  }
}
