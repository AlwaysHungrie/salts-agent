#!/usr/bin/env node
// salts-web: private web search for a salt-agent, from this laptop.
//
// Runs the SearXNG stack in this folder behind its token gate, puts it on the internet
// through an ngrok tunnel, and tells the agent where the tunnel is. The tunnel's address
// changes whenever ngrok restarts, so a supervisor process watches it and pushes every
// new address to the agent.
//
//   salts-web start       check the machine, set up on first run, start everything
//   salts-web setup       the first-run questions again (agent id, token check)
//   salts-web stop        stop the supervisor, the tunnel and the containers
//   salts-web restart     bring the tunnel up again and push its new address
//   salts-web reset       forget the agent (state.json) and delete the token from the Keychain
//   salts-web autostart on|off
//                         start at login (a LaunchAgent), or stop doing so
//
// Every command takes a `:staging` suffix (`start:staging`, `stop:staging`, …) to run
// against the staging Worker instead of production. The two are separate instances —
// own token, state, containers, port, tunnel and login item — and can run side by side.
//
// The token lives in the macOS Keychain and nowhere else: not in a file, not in argv.
// It reaches the gate as an environment variable on the Caddy container.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(import.meta.url);

const [command = "", arg] = process.argv.slice(2);
const [cmd, TARGET = "production"] = command.split(":");

/** Per target: the Worker it pushes to, and the suffix that keeps its resources apart. */
const TARGETS = {
  production: { worker: "https://salt-agent.dhairyashah98.workers.dev", suffix: "" },
  staging: { worker: "https://salt-agent-staging.dhairyashah98.workers.dev", suffix: "-staging" },
};
if (!TARGETS[TARGET]) {
  console.error(`unknown target "${TARGET}": use production (no suffix) or :staging`);
  process.exit(1);
}
const { worker: DEFAULT_WORKER, suffix: SUFFIX } = TARGETS[TARGET];
/** The command again, with this target's suffix, for re-invoking the CLI. */
const withTarget = (name) => (SUFFIX ? `${name}:${TARGET}` : name);

const HOME = path.join(os.homedir(), ".salts-web", ...(SUFFIX ? [TARGET] : []));
const STATE_FILE = path.join(HOME, "state.json");
const PID_FILE = path.join(HOME, "supervisor.pid");
const LOG_FILE = path.join(HOME, "supervisor.log");

const KEYCHAIN_SERVICE = "salts-web";
const KEYCHAIN_ACCOUNT = `searxng-token${SUFFIX}`;

const LAUNCH_LABEL = `com.salts-web${SUFFIX}`;
const LAUNCH_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);

/** The Docker Compose project, which also prefixes its container names. */
const PROJECT = `searxng${SUFFIX}`;
const FIRST_PORT = 8080;
const HEARTBEAT_MS = 30_000;
/** Public checks that may fail in a row before the tunnel is torn down and rebuilt. */
const PUBLIC_FAILURES_BEFORE_RESTART = 3;
const DOCKER_WAIT_MS = 180_000;

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── state ──────────────────────────────────────────────────────────────────────

