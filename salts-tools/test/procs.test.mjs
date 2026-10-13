import assert from "node:assert/strict";
import { test } from "node:test";

import { caffeinateArgs, orphanTunnels, parseProcessList, supervisorsOf } from "../procs.mjs";

// What this laptop looked like when staging could not open a tunnel: one production
// supervisor, three staging ones (each with its own tunnel), and strays left behind.
const PS = `
  28430     1 /usr/local/bin/node /Users/x/salts-tools/cli.mjs _supervise
  31135 28430 cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8082
  33775     1 /usr/local/bin/node /Users/x/salts-tools/cli.mjs _supervise:staging
  31113 33775 cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8083
  33799     1 /usr/local/bin/node /Users/x/salts-tools/cli.mjs _supervise:staging
  57824     1 /usr/local/bin/node /Users/x/salts-tools/cli.mjs _supervise:staging
  58045 57824 cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8080
  60001     1 cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8090
  60002     1 cloudflared tunnel --url http://localhost:3000
  60003   500 /usr/local/bin/node /Users/x/salts-tools/cli.mjs start:staging matchmaker
`;

test("parses pid, parent and command", () => {
  const procs = parseProcessList(PS);
  assert.equal(procs.length, 10);
  assert.deepEqual(procs[1], { pid: 31135, ppid: 28430, command: "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8082" });
  assert.deepEqual(parseProcessList("garbage\n\n"), []);
});

test("supervisors are told apart by target, and the caller is left out", () => {
  const procs = parseProcessList(PS);
  assert.deepEqual(supervisorsOf(procs, "_supervise:staging"), [33775, 33799, 57824]);
  assert.deepEqual(supervisorsOf(procs, "_supervise:staging", 57824), [33775, 33799]);
  assert.deepEqual(supervisorsOf(procs, "_supervise"), [28430]);
});

test("only salts-tools tunnels whose supervisor is gone are orphans", () => {
  const procs = parseProcessList(PS);
  // 60001: salts-tools' arguments, parent gone. 60002: someone's own cloudflared, left alone.
  assert.deepEqual(orphanTunnels(procs), [60001]);
  const withoutSupervisor = procs.filter((p) => p.pid !== 33775);
  assert.deepEqual(orphanTunnels(withoutSupervisor), [31113, 60001]);
});

test("caffeinate holds off idle and system sleep until the given process exits", () => {
  assert.deepEqual(caffeinateArgs(4242), ["-is", "-w", "4242"]);
});
