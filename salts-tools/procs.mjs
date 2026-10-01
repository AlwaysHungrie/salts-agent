// Finding salts-tools' own processes, so a target never runs more than one supervisor and
// no tunnel outlives the supervisor that started it. ngrok's free plan allows 3 agent
// sessions in all; every stray supervisor or orphaned ngrok holds one.

/** `pid ppid command` lines (ps -axo pid=,ppid=,command=, or the Windows equivalent). */
export function parseProcessList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return out;
}

/** Supervisors started as `cli.mjs <arg>` (`_supervise` or `_supervise:staging`), `except` left out. */
export function supervisorsOf(procs, arg, except = 0) {
  return procs
    .filter((p) => p.pid !== except && /cli\.mjs/.test(p.command))
    .filter((p) => p.command.split(/\s+/).at(-1) === arg)
    .map((p) => p.pid);
}

/** Tunnels salts-tools started (its exact ngrok arguments) whose supervisor is gone. */
export function orphanNgroks(procs) {
  const pids = new Set(procs.map((p) => p.pid));
  return procs
    .filter((p) => /\bngrok(\.exe)?"?\s+http\s+127\.0\.0\.1:\d+\s+--log\s+stdout\s+--log-format\s+json/.test(p.command))
    .filter((p) => p.ppid <= 1 || !pids.has(p.ppid))
    .map((p) => p.pid);
}