/**
 * Everything salts-web remembers that is not the token: which agent, which Worker,
 * which port, and what the supervisor last saw. The supervisor writes its progress
 * here and `start` reads it back, which is how the two talk.
 */
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  mkdirSync(HOME, { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// ─── the token, in the Keychain ─────────────────────────────────────────────────

function readToken() {
  const res = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8" }
  );
  return res.status === 0 ? res.stdout.trim() : "";
}

/** Written through `security -i` on stdin, so the token never appears in a process list. */
function writeToken(token) {
  const res = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${token}\n`,
    encoding: "utf8",
  });
  if (res.status !== 0 || readToken() !== token) {
    throw new Error(`could not store the token in the Keychain: ${res.stderr.trim()}`);
  }
}

function newToken() {
  const token = randomBytes(32).toString("hex");
  writeToken(token);
  return token;
}

// ─── the machine ────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, ...opts });
}

function have(cmd) {
  return run("/bin/sh", ["-c", `command -v ${cmd}`]).status === 0;
}

function dockerUp() {
  return run("docker", ["info"], { timeout: 15_000 }).status === 0;
}

/**
 * Get a Docker daemon running, whatever provides it. Nothing assumes Docker was set to
 * start at login: if it is down, the app that provides it is launched and waited for.
 */
async function ensureDocker(say = () => {}) {
  if (dockerUp()) return;
  if (existsSync("/Applications/Docker.app")) {
    say("Docker is not running; starting Docker Desktop");
    run("open", ["-g", "-a", "Docker"]);
  } else if (have("orbctl")) {
    say("Docker is not running; starting OrbStack");
    run("orbctl", ["start"], { timeout: DOCKER_WAIT_MS });
  } else if (have("colima")) {
    say("Docker is not running; starting Colima");
    run("colima", ["start"], { timeout: DOCKER_WAIT_MS });
  } else {
    throw new Error("Docker is not running, and no Docker Desktop, OrbStack or Colima was found to start");
  }
  const until = Date.now() + DOCKER_WAIT_MS;
  while (Date.now() < until) {
    if (dockerUp()) return;
    await sleep(3000);
  }
  throw new Error(`Docker did not come up within ${DOCKER_WAIT_MS / 1000}s`);
}

/** Where ngrok's config file is, if it has a valid one. */
function ngrokConfigPath() {
  const res = run("ngrok", ["config", "check"]);
  const m = `${res.stdout}${res.stderr}`.match(/Valid configuration file at (.+)/);
  return res.status === 0 && m ? m[1].trim() : "";
}

function ngrokHasAuthtoken() {
  const file = ngrokConfigPath();
  if (!file) return false;
  try {
    return /^\s*authtoken:\s*\S+/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** The problems that stop salts-web running at all, none of which it can fix itself. */
function missingTools() {
  const out = [];
  if (process.platform !== "darwin") out.push("salts-web keeps its token in the macOS Keychain, so it runs on macOS only");
  if (!have("docker")) out.push("docker is not installed — install Docker Desktop (or OrbStack / Colima)");
  else if (run("docker", ["compose", "version"]).status !== 0) out.push("`docker compose` is not available — update Docker");
  if (!have("ngrok")) out.push("ngrok is not installed — `brew install ngrok`");
  return out;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function freePort(from) {
  for (let port = from; port < from + 200; port++) {
    if ((await portFree(port, "127.0.0.1")) && (await portFree(port, "0.0.0.0"))) return port;
  }
  throw new Error(`no free port between ${from} and ${from + 199}`);
}

/** The host port the gate is already published on, if the stack is up. */
function runningGatePort() {
  const res = run("docker", ["port", `${PROJECT}-caddy`, "8081"]);
  const m = res.status === 0 ? res.stdout.match(/:(\d+)\s*$/m) : null;
  return m ? Number(m[1]) : 0;
}

// ─── the stack ──────────────────────────────────────────────────────────────────

function compose(args, token, port) {
  return run("docker", ["compose", ...args], {
    cwd: here,
    timeout: 300_000,
    env: {
      ...process.env,
      // `down` interpolates the file too, and the file refuses an empty token.
      SALTS_TOKEN: token || "unused",
      SALTS_PORT: String(port || FIRST_PORT),
      SALTS_PROJECT: PROJECT,
    },
  });
}

async function health(base, token) {
  try {
    const res = await fetch(`${base}/healthz`, {
      headers: { authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "1" },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Tell the agent where its SearXNG is now. Returns the Worker's status, or 0 offline. */
async function pushUrl(worker, agentId, token, url) {
  try {
    const res = await fetch(`${worker}/searxng/${encodeURIComponent(agentId)}/url`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

// ─── the supervisor ─────────────────────────────────────────────────────────────

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  try {
    appendFileSync(LOG_FILE, text);
  } catch {
    process.stdout.write(text);
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function supervisorPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return alive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

/** A pid that is still ngrok, as opposed to a number some other process now holds. */
function isNgrok(pid) {
  return alive(pid) && /ngrok/.test(run("ps", ["-p", String(pid), "-o", "comm="]).stdout);
}

/**
 * The long-running half: keeps Docker, the stack and the tunnel up, and the agent
 * pointed at the tunnel.
 *
 * Every heartbeat walks the same list — Docker reachable, gate answering locally,
 * ngrok alive, tunnel answering from outside, agent holding the current address — and
 * repairs the first thing that is wrong. A laptop waking up on a new network, a
 * killed ngrok and a Docker that was never started all end up at the same place.
 */
async function supervise() {
  mkdirSync(HOME, { recursive: true });
  try {
    if (statSync(LOG_FILE).size > 1_000_000) rmSync(LOG_FILE);
  } catch {}
  writeFileSync(PID_FILE, String(process.pid));

  // A supervisor killed hard leaves its ngrok behind, and a free account allows one.
  const stale = readState().ngrokPid;
  if (isNgrok(stale)) process.kill(stale, "SIGTERM");

  let token = readToken();
  const { agentId, worker } = readState();
  if (!token || !agentId) {
    log(`not set up: run \`salts-web ${withTarget("start")}\` in a terminal first`);
    writeState({ lastError: "not set up" });
    process.exit(1);
  }
  writeState({ url: "", lastError: "", supervisorStartedAt: new Date().toISOString() });
  log(`supervisor up (pid ${process.pid}) for agent ${agentId}`);

  let port = 0;
  let ngrok = null;
  let url = "";
  let publicFailures = 0;
  let busy = false;
  // A tick asked for while one runs (a new tunnel address, a manual restart) runs
  // straight after it rather than waiting out the heartbeat.
  let again = false;

  const startNgrok = () => {
    url = "";
    publicFailures = 0;
    const child = spawn(
      "ngrok",
      ["http", `127.0.0.1:${port}`, "--log", "stdout", "--log-format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    ngrok = child;
    writeState({ ngrokPid: child.pid, url: "" });
    log(`ngrok started (pid ${child.pid}) -> 127.0.0.1:${port}`);
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        // ngrok logs this again whenever its session is re-established, sometimes on
        // a new address; either way the newest one is the one to push.
        if (entry.msg === "started tunnel" && entry.url) {
          url = String(entry.url).replace(/\/+$/, "");
          writeState({ url, lastError: "" });
          log(`tunnel at ${url}`);
          tick();
        } else if (entry.lvl === "eror" || entry.lvl === "crit") {
          const err = entry.err || entry.msg;
          log(`ngrok: ${err}`);
          writeState({ lastError: `ngrok: ${err}` });
        }
      }
    });
    child.stderr.on("data", (chunk) => log(`ngrok: ${String(chunk).trim()}`));
    child.on("exit", (code, signal) => {
      if (ngrok === child) {
        ngrok = null;
        url = "";
        log(`ngrok exited (${signal ?? code})`);
      }
    });
  };

  const stopNgrok = () => {
    const child = ngrok;
    ngrok = null;
    url = "";
    if (child) child.kill("SIGTERM");
  };

  const restartNgrok = async (why) => {
    log(`restarting the tunnel: ${why}`);
    stopNgrok();
    await sleep(1500);
    if (port) startNgrok();
  };

  const bringUpStack = async () => {
    await ensureDocker(log);
    port = runningGatePort();
    if (!port || !(await health(`http://127.0.0.1:${port}`, token))) {
      const wanted = readState().port || FIRST_PORT;
      port = runningGatePort() || ((await portFree(wanted, "127.0.0.1")) ? wanted : await freePort(FIRST_PORT));
      log(`docker compose up on port ${port}`);
      const res = compose(["up", "-d", "--remove-orphans"], token, port);
      if (res.status !== 0) throw new Error(`docker compose up failed: ${(res.stderr || res.stdout).trim()}`);
      port = runningGatePort() || port;
      // SearXNG takes a few seconds before the gate stops answering 502.
      for (let i = 0; i < 30 && !(await health(`http://127.0.0.1:${port}`, token)); i++) await sleep(1000);
    }
    writeState({ port });
  };

  const tick = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      // The token can be replaced from `salts-web setup` while this runs.
      const current = readToken();
      if (current && current !== token) {
        token = current;
        log("token changed; recreating the gate");
        port = 0;
      }

      if (!port || !dockerUp() || !(await health(`http://127.0.0.1:${port}`, token))) {
        const before = port;
        await bringUpStack();
        if (!ngrok || port !== before) await restartNgrok("stack (re)started");
      }

      if (!ngrok) return startNgrok();
      if (!url) return;

      if (await health(url, token)) {
        publicFailures = 0;
      } else if (++publicFailures >= PUBLIC_FAILURES_BEFORE_RESTART) {
        return await restartNgrok(`${url} unreachable ${publicFailures} times in a row`);
      } else {
        log(`${url} unreachable (${publicFailures}/${PUBLIC_FAILURES_BEFORE_RESTART})`);
      }

      if (readState().pushedUrl !== url) {
        const status = await pushUrl(worker || DEFAULT_WORKER, agentId, token, url);
        if (status === 200) {
          writeState({ pushedUrl: url, pushedAt: new Date().toISOString(), pushStatus: 200, lastError: "" });
          log(`agent ${agentId} now points at ${url}`);
        } else {
          const why =
            status === 401
              ? `the agent refused the token — paste it into the agent's SearXNG token field, or run \`salts-web ${withTarget("setup")}\``
              : status === 0
                ? "could not reach the Worker (offline?)"
                : `the Worker answered ${status}`;
          writeState({ lastError: `push: ${why}`, pushStatus: status });
          log(`could not update the agent: ${why}`);
        }
      }
    } catch (err) {
      writeState({ lastError: err.message });
      log(err.message);
    } finally {
      busy = false;
      if (again) {
        again = false;
        setTimeout(tick, 0);
      }
    }
  };

  const shutdown = () => {
    log("supervisor stopping");
    stopNgrok();
    try {
      rmSync(PID_FILE);
    } catch {}
    writeState({ url: "", ngrokPid: 0 });
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // `salts-web restart`.
  process.on("SIGUSR1", () => {
    stopNgrok();
    writeState({ pushedUrl: "" });
    tick().then(() => log("manual restart done"));
  });

  await tick();
  setInterval(tick, HEARTBEAT_MS);
}

