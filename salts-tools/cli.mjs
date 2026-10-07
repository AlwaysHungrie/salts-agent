#!/usr/bin/env node
// salts-tools: local services for a salt-agent, from this laptop, behind one tunnel.
//
// Runs the services below, puts them on the internet through a single ngrok tunnel, and
// tells the agent where each one is. Every service shares the tunnel's address and is
// told apart by path (see gateway.mjs): `<tunnel>/web` is SearXNG, `<tunnel>/matchmaker`
// the matchmaker MCP server, `<tunnel>/analyst` the spreadsheet analyst MCP server. The
// address changes whenever ngrok restarts, so a supervisor process watches it and pushes
// every new address to the agent.
//
//   salts-tools start [service…]
//                         check the machine, set up on first run, start the named services
//                         (beside any already running) or, with none named, the ones last on
//   salts-tools stop [service]
//                         stop one service, or with none named everything: the
//                         supervisor, the tunnel and the containers
//   salts-tools setup     the first-run questions again (agent id, token); starts nothing
//   salts-tools restart   bring the tunnel up again and push its new address
//   salts-tools reset     forget the agent (state.json) and delete the saved token
//   salts-tools autostart on|off
//                         start at login, or stop doing so (a LaunchAgent on macOS, a
//                         systemd user unit on Linux, a Startup-folder script on Windows)
//
// Services: web (SearXNG), matchmaker (local-mcps/matchmaker-mcp), analyst
// (local-mcps/analyst-mcp).
//
// Every command takes a `:staging` suffix (`start:staging`, `stop:staging`, …) to run
// against the staging Worker instead of production. The two are separate instances —
// own token, state, containers, ports, tunnel and login item — and can run side by side.
//
// One token guards everything: the agent's SearXNG token. The gateway checks it, SearXNG's
// Caddy gate and the matchmaker (as its MCP_AUTH_TOKEN) check it again, and the Worker
// takes it as proof when an address is pushed.
//
// The token is never in argv. It lives in the OS secret store: the macOS Keychain, the
// Secret Service keyring on Linux (`secret-tool`), or a DPAPI-encrypted file on Windows.
// A Linux machine with no keyring falls back to a file only this user can read.
// It reaches the services as environment variables.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { startGateway } from "./gateway.mjs";
import { orphanNgroks, parseProcessList, supervisorsOf } from "./procs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(import.meta.url);

const [command = "", ...args] = process.argv.slice(2);
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

const homeFor = (name) => path.join(os.homedir(), `.${name}`, ...(SUFFIX ? [TARGET] : []));
const HOME = homeFor("salts-tools");
const STATE_FILE = path.join(HOME, "state.json");
const PID_FILE = path.join(HOME, "supervisor.pid");
const LOG_FILE = path.join(HOME, "supervisor.log");
const MATCHMAKER_LOG = path.join(HOME, "matchmaker.log");
const ANALYST_LOG = path.join(HOME, "analyst.log");
/** `salts-tools restart` drops this file; the supervisor picks it up (no SIGUSR1 on Windows). */
const RESTART_FILE = path.join(HOME, "restart.request");
/** `start`/`stop` of one service drop this file: the supervisor re-reads which are on. */
const RELOAD_FILE = path.join(HOME, "reload.request");
/** Linux without a keyring: the token, mode 0600. Windows: the DPAPI-encrypted token. */
const TOKEN_FILE = path.join(HOME, "token");
const DPAPI_FILE = path.join(HOME, "token.dpapi");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

// Still named after salts-web, so the token saved before the rename keeps working.
const KEYCHAIN_SERVICE = "salts-web";
const KEYCHAIN_ACCOUNT = `searxng-token${SUFFIX}`;

/** The login item for this CLI under `name` (salts-web was its name before). */
function autostartFor(name) {
  const label = `com.${name}${SUFFIX}`;
  const file = IS_MAC
    ? path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)
    : IS_WIN
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${name}${SUFFIX}.cmd`
        )
      : path.join(
          process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
          "systemd", "user", `${name}${SUFFIX}.service`
        );
  return { label, file };
}
const AUTOSTART = autostartFor("salts-tools");

const HEARTBEAT_MS = 30_000;
/** Public checks that may fail in a row before the tunnel is torn down and rebuilt. */
const PUBLIC_FAILURES_BEFORE_RESTART = 3;
const DOCKER_WAIT_MS = 180_000;
/** Where each free-port scan starts, far enough apart not to race each other. */
const GATEWAY_PORT = 8080;
const WEB_PORT = 8180;
const MATCHMAKER_PORT = 8280;
const MATCHMAKER_PG_PORT = 5432;
const ANALYST_PORT = 8380;

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── state ──────────────────────────────────────────────────────────────────────

/**
 * Everything salts-tools remembers that is not the token: which agent, which Worker,
 * which services are on, their ports, and what the supervisor last saw of each (under
 * `svc.<name>`). The supervisor writes its progress here and the commands read it back,
 * which is how the two talk.
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

/** Merge into one service's entry under `svc`. */
function writeSvc(name, patch) {
  const svc = readState().svc ?? {};
  return writeState({ svc: { ...svc, [name]: { ...svc[name], ...patch } } });
}

// ─── the token, in the OS secret store ──────────────────────────────────────────

/** PowerShell reading/writing a DPAPI file; the token only ever travels on stdin/stdout. */
function powershell(script, input) {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SALTS_DPAPI_FILE: DPAPI_FILE },
  });
}

const SECRET_TOOL_ATTRS = ["service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT];

function readToken() {
  if (IS_MAC) {
    const res = spawnSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8" }
    );
    return res.status === 0 ? res.stdout.trim() : "";
  }
  if (IS_WIN) {
    if (!existsSync(DPAPI_FILE)) return "";
    const res = powershell(
      "$s = Get-Content -Raw $env:SALTS_DPAPI_FILE | ConvertTo-SecureString; " +
        "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"
    );
    return res.status === 0 ? res.stdout.trim() : "";
  }
  if (have("secret-tool")) {
    const res = spawnSync("secret-tool", ["lookup", ...SECRET_TOOL_ATTRS], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  }
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/** Written on stdin, so the token never appears in a process list. */
function writeToken(token) {
  mkdirSync(HOME, { recursive: true });
  let res;
  if (IS_MAC) {
    res = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${token}\n`,
      encoding: "utf8",
    });
  } else if (IS_WIN) {
    res = powershell(
      "[Console]::In.ReadLine() | ConvertTo-SecureString -AsPlainText -Force | " +
        "ConvertFrom-SecureString | Set-Content -NoNewline $env:SALTS_DPAPI_FILE",
      `${token}\n`
    );
  } else {
    if (have("secret-tool")) {
      res = spawnSync("secret-tool", ["store", `--label=salts-web ${KEYCHAIN_ACCOUNT}`, ...SECRET_TOOL_ATTRS], {
        input: token,
        encoding: "utf8",
      });
    }
    // No keyring (a headless box, or no Secret Service running): a file only this user reads.
    if (!res || res.status !== 0) {
      writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
      res = { status: 0, stderr: "" };
    } else {
      rmSync(TOKEN_FILE, { force: true });
    }
  }
  if (res.status !== 0 || readToken() !== token) {
    throw new Error(`could not store the token: ${(res.stderr ?? "").trim()}`);
  }
}

