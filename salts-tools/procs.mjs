// Finding salts-tools' own processes, so a target never runs more than one supervisor and
// no tunnel outlives the supervisor that started it; every stray supervisor or orphaned
// cloudflared keeps a tunnel open that nothing points at.

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

/** Tunnels salts-tools started (its exact cloudflared arguments) whose supervisor is gone. */
export function orphanTunnels(procs) {
  const pids = new Set(procs.map((p) => p.pid));
  return procs
    .filter((p) => /\bcloudflared(\.exe)?"?\s+tunnel\s+--no-autoupdate\s+--url\s+http:\/\/127\.0\.0\.1:\d+\s*$/.test(p.command))
    .filter((p) => p.ppid <= 1 || !pids.has(p.ppid))
    .map((p) => p.pid);
}

/**
 * `caffeinate` arguments that keep a Mac from sleeping (idle sleep, and system sleep on
 * AC power) for as long as process `pid` lives. Closing the lid still sleeps it.
 */
export function caffeinateArgs(pid) {
  return ["-is", "-w", String(pid)];
}