// ─── the commands ───────────────────────────────────────────────────────────────

function spawnSupervisor() {
  mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [CLI, withTarget("_supervise")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

async function stopSupervisor() {
  const pid = supervisorPid();
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  const ngrokPid = readState().ngrokPid;
  if (isNgrok(ngrokPid)) process.kill(ngrokPid, "SIGTERM");
  return true;
}

/** Wait for the supervisor to get the agent pointed at a live tunnel, or to fail. */
async function waitForPush(pid, since, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  let shown = "";
  while (Date.now() < until) {
    const s = readState();
    if (s.url && s.pushedUrl === s.url && s.pushedAt && s.pushedAt >= since) return { ok: true, state: s };
    if (s.pushStatus === 401 && s.lastError?.startsWith("push:")) return { ok: false, state: s, refused: true };
    // Any other answer from the Worker will not change by waiting (a 404 is a Worker
    // without the route); offline (0) might.
    if (s.pushStatus > 0 && s.lastError?.startsWith("push:")) return { ok: false, state: s, pushFailed: true };
    if (s.lastError && s.lastError !== shown) {
      shown = s.lastError;
      console.log(`${DIM}  … ${s.lastError}${OFF}`);
    }
    // The spawned pid, not the pid file: the file is written a moment after spawning.
    if (!alive(pid)) return { ok: false, state: readState() };
    await sleep(1000);
  }
  return { ok: false, state: readState(), timedOut: true };
}

function autostartOn() {
  mkdirSync(path.dirname(LAUNCH_PLIST), { recursive: true });
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // launchd starts with a bare PATH; docker and ngrok live wherever this shell found them.
  writeFileSync(
    LAUNCH_PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(CLI)}</string>
    <string>${withTarget("start")}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_FILE)}</string>
</dict>
</plist>
`
  );
  const domain = `gui/${process.getuid()}`;
  run("launchctl", ["bootout", `${domain}/${LAUNCH_LABEL}`]);
  const res = run("launchctl", ["bootstrap", domain, LAUNCH_PLIST]);
  // Bootstrapping runs it once now (RunAtLoad); harmless, `start` is idempotent.
  if (res.status !== 0 && !existsSync(LAUNCH_PLIST)) throw new Error(res.stderr.trim());
}

function autostartOff() {
  run("launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCH_LABEL}`]);
  rmSync(LAUNCH_PLIST, { force: true });
}