/** Returns whether there was a token to delete. */
function deleteToken() {
  if (IS_MAC) {
    return run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]).status === 0;
  }
  const file = IS_WIN ? DPAPI_FILE : TOKEN_FILE;
  let had = existsSync(file);
  rmSync(file, { force: true });
  if (!IS_WIN && have("secret-tool") && run("secret-tool", ["lookup", ...SECRET_TOOL_ATTRS]).status === 0) {
    run("secret-tool", ["clear", ...SECRET_TOOL_ATTRS]);
    had = true;
  }
  return had;
}

/** Where the token is kept, for messages. */
function tokenStoreName() {
  if (IS_MAC) return "the Keychain";
  if (IS_WIN) return "a DPAPI-encrypted file";
  return existsSync(TOKEN_FILE) ? TOKEN_FILE : "the keyring";
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
  return IS_WIN
    ? run("where", [cmd], { windowsHide: true }).status === 0
    : run("/bin/sh", ["-c", `command -v ${cmd}`]).status === 0;
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
  const winDesktop = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
  if (IS_MAC && existsSync("/Applications/Docker.app")) {
    say("Docker is not running; starting Docker Desktop");
    run("open", ["-g", "-a", "Docker"]);
  } else if (IS_WIN && existsSync(winDesktop)) {
    say("Docker is not running; starting Docker Desktop");
    spawn(winDesktop, [], { detached: true, stdio: "ignore" }).unref();
  } else if (!IS_MAC && !IS_WIN && run("systemctl", ["--user", "cat", "docker-desktop"]).status === 0) {
    say("Docker is not running; starting Docker Desktop");
    run("systemctl", ["--user", "start", "docker-desktop"]);
  } else if (have("orbctl")) {
    say("Docker is not running; starting OrbStack");
    run("orbctl", ["start"], { timeout: DOCKER_WAIT_MS });
  } else if (have("colima")) {
    say("Docker is not running; starting Colima");
    run("colima", ["start"], { timeout: DOCKER_WAIT_MS });
  } else {
    throw new Error(
      IS_MAC || IS_WIN
        ? "Docker is not running, and no Docker Desktop, OrbStack or Colima was found to start"
        : "Docker is not running — start it (`sudo systemctl start docker`) and check your user can run `docker info`"
    );
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

/** The problems that stop these services running at all, none of which it can fix itself. */
function missingTools(names) {
  const out = [];
  if (!usesDocker(names)) {
    // Nothing to check: the services named run without containers.
  } else if (!have("docker")) {
    out.push(
      IS_MAC
        ? "docker is not installed — install Docker Desktop (or OrbStack / Colima)"
        : IS_WIN
          ? "docker is not installed — install Docker Desktop"
          : "docker is not installed — install Docker Engine with the compose plugin (https://docs.docker.com/engine/install/)"
    );
  } else if (run("docker", ["compose", "version"]).status !== 0) out.push("`docker compose` is not available — update Docker");
  if (!have("ngrok")) {
    out.push(
      IS_MAC
        ? "ngrok is not installed — `brew install ngrok`"
        : IS_WIN
          ? "ngrok is not installed — `winget install ngrok.ngrok`"
          : "ngrok is not installed — see https://ngrok.com/download/linux"
    );
  }
  for (const name of names.filter((n) => SERVICES[n]?.uv)) {
    if (!have("uv")) {
      out.push(`uv is not installed (the ${name} needs it) — see https://docs.astral.sh/uv/`);
      break;
    }
  }
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


/** A saved port if it is still free, else the first free one from `from`. */
async function portFrom(saved, from) {
  return saved && (await portFree(saved, "127.0.0.1")) ? saved : await freePort(from);
}

// ─── the services ───────────────────────────────────────────────────────────────

function compose(dir, project, composeArgs, env = {}) {
  return run("docker", ["compose", "-p", project, ...composeArgs], {
    cwd: dir,
    timeout: 300_000,
    env: { ...process.env, ...env },
  });
}

/** The host port a compose service publishes `containerPort` on, if it is up. */
function publishedPort(dir, project, service, containerPort, env = {}) {
  const res = compose(dir, project, ["port", service, String(containerPort)], env);
  const m = res.status === 0 ? res.stdout.match(/:(\d+)\s*$/m) : null;
  return m ? Number(m[1]) : 0;
}

async function ok(url, token) {
  try {
    const res = await fetch(url, {
      headers: token
        ? { authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "1" }
        : {},
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(check, seconds) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

/** A pid whose command line still matches, as opposed to a number some other process now holds. */
function isProcess(pid, pattern) {
  if (!alive(pid)) return false;
  const res = IS_WIN
    ? run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true })
    : run("ps", ["-p", String(pid), "-o", "command="]);
  return pattern.test(res.stdout);
}

const WEB_DIR = path.join(here, "web");
// `searxng` is kept from salts-web, so a stack already running is reused in place.
const WEB_PROJECT = `searxng${SUFFIX}`;
/**
 * Every command interpolates the whole file: it names its containers after the project
 * and refuses an empty token, so `port` and `down` get a stand-in.
 */
const webEnv = (token = "unused", port = WEB_PORT) => ({
  SALTS_TOKEN: token,
  SALTS_PORT: String(port),
  SALTS_PROJECT: WEB_PROJECT,
});
const webPort = () => publishedPort(WEB_DIR, WEB_PROJECT, "caddy", 8081, webEnv());

const MATCHMAKER_DIR = path.join(here, "..", "local-mcps", "matchmaker-mcp");
// The folder's own name, so a database made by running it by hand is the one used.
const MATCHMAKER_PROJECT = `matchmaker-mcp${SUFFIX}`;
const ANALYST_DIR = path.join(here, "..", "local-mcps", "analyst-mcp");
const ANALYST_BIN = IS_WIN
  ? path.join(ANALYST_DIR, ".venv", "Scripts", "analyst-mcp.exe")
  : path.join(ANALYST_DIR, ".venv", "bin", "analyst-mcp");

const MATCHMAKER_BIN = IS_WIN
  ? path.join(MATCHMAKER_DIR, ".venv", "Scripts", "recruiter-mcp.exe")
  : path.join(MATCHMAKER_DIR, ".venv", "bin", "recruiter-mcp");

/**
 * Each service: how to bring it up on loopback (returning its port), whether it answers
 * there, how to take it down, and what to tell the Worker once the tunnel reaches it.
 * `up` and `down` run in the supervisor.
 */
const SERVICES = {
  web: {
    label: "SearXNG",
    docker: true,
    healthy: (port, token) => ok(`http://127.0.0.1:${port}/healthz`, token),
    async up(token) {
      let port = webPort();
      if (port && (await this.healthy(port, token))) return port;
      port = port || (await portFrom(readState().svc?.web?.port, WEB_PORT));
      log(`web: docker compose up on port ${port}`);
      const res = compose(WEB_DIR, WEB_PROJECT, ["up", "-d", "--remove-orphans"], webEnv(token, port));
      if (res.status !== 0) throw new Error(`web: docker compose up failed: ${(res.stderr || res.stdout).trim()}`);
      port = webPort() || port;
      // SearXNG takes a few seconds before the gate stops answering 502.
      await waitUntil(() => this.healthy(port, token), 30);
      return port;
    },
    down() {
      return compose(WEB_DIR, WEB_PROJECT, ["down"], webEnv());
    },
    push: (tunnel) => ({ route: "url", body: { url: `${tunnel}/web` } }),
    reached: (tunnel) => `${tunnel}/web`,
  },

  matchmaker: {
    label: "matchmaker MCP",
    docker: true,
    uv: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      let pgPort = publishedPort(MATCHMAKER_DIR, MATCHMAKER_PROJECT, "postgres", 5432);
      if (!pgPort) {
        pgPort = await portFrom(readState().svc?.matchmaker?.pgPort, MATCHMAKER_PG_PORT);
        log(`matchmaker: postgres up on port ${pgPort}`);
        const res = compose(MATCHMAKER_DIR, MATCHMAKER_PROJECT, ["up", "-d", "--wait"], {
          MM_PG_PORT: String(pgPort),
        });
        if (res.status !== 0) {
          throw new Error(`matchmaker: docker compose up failed: ${(res.stderr || res.stdout).trim()}`);
        }
      }
      writeSvc("matchmaker", { pgPort });
      if (!existsSync(MATCHMAKER_BIN)) {
        log("matchmaker: uv sync");
        const res = run("uv", ["sync", "--frozen"], { cwd: MATCHMAKER_DIR, timeout: 600_000 });
        if (res.status !== 0) throw new Error(`matchmaker: uv sync failed: ${(res.stderr || res.stdout).trim()}`);
      }

      this.stop();
      const port = await portFrom(readState().svc?.matchmaker?.port, MATCHMAKER_PORT);
      const out = openSync(MATCHMAKER_LOG, "a");
      // Its own .env still applies (DATA_DIR, models, …); these win over it.
      const child = spawn(MATCHMAKER_BIN, [], {
        cwd: MATCHMAKER_DIR,
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: {
          ...process.env,
          MCP_TRANSPORT: "http",
          MCP_HOST: "127.0.0.1",
          MCP_PORT: String(port),
          MCP_AUTH_TOKEN: token,
          DATABASE_URL: `postgresql://recruiter:recruiter@127.0.0.1:${pgPort}/recruiter`,
        },
      });
      this.child = child;
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        log(`matchmaker exited (${signal ?? code})`);
      });
      writeSvc("matchmaker", { pid: child.pid });
      log(`matchmaker started (pid ${child.pid}) on port ${port}; log at ${MATCHMAKER_LOG}`);
      // Pending migrations run before it starts answering.
      if (!(await waitUntil(() => this.healthy(port), 90))) {
        throw new Error(`matchmaker did not answer on port ${port} — see ${MATCHMAKER_LOG}`);
      }
      return port;
    },
    /** The server process only; the database stays up. */
    stop() {
      if (this.child) this.child.kill("SIGTERM");
      this.child = null;
      // One left behind by a supervisor killed hard.
      const stale = readState().svc?.matchmaker?.pid;
      if (isProcess(stale, /recruiter-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return compose(MATCHMAKER_DIR, MATCHMAKER_PROJECT, ["down"]);
    },
    push: (tunnel) => ({ route: "mcp", body: { name: "matchmaker", url: `${tunnel}/matchmaker/mcp` } }),
    reached: (tunnel) => `${tunnel}/matchmaker/mcp`,
  },

  analyst: {
    label: "analyst MCP",
    docker: false,
    uv: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      if (!existsSync(ANALYST_BIN)) {
        log("analyst: uv sync");
        const res = run("uv", ["sync", "--frozen"], { cwd: ANALYST_DIR, timeout: 600_000 });
        if (res.status !== 0) throw new Error(`analyst: uv sync failed: ${(res.stderr || res.stdout).trim()}`);
      }
      this.stop();
      const port = await portFrom(readState().svc?.analyst?.port, ANALYST_PORT);
      const out = openSync(ANALYST_LOG, "a");
      // Its own .env still applies (DATA_DIR, INBOX_DIR, ALLOW_PYTHON, …); these win over it.
      const child = spawn(ANALYST_BIN, [], {
        cwd: ANALYST_DIR,
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: {
          ...process.env,
          MCP_TRANSPORT: "http",
          MCP_HOST: "127.0.0.1",
          MCP_PORT: String(port),
          MCP_AUTH_TOKEN: token,
        },
      });
      this.child = child;
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        log(`analyst exited (${signal ?? code})`);
      });
      writeSvc("analyst", { pid: child.pid });
      log(`analyst started (pid ${child.pid}) on port ${port}; log at ${ANALYST_LOG}`);
      if (!(await waitUntil(() => this.healthy(port), 60))) {
        throw new Error(`analyst did not answer on port ${port} — see ${ANALYST_LOG}`);
      }
      return port;
    },
    stop() {
      if (this.child) this.child.kill("SIGTERM");
      this.child = null;
      const stale = readState().svc?.analyst?.pid;
      if (isProcess(stale, /analyst-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return { status: 0, stdout: "", stderr: "" };
    },
    push: (tunnel) => ({ route: "mcp", body: { name: "analyst", url: `${tunnel}/analyst/mcp` } }),
    reached: (tunnel) => `${tunnel}/analyst/mcp`,
  },
};

/** Whether any of these services runs in Docker. */
function usesDocker(names) {
  return names.some((name) => SERVICES[name]?.docker);
}

/** Stop every service that runs as a child process of the supervisor (not containers). */
function stopChildren() {
  for (const svc of Object.values(SERVICES)) svc.stop?.();
}
const NAMES = Object.keys(SERVICES);

/** Tell the agent where a service is now. Returns the Worker's status, or 0 offline. */
async function push(worker, agentId, token, { route, body }) {
  try {
    const res = await fetch(`${worker}/searxng/${encodeURIComponent(agentId)}/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
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

function pidIn(file) {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return alive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

const supervisorPid = () => pidIn(PID_FILE);
const isNgrok = (pid) => isProcess(pid, /ngrok/i);

function processList() {
  const res = IS_WIN
    ? powershell(
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }'
      )
    : run("ps", ["-axo", "pid=,ppid=,command="]);
  return parseProcessList(res.stdout);
}

/**
 * End every supervisor of this target except `except`, then every tunnel left without its
 * supervisor. supervisor.pid names only the newest supervisor, so one started beside it
 * (a second `start`, the login item) used to keep running with its own ngrok until the
 * free plan's 3 sessions were used up and no new tunnel could open.
 */
async function endStrays(except = 0) {
  const kill = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {}
  };
  const others = supervisorsOf(processList(), withTarget("_supervise"), except);
  for (const pid of others) kill(pid, "SIGTERM"); // each stops its own ngrok on the way out
  for (let i = 0; i < 20 && others.some(alive); i++) await sleep(250);
  for (const pid of others.filter(alive)) kill(pid, "SIGKILL");
  const orphans = orphanNgroks(processList());
  for (const pid of orphans) kill(pid, "SIGTERM");
  return others.length + orphans.length;
}

/**
 * The long-running half: keeps Docker, the services, the gateway and the tunnel up, and
 * the agent pointed at the tunnel.
 *
 * Every heartbeat walks the same list — Docker reachable, each service that is on
 * answering locally (and each that was turned off taken down), ngrok alive, tunnel
 * answering from outside, agent holding the current address of each — and repairs what
 * is wrong. A laptop waking up on a new network, a killed ngrok and a Docker that was
 * never started all end up at the same place.
 */
async function supervise() {
  mkdirSync(HOME, { recursive: true });
  try {
    if (statSync(LOG_FILE).size > 1_000_000) rmSync(LOG_FILE);
  } catch {}
  writeFileSync(PID_FILE, String(process.pid));

  // One supervisor and one tunnel per target: end any other, and any ngrok left behind.
  const stale = readState().ngrokPid;
  if (isNgrok(stale)) process.kill(stale, "SIGTERM");
  const ended = await endStrays(process.pid);
  if (ended) log(`ended ${ended} stray supervisor/ngrok process(es)`);

  let token = readToken();
  const { agentId, worker } = readState();
  if (!token || !agentId) {
    log(`not set up: run \`salts-tools ${withTarget("start")}\` in a terminal first`);
    writeState({ lastError: "not set up" });
    process.exit(1);
  }
  writeState({ url: "", lastError: "", supervisorStartedAt: new Date().toISOString() });

  /** Loopback port of each service that is on and answering; what the gateway routes to. */
  const ports = {};
  const gatewayPort = await portFrom(readState().gatewayPort, GATEWAY_PORT);
  await startGateway(gatewayPort, { token: () => token, routes: () => ports });
  writeState({ gatewayPort });
  log(`supervisor up (pid ${process.pid}) for agent ${agentId}; gateway on 127.0.0.1:${gatewayPort}`);

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
      ["http", `127.0.0.1:${gatewayPort}`, "--log", "stdout", "--log-format", "json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    ngrok = child;
    writeState({ ngrokPid: child.pid, url: "" });
    log(`ngrok started (pid ${child.pid}) -> 127.0.0.1:${gatewayPort}`);
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
    startNgrok();
  };

  /** Bring each service that is on up, and take down each this supervisor ran that is now off. */
  const services = async () => {
    const on = new Set(readState().services ?? []);
    for (const name of NAMES) {
      const svc = SERVICES[name];
      if (!on.has(name)) {
        if (ports[name]) {
          delete ports[name];
          log(`${name}: turned off; stopping it`);
          svc.down();
          writeSvc(name, { up: false, pushedTo: "", error: "" });
        }
        continue;
      }
      if (ports[name] && (await svc.healthy(ports[name], token))) continue;
      delete ports[name];
      writeSvc(name, { up: false });
      try {
        if (svc.docker) await ensureDocker(log);
        const port = await svc.up(token);
        ports[name] = port;
        writeSvc(name, { up: true, port, error: "" });
      } catch (err) {
        writeSvc(name, { error: err.message });
        log(err.message);
      }
    }
  };

  const pushAll = async () => {
    const { svc = {} } = readState();
    for (const name of Object.keys(ports)) {
      if (svc[name]?.pushedTo === url) continue;
      const status = await push(worker || DEFAULT_WORKER, agentId, token, SERVICES[name].push(url));
      if (status === 200) {
        writeSvc(name, { pushedTo: url, pushedAt: new Date().toISOString(), pushStatus: 200, error: "" });
        log(`agent ${agentId}: ${name} now at ${SERVICES[name].reached(url)}`);
        continue;
      }
      const why =
        status === 401
          ? `the agent refused the token — paste it into the agent's SearXNG token field, or run \`salts-tools ${withTarget("setup")}\``
          : status === 409
            ? `the agent already has an MCP server named "${name}" with a different Authorization header — delete it or set it to this token`
            : status === 0
              ? "could not reach the Worker (offline?)"
              : `the Worker answered ${status}`;
      writeSvc(name, { error: `push: ${why}`, pushStatus: status });
      log(`${name}: could not update the agent: ${why}`);
    }
  };

  const tick = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      // The token can be replaced from `salts-tools setup` while this runs; every
      // service holds it, so each is recreated.
      const current = readToken();
      if (current && current !== token) {
        token = current;
        log("token changed; recreating the services");
        for (const name of Object.keys(ports)) delete ports[name];
        stopChildren();
      }

      await services();

      if (!ngrok) return startNgrok();
      if (!url) return;

      if (await ok(`${url}/healthz`, token)) {
        publicFailures = 0;
      } else if (++publicFailures >= PUBLIC_FAILURES_BEFORE_RESTART) {
        return await restartNgrok(`${url} unreachable ${publicFailures} times in a row`);
      } else {
        log(`${url} unreachable (${publicFailures}/${PUBLIC_FAILURES_BEFORE_RESTART})`);
      }

      await pushAll();
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
    stopChildren();
    try {
      rmSync(PID_FILE);
    } catch {}
    writeState({ url: "", ngrokPid: 0 });
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  rmSync(RESTART_FILE, { force: true });
  rmSync(RELOAD_FILE, { force: true });
  setInterval(() => {
    // `salts-tools restart`: a new tunnel, pushed again everywhere.
    if (existsSync(RESTART_FILE)) {
      rmSync(RESTART_FILE, { force: true });
      stopNgrok();
      const svc = readState().svc ?? {};
      for (const name of NAMES) svc[name] = { ...svc[name], pushedTo: "" };
      writeState({ svc });
      tick().then(() => log("manual restart done"));
    }
    // `salts-tools start <service>` / `stop <service>`: same tunnel, services changed.
    if (existsSync(RELOAD_FILE)) {
      rmSync(RELOAD_FILE, { force: true });
      tick();
    }
  }, 1000);

  await tick();
  setInterval(tick, HEARTBEAT_MS);
}

// ─── moving over from salts-web ─────────────────────────────────────────────────

/**
 * salts-tools was salts-web, which ran SearXNG alone. Its state moves here once: the
 * old supervisor is stopped (a free ngrok account allows one tunnel), the agent and web
 * port carry over, and a salts-web login item is replaced by this one. The token stays
 * where it was, under the same Keychain entry.
 */
async function migrateFromSaltsWeb() {
  const old = homeFor("salts-web");
  const oldState = path.join(old, "state.json");
  if (existsSync(STATE_FILE) || !existsSync(oldState)) return;

  const pid = pidIn(path.join(old, "supervisor.pid"));
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  const prev = JSON.parse(readFileSync(oldState, "utf8"));
  if (isNgrok(prev.ngrokPid)) process.kill(prev.ngrokPid, "SIGTERM");

  mkdirSync(HOME, { recursive: true });
  for (const file of ["token", "token.dpapi"]) {
    if (existsSync(path.join(old, file))) copyFileSync(path.join(old, file), path.join(HOME, file));
  }
  writeState({
    agentId: prev.agentId,
    worker: prev.worker,
    services: ["web"],
    svc: { web: { port: prev.port || 0 } },
  });
  renameSync(oldState, `${oldState}.migrated`);
  console.log(`${GREEN}✓${OFF} moved salts-web's settings to ${HOME}`);

  const legacy = autostartFor("salts-web");
  if (existsSync(legacy.file)) {
    autostartOff(legacy);
    autostartOn();
    console.log(`${GREEN}✓${OFF} replaced the salts-web login item with salts-tools`);
  }
}

// ─── the commands ───────────────────────────────────────────────────────────────

function spawnSupervisor() {
  mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [CLI, withTarget("_supervise")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function stopSupervisor() {
  const pid = supervisorPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  const strays = await endStrays();
  const { ngrokPid, svc } = readState();
  if (isNgrok(ngrokPid)) process.kill(ngrokPid, "SIGTERM");
  if (isProcess(svc?.matchmaker?.pid, /recruiter-mcp/i)) process.kill(svc.matchmaker.pid, "SIGTERM");
  if (isProcess(svc?.analyst?.pid, /analyst-mcp/i)) process.kill(svc.analyst.pid, "SIGTERM");
  return Boolean(pid || strays);
}

/** Wait for the supervisor to get the agent pointed at a live tunnel for `names`, or to fail. */
async function waitForPush(pid, since, names, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  const shown = new Set();
  while (Date.now() < until) {
    const s = readState();
    const svc = s.svc ?? {};
    const done = (n) => s.url && svc[n]?.pushedTo === s.url && svc[n]?.pushedAt >= since;
    if (names.every(done)) return { ok: true, state: s };
    for (const n of names) {
      const e = svc[n] ?? {};
      if (e.pushStatus === 401 && e.error?.startsWith("push:")) return { ok: false, state: s, refused: true };
      // Any other answer from the Worker will not change by waiting (a 404 is a Worker
      // without the route); offline (0) might.
      if (e.pushStatus > 0 && e.pushStatus !== 200 && e.error?.startsWith("push:")) {
        return { ok: false, state: s, pushFailed: n };
      }
    }
    for (const err of [s.lastError, ...names.map((n) => svc[n]?.error && `${n}: ${svc[n].error}`)]) {
      if (err && !shown.has(err)) {
        shown.add(err);
        console.log(`${DIM}  … ${err}${OFF}`);
      }
    }
    // The spawned pid, not the pid file: the file is written a moment after spawning.
    if (!alive(pid)) return { ok: false, state: readState() };
    await sleep(1000);
  }
  return { ok: false, state: readState(), timedOut: true };
}

function autostartOn({ label, file } = AUTOSTART) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (IS_WIN) {
    // A script in the Startup folder; `start /min` so no console window stays open.
    writeFileSync(
      file,
      `@echo off\r\nstart "salts-tools" /min "${process.execPath}" "${CLI}" ${withTarget("start")}\r\n`
    );
    return;
  }
  if (!IS_MAC) {
    // A systemd user unit. `start` exits once the supervisor is spawned; RemainAfterExit
    // keeps the unit (and so the supervisor in its cgroup) alive.
    if (!have("systemctl")) throw new Error("autostart on Linux needs systemd (`systemctl --user`)");
    const q = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    writeFileSync(
      file,
      `[Unit]
Description=salts-tools (${TARGET})

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${q(`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`)}
ExecStart=${q(process.execPath)} ${q(CLI)} ${withTarget("start")}
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`
    );
    run("systemctl", ["--user", "daemon-reload"]);
    const res = run("systemctl", ["--user", "enable", path.basename(file)]);
    if (res.status !== 0) throw new Error(res.stderr.trim());
    return;
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // launchd starts with a bare PATH; docker, ngrok and uv live wherever this shell found them.
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
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
  run("launchctl", ["bootout", `${domain}/${label}`]);
  const res = run("launchctl", ["bootstrap", domain, file]);
  // Bootstrapping runs it once now (RunAtLoad); harmless, `start` is idempotent.
  if (res.status !== 0 && !existsSync(file)) throw new Error(res.stderr.trim());
}

function autostartOff({ label, file } = AUTOSTART) {
  if (IS_MAC) run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]);
  else if (!IS_WIN && existsSync(file)) run("systemctl", ["--user", "disable", path.basename(file)]);
  rmSync(file, { force: true });
  if (!IS_MAC && !IS_WIN) run("systemctl", ["--user", "daemon-reload"]);
}

function showToken(token) {
  const line = "─".repeat(token.length + 4);
  console.log(`
${BOLD}Your salts-tools token${OFF} ${YELLOW}(shown this once — it is kept in ${tokenStoreName()})${OFF}

  ┌${line}┐
  │  ${BOLD}${token}${OFF}  │
  └${line}┘

In the agent's settings → Capabilities → ${BOLD}Web search${OFF}, paste it into
${BOLD}SearXNG token${OFF} and save. Leave the Brave key blank, or SearXNG is not used.
It guards every service salts-tools runs; the URLs fill themselves in.
`);
}

async function setup(rl, { force }) {
  const state = readState();
  console.log(`\n${BOLD}salts-tools setup${OFF} ${DIM}(${TARGET} · ${DEFAULT_WORKER})${OFF}\n`);

  // The token first: without one, nothing else is worth asking.
  let token = readToken();
  let fresh = false;
  if (!token) {
    token = newToken();
    fresh = true;
    console.log(`${GREEN}✓${OFF} generated a new token and stored it in ${tokenStoreName()}`);
  } else {
    console.log(`${GREEN}✓${OFF} token already in ${tokenStoreName()}`);
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
  writeState({ agentId, worker: process.env.SALTS_TOOLS_WORKER || state.worker || DEFAULT_WORKER });

  if (fresh) {
    showToken(token);
    await rl.question("Press Enter once it is saved in the agent… ");
  }
  return { token, fresh };
}

/** The service names on the command line, checked. */
function namedServices() {
  for (const name of args) {
    if (!SERVICES[name]) throw new Error(`unknown service "${name}": use ${NAMES.join(", ")}`);
  }
  return [...new Set(args)];
}

function report(state, names) {
  console.log(`${GREEN}✓${OFF} tunnel at ${state.url}`);
  for (const name of names) {
    console.log(`${GREEN}✓${OFF} ${SERVICES[name].label}: agent ${state.agentId} reaches it at ${SERVICES[name].reached(state.url)}`);
  }
  if (names.includes("analyst")) {
    console.log(`
The agent's ${BOLD}analyst${OFF} MCP server reads Excel and CSV files sent in the chat. Files can
also go in its inbox folder: ${BOLD}${path.join(ANALYST_DIR, "data", "inbox")}${OFF}
${DIM}(DATA_DIR / INBOX_DIR in local-mcps/analyst-mcp/.env move it). run_python is off unless
ALLOW_PYTHON=true there.${OFF}`);
  }
  if (names.includes("matchmaker")) {
    // Caps (USD per call) are the matchmaker's own suggestions, from its .env.example.
    const headers = [
      ["X-OpenRouter-Api-Key", "<your OpenRouter key>", "pays for its model calls"],
      ["X-Cost-Approved-Resume-Ingestion", "0.01", "one resume, ~$0.002"],
      ["X-Cost-Approved-Job-Match", "0.10", "one job match, ~$0.01–0.04"],
      ["X-Cost-Approved-Search", "0.001", "one candidate search, ~free"],
      ["X-Cost-Approved-Folder-Ingestion", "5.00", "a whole inbox run, ~$0.004 a file"],
    ];
    const width = Math.max(...headers.map(([h]) => h.length));
    console.log(`
The agent's ${BOLD}matchmaker${OFF} MCP server already has the ${BOLD}Authorization${OFF} header.
Its paid tools also need these headers. Add them on that server in the agent's
settings → ${BOLD}MCP servers${OFF} (they are kept when the address changes):
`);
    for (const [header, value, note] of headers) {
      console.log(`  ${header.padEnd(width)}  ${BOLD}${value}${OFF}  ${DIM}${note}${OFF}`);
    }
    console.log(`\n${DIM}Caps are the most one call may spend, in US dollars; 0 blocks that tool.${OFF}`);
  }
}

async function askAutostart(rl) {
  if (existsSync(AUTOSTART.file)) return;
  const yes = (await rl.question("Start salts-tools automatically when you log in? [Y/n] ")).trim().toLowerCase();
  if (yes === "" || yes === "y" || yes === "yes") {
    autostartOn();
    console.log(`${GREEN}✓${OFF} will start at login (undo with \`salts-tools ${withTarget("autostart")} off\`)`);
  }
}

/** `salts-tools setup`: the questions only. Nothing starts until `start`. */
async function setupOnly() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const before = readState().agentId;
    // No autostart question here: turning it on runs the login item at once.
    await setup(rl, { force: true });
    const { agentId } = readState();
    if (supervisorPid() && agentId !== before) {
      console.log(`salts-tools is running for agent ${before}; \`salts-tools ${withTarget("stop")}\` and start again to switch.`);
    } else if (!supervisorPid()) {
      console.log(`Set up. Start a service with \`salts-tools ${withTarget("start")} <${NAMES.join("|")}>\`.`);
    }
  } finally {
    rl.close();
  }
}

async function start({ interactive }) {
  const named = namedServices();
  const saved = readState().services ?? [];
  // Named: those, plus whatever is already running beside them. None named (as at
  // login): the ones that were on, or SearXNG, what salts-web always ran.
  const services = named.length
    ? [...new Set([...(supervisorPid() ? saved : []), ...named])]
    : saved.length
      ? saved
      : ["web"];

  const problems = missingTools(services);
  if (problems.length) {
    for (const p of problems) console.error(`${RED}✗${OFF} ${p}`);
    process.exit(1);
  }

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    // ngrok with no authtoken cannot open a tunnel at all.
    if (!ngrokHasAuthtoken()) {
      if (!rl) {
        console.error(`${RED}✗${OFF} ngrok has no authtoken — run \`salts-tools ${withTarget("start")}\` in a terminal`);
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
    if (rl && usesDocker(services)) {
      await ensureDocker((m) => console.log(`${DIM}  … ${m}${OFF}`));
      console.log(`${GREEN}✓${OFF} Docker running`);
    }

    const firstRun = !readToken() || !readState().agentId;
    if (firstRun && !rl) {
      console.error(`${RED}✗${OFF} not set up yet — run \`salts-tools ${withTarget("start")}\` in a terminal`);
      process.exit(1);
    }
    let fresh = false;
    if (firstRun) ({ fresh } = await setup(rl, { force: false }));
    writeState({ services });

    // Running already: the new services join the same tunnel, so its address stays.
    let pid = supervisorPid();
    if (pid) await endStrays(pid);
    const wanted = pid && readState().url ? named : services;
    for (;;) {
      const since = new Date().toISOString();
      for (const name of wanted) writeSvc(name, { pushedTo: "", pushStatus: 0, error: "" });
      if (pid && readState().url) {
        writeFileSync(RELOAD_FILE, since);
      } else {
        await stopSupervisor();
        writeState({ lastError: "" });
        pid = spawnSupervisor();
      }
      if (!rl) {
        console.log(`supervisor running; log at ${LOG_FILE}`);
        return;
      }
      if (!wanted.length) {
        console.log(`${GREEN}✓${OFF} already running: ${services.join(", ")} at ${readState().url}`);
        return;
      }
      console.log(`${DIM}  … starting ${wanted.join(", ")} and the tunnel${OFF}`);
      const result = await waitForPush(pid, since, wanted);
      if (result.ok) {
        report(result.state, wanted);
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
      const failed = result.pushFailed;
      if (failed && result.state.svc?.[failed]?.pushStatus === 409) {
        console.log(`
${RED}✗${OFF} Your agent already has an MCP server called ${BOLD}${failed}${OFF}, set up without your
  salts-tools token. salts-tools does not change a server it did not set up, so it
  left that one alone.

  The tunnel is up at ${result.state.url}
  ("${failed}" will be at ${SERVICES[failed].reached(result.state.url)}).

  To fix it, open the agent's settings → ${BOLD}MCP servers${OFF} and either:
    • ${BOLD}delete${OFF} "${failed}": salts-tools adds it again, already connected, or
    • ${BOLD}edit${OFF} "${failed}" and set its ${BOLD}Authorization${OFF} header to your token
      (choose [t] below to see the exact value).
`);
        for (;;) {
          const choice = (
            await rl.question("[r] retry once it is fixed, [t] show the Authorization value, [q] quit: ")
          ).trim().toLowerCase();
          if (choice === "t") {
            console.log(`\n  ${BOLD}Bearer ${readToken()}${OFF}\n`);
            continue;
          }
          if (choice === "r") break;
          console.log(`salts-tools keeps running and connects "${failed}" as soon as it is fixed.`);
          return;
        }
        continue;
      }
      console.log(`${RED}✗${OFF} ${(failed && result.state.svc?.[failed]?.error) || result.state.lastError || "the supervisor stopped"}`);
      if (failed) {
        console.log(`The tunnel is up at ${result.state.url}; the supervisor keeps retrying the agent.`);
        if (result.state.svc[failed].pushStatus === 404) {
          console.log("A 404 means the Worker does not have the /searxng routes yet — deploy it.");
        }
      }
      console.log(`Log at ${LOG_FILE}`);
      process.exit(1);
    }

    if (fresh) await askAutostart(rl);
  } finally {
    rl?.close();
  }
}

async function stop() {
  const named = namedServices();
  if (named.length > 1) throw new Error("stop one service at a time, or all with no name");
  const services = readState().services ?? [];
  const rest = services.filter((n) => !named.includes(n));

  // One service, others still on: the tunnel stays, only that service goes.
  if (named.length && rest.length) {
    const [name] = named;
    writeState({ services: rest });
    const pid = supervisorPid();
    if (pid) {
      writeFileSync(RELOAD_FILE, new Date().toISOString());
      for (let i = 0; i < 120 && readState().svc?.[name]?.up && alive(pid); i++) await sleep(1000);
    } else if (dockerUp()) {
      SERVICES[name].down();
      writeSvc(name, { up: false, pushedTo: "" });
    }
    console.log(`${GREEN}✓${OFF} ${SERVICES[name].label} stopped; still running: ${rest.join(", ")}`);
    return;
  }

  // Everything. The list of services is kept, so the next `start` brings them back.
  const was = await stopSupervisor();
  console.log(was ? `${GREEN}✓${OFF} supervisor and tunnel stopped` : "supervisor was not running");
  if (dockerUp()) {
    for (const name of NAMES) {
      const res = SERVICES[name].down();
      if (res.status !== 0) console.log(`${RED}✗${OFF} ${name}: ${res.stderr.trim()}`);
    }
    console.log(`${GREEN}✓${OFF} containers stopped`);
  }
  const svc = readState().svc ?? {};
  for (const name of NAMES) svc[name] = { ...svc[name], up: false, pushedTo: "" };
  writeState({ url: "", svc });
  if (existsSync(AUTOSTART.file)) console.log(`${DIM}autostart is still on; it starts again at next login${OFF}`);
}

/**
 * Delete this target's files in `dir`, and `dir` itself once empty. Production's folder
 * holds staging's in `staging/`, which is left alone.
 */
function clearHome(dir) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir)) {
    if (!SUFFIX && entry === "staging") continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Back to a first run, as on a machine that never ran salts-tools (or salts-web): the
 * token, the state, the logs, the login item and salts-web's leftovers all go. Docker
 * volumes (the matchmaker's database) are kept.
 */
function reset() {
  if (supervisorPid() || pidIn(path.join(homeFor("salts-web"), "supervisor.pid"))) {
    throw new Error(`salts-tools is running — \`salts-tools ${withTarget("stop")}\` first`);
  }
  const where = tokenStoreName();
  console.log(deleteToken() ? `${GREEN}✓${OFF} deleted the token from ${where}` : `${DIM}no saved token${OFF}`);
  for (const item of [AUTOSTART, autostartFor("salts-web")]) {
    if (!existsSync(item.file)) continue;
    autostartOff(item);
    console.log(`${GREEN}✓${OFF} removed the login item ${item.file}`);
  }
  for (const dir of [HOME, homeFor("salts-web")]) {
    if (clearHome(dir)) console.log(`${GREEN}✓${OFF} deleted ${dir}${SUFFIX ? "" : ` ${DIM}(staging kept)${OFF}`}`);
  }
}

async function restart() {
  const pid = supervisorPid();
  if (!pid) {
    console.log("supervisor not running; starting it");
    return await start({ interactive: process.stdin.isTTY });
  }
  await endStrays(pid); // a stray's session would stop the new tunnel from opening
  const since = new Date().toISOString();
  const services = readState().services ?? [];
  for (const name of services) writeSvc(name, { pushStatus: 0, error: "" });
  writeState({ lastError: "" });
  writeFileSync(RESTART_FILE, since);
  console.log(`${DIM}  … restarting the tunnel${OFF}`);
  const result = await waitForPush(pid, since, services, 120_000);
  if (result.ok) report(result.state, services);
  else console.log(`${RED}✗${OFF} ${result.state.lastError || "no new tunnel yet"} — log at ${LOG_FILE}`);
}

const usage = `usage: salts-tools <start [${NAMES.join("|")}…]|stop [${NAMES.join("|")}]|restart|reset|setup|autostart on|off>[:staging]`;

try {
  // Not before `reset`: it deletes salts-web's leftovers rather than moving them.
  if (cmd && cmd !== "_supervise" && cmd !== "reset") await migrateFromSaltsWeb();
  switch (cmd) {
    case "start":
      await start({ interactive: process.stdin.isTTY });
      break;
    case "setup":
      await setupOnly();
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
      if (args[0] === "on") autostartOn();
      else if (args[0] === "off") autostartOff();
      else throw new Error(usage);
      console.log(`${GREEN}✓${OFF} autostart ${args[0]}`);
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