function showToken(token) {
  const line = "─".repeat(token.length + 4);
  console.log(`
${BOLD}Your SearXNG token${OFF} ${YELLOW}(shown this once — it is kept in the Keychain, not on disk)${OFF}

  ┌${line}┐
  │  ${BOLD}${token}${OFF}  │
  └${line}┘

In the agent's settings → Capabilities → ${BOLD}Web search${OFF}, paste it into
${BOLD}SearXNG token${OFF} and save. Leave the Brave key blank, or SearXNG is not used.
The URL field fills itself in.
`);
}

async function setup(rl, { force }) {
  const state = readState();
  console.log(`\n${BOLD}salts-web setup${OFF} ${DIM}(${TARGET} · ${DEFAULT_WORKER})${OFF}\n`);

  // The token first: without one, nothing else is worth asking.
  let token = readToken();
  let fresh = false;
  if (!token) {
    token = newToken();
    fresh = true;
    console.log(`${GREEN}✓${OFF} generated a new token and stored it in the Keychain`);
  } else {
    console.log(`${GREEN}✓${OFF} token already in the Keychain`);
  }

  let agentId = state.agentId;
  if (!agentId || force) {
    for (;;) {
      const answer = (
        await rl.question(`Agent ID${agentId ? ` ${DIM}[${agentId}]${OFF}` : ""}: `)
      ).trim();
      agentId = answer || agentId;
      if (agentId) break;
    }
  }
  writeState({ agentId, worker: process.env.SALTS_WEB_WORKER || state.worker || DEFAULT_WORKER });

  if (fresh) {
    showToken(token);
    await rl.question("Press Enter once it is saved in the agent… ");
  }
  return { token, fresh };
}

async function start({ interactive, forceSetup }) {
  const problems = missingTools();
  if (problems.length) {
    for (const p of problems) console.error(`${RED}✗${OFF} ${p}`);
    process.exit(1);
  }

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    // ngrok with no authtoken cannot open a tunnel at all.
    if (!ngrokHasAuthtoken()) {
      if (!rl) {
        console.error(`${RED}✗${OFF} ngrok has no authtoken — run \`salts-web ${withTarget("start")}\` in a terminal`);
        process.exit(1);
      }
      console.log("ngrok needs an authtoken: https://dashboard.ngrok.com/get-started/your-authtoken");
      const authtoken = (await rl.question("ngrok authtoken: ")).trim();
      const res = run("ngrok", ["config", "add-authtoken", authtoken]);
      if (res.status !== 0 || !ngrokHasAuthtoken()) {
        console.error(`${RED}✗${OFF} ngrok did not accept it: ${(res.stderr || res.stdout).trim()}`);
        process.exit(1);
      }
    }
    console.log(`${GREEN}✓${OFF} ngrok installed and configured`);

    // At login this runs unattended and Docker may be minutes away; the supervisor
    // waits for it there, so only a person at the terminal waits for it here.
    if (rl) {
      await ensureDocker((m) => console.log(`${DIM}  … ${m}${OFF}`));
      console.log(`${GREEN}✓${OFF} Docker running`);
    }

    const firstRun = !readToken() || !readState().agentId;
    if ((firstRun || forceSetup) && !rl) {
      console.error(`${RED}✗${OFF} not set up yet — run \`salts-web ${withTarget("start")}\` in a terminal`);
      process.exit(1);
    }
    let fresh = false;
    if (firstRun || forceSetup) ({ fresh } = await setup(rl, { force: forceSetup }));

    for (;;) {
      await stopSupervisor();
      const since = new Date().toISOString();
      writeState({ pushedUrl: "", pushStatus: 0, lastError: "" });
      const pid = spawnSupervisor();
      if (!rl) {
        console.log(`supervisor started; log at ${LOG_FILE}`);
        return;
      }
      console.log(`${DIM}  … starting SearXNG and the tunnel${OFF}`);
      const result = await waitForPush(pid, since);
      if (result.ok) {
        console.log(`${GREEN}✓${OFF} SearXNG on 127.0.0.1:${result.state.port}`);
        console.log(`${GREEN}✓${OFF} tunnel at ${result.state.url}`);
        console.log(`${GREEN}✓${OFF} agent ${result.state.agentId} now searches through it`);
        break;
      }
      if (result.refused) {
        console.log(`${RED}✗${OFF} the agent refused the token.`);
        const choice = (
          await rl.question("[r] retry after pasting it in the agent, [n] make a new token, [q] quit: ")
        ).trim().toLowerCase();
        if (choice === "n") {
          showToken(newToken());
          await rl.question("Press Enter once it is saved in the agent… ");
        } else if (choice !== "r") {
          console.log(`The supervisor keeps retrying in the background; log at ${LOG_FILE}`);
          return;
        }
        continue;
      }
      console.log(`${RED}✗${OFF} ${result.state.lastError || "the supervisor stopped"}`);
      if (result.pushFailed) {
        console.log(`The tunnel is up at ${result.state.url}; the supervisor keeps retrying the agent.`);
        if (result.state.pushStatus === 404) console.log("A 404 means the Worker does not have the /searxng route yet — deploy it.");
      }
      console.log(`Log at ${LOG_FILE}`);
      process.exit(1);
    }

    if ((fresh || forceSetup) && !existsSync(LAUNCH_PLIST)) {
      const yes = (await rl.question("Start salts-web automatically when you log in? [Y/n] ")).trim().toLowerCase();
      if (yes === "" || yes === "y" || yes === "yes") {
        autostartOn();
        console.log(`${GREEN}✓${OFF} will start at login (undo with \`salts-web ${withTarget("autostart")} off\`)`);
      }
    }
  } finally {
    rl?.close();
  }
}

async function stop() {
  const was = await stopSupervisor();
  console.log(was ? `${GREEN}✓${OFF} supervisor and tunnel stopped` : "supervisor was not running");
  if (dockerUp()) {
    const res = compose(["down"], readToken(), readState().port);
    console.log(res.status === 0 ? `${GREEN}✓${OFF} containers stopped` : `${RED}✗${OFF} ${res.stderr.trim()}`);
  }
  writeState({ url: "", pushedUrl: "" });
  if (existsSync(LAUNCH_PLIST)) console.log(`${DIM}autostart is still on; it starts again at next login${OFF}`);
}

/** Back to a first run: the next `start` asks for the agent and makes a new token. */
function reset() {
  if (supervisorPid()) {
    throw new Error(`salts-web is running — \`salts-web ${withTarget("stop")}\` first`);
  }
  rmSync(STATE_FILE, { force: true });
  console.log(`${GREEN}✓${OFF} deleted ${STATE_FILE}`);
  const res = run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
  console.log(
    res.status === 0
      ? `${GREEN}✓${OFF} deleted the token from the Keychain`
      : `${DIM}no token in the Keychain${OFF}`
  );
}

async function restart() {
  const pid = supervisorPid();
  if (!pid) {
    console.log("supervisor not running; starting it");
    return await start({ interactive: process.stdin.isTTY, forceSetup: false });
  }
  const since = new Date().toISOString();
  writeState({ pushStatus: 0, lastError: "" });
  process.kill(pid, "SIGUSR1");
  console.log(`${DIM}  … restarting the tunnel${OFF}`);
  const result = await waitForPush(pid, since, 120_000);
  if (result.ok) console.log(`${GREEN}✓${OFF} tunnel at ${result.state.url}, pushed to the agent`);
  else console.log(`${RED}✗${OFF} ${result.state.lastError || "no new tunnel yet"} — log at ${LOG_FILE}`);
}

const usage = `usage: salts-web <start|stop|restart|reset|setup|autostart on|off>[:staging]`;

try {
  switch (cmd) {
    case "start":
      await start({ interactive: process.stdin.isTTY, forceSetup: false });
      break;
    case "setup":
      await start({ interactive: true, forceSetup: true });
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await restart();
      break;
    case "reset":
      reset();
      break;
    case "autostart":
      if (arg === "on") autostartOn();
      else if (arg === "off") autostartOff();
      else throw new Error(usage);
      console.log(`${GREEN}✓${OFF} autostart ${arg}`);
      break;
    case "_supervise":
      await supervise();
      break;
    default:
      console.log(usage);
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`${RED}✗${OFF} ${err.message}`);
  process.exit(1);
}
