#!/usr/bin/env node
// salts-tools: local services for a salt-agent, from this laptop, behind one tunnel.
//
// Runs the services below, puts them on the internet through a single cloudflared quick
// tunnel (no account needed), and
// tells the agent where each one is. Every service shares the tunnel's address and is
// told apart by path (see gateway.mjs): `<tunnel>/web` is SearXNG, `<tunnel>/matchmaker`
// the matchmaker MCP server, `<tunnel>/analyst` the spreadsheet analyst MCP server. The
// address changes whenever cloudflared restarts, so a supervisor process watches it and
// pushes every new address to the agent.
//
//   salts-tools           the dashboard: every service, agent and setting on one screen,
//                         started, stopped and changed from the keyboard (see the end)
//   salts-tools start [service…]
//                         check the machine, set up on first run, start the named services
//                         (beside any already running) or, with none named, the ones last on
//   salts-tools stop [service]
//                         stop one service, or with none named everything: the
//                         supervisor, the tunnel and the containers
//   salts-tools setup     the first-run questions again (agent ids, token); starts nothing
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
// One install serves any number of agents: every one is told every address, and each holds
// the same token in its SearXNG token field.
//
// One token guards everything: the agents' SearXNG token. The gateway checks it, SearXNG's
// Caddy gate and the matchmaker (as its MCP_AUTH_TOKEN) check it again, and the Worker
// takes it as proof when an address is pushed.
//
// The token is never in argv. It lives in the OS secret store: the macOS Keychain, the
// Secret Service keyring on Linux (`secret-tool`), or a DPAPI-encrypted file on Windows.
// A Linux machine with no keyring falls back to a file only this user can read.
// It reaches the services as environment variables.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
import { agentIdsOf, agentsFor, agentsLabel, parseAgentIds, servesAgent, toggleService } from "./agents.mjs";
import { startGateway } from "./gateway.mjs";
import { installMcp, launchArgs, mcpSource, viaNpx } from "./mcps.mjs";
import { caffeinateArgs, orphanTunnels, parseProcessList, supervisorsOf } from "./procs.mjs";
import { agentStatus, serviceStatus } from "./status.mjs";
import { BOLD, DIM, INV, OFF, follow, keys, paint, rowText, wrap } from "./tui.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version;
/** How the user runs this CLI, for the commands it tells them to run. */
const SELF = viaNpx(CLI) ? "npx salts-tools" : "salts-tools";
/** The login item's program and arguments, before the command. */
const LAUNCH = launchArgs({ cli: CLI, execPath: process.execPath, platform: process.platform });

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
/** How long a new tunnel may take to connect and resolve before it is rebuilt. */
const TUNNEL_READY_MS = 120_000;
const DOCKER_WAIT_MS = 180_000;
/** Where each free-port scan starts, far enough apart not to race each other. */
const GATEWAY_PORT = 8080;
const WEB_PORT = 8180;
const MATCHMAKER_PORT = 8280;
const ANALYST_PORT = 8380;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `host` has a DNS record, asking 1.1.1.1 directly. A quick tunnel's name is
 * published a few seconds after cloudflared prints it, and asking the system resolver
 * too early leaves it caching "no such host" long after the name exists.
 */
async function resolvable(host, seconds = 60) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  for (let i = 0; i < seconds; i++) {
    try {
      if ((await resolver.resolve4(host)).length) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

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
  if (!have("cloudflared")) {
    out.push(
      IS_MAC
        ? "cloudflared is not installed — `brew install cloudflared`"
        : IS_WIN
          ? "cloudflared is not installed — `winget install --id Cloudflare.cloudflared`"
          : "cloudflared is not installed — see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
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
      headers: token ? { authorization: `Bearer ${token}` } : {},
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

/** Installed copies of packaged MCP servers: shared by every target, as the repo's are. */
const MCP_ROOT = path.join(os.homedir(), ".salts-tools", "mcps");
const MATCHMAKER_SRC = mcpSource(here, "matchmaker-mcp", MCP_ROOT);
const ANALYST_SRC = mcpSource(here, "analyst-mcp", MCP_ROOT);
const MATCHMAKER_DIR = MATCHMAKER_SRC.dir;
const ANALYST_DIR = ANALYST_SRC.dir;

/**
 * Make `src` ready to run as `bin`: install the packaged copy when this version has not
 * been, then `uv sync` when that changed anything or there is no environment yet.
 */
function readyMcp(name, src, bin) {
  const fresh = src.bundled ? installMcp(src.bundled, src.dir, VERSION) : false;
  if (!fresh && existsSync(bin)) return;
  log(`${name}: uv sync`);
  const res = run("uv", ["sync", "--frozen"], { cwd: src.dir, timeout: 600_000 });
  if (res.status !== 0) throw new Error(`${name}: uv sync failed: ${(res.stderr || res.stdout).trim()}`);
}
const ANALYST_BIN = IS_WIN
  ? path.join(ANALYST_DIR, ".venv", "Scripts", "analyst-mcp.exe")
  : path.join(ANALYST_DIR, ".venv", "bin", "analyst-mcp");

const MATCHMAKER_BIN = IS_WIN
  ? path.join(MATCHMAKER_DIR, ".venv", "Scripts", "matchmaker-mcp.exe")
  : path.join(MATCHMAKER_DIR, ".venv", "bin", "matchmaker-mcp");

/**
 * Each service: how to bring it up on loopback (returning its port), whether it answers
 * there, how to take it down, and what to tell the Worker once the tunnel reaches it.
 * `up` and `down` run in the supervisor.
 */
const SERVICES = {
  web: {
    label: "SearXNG",
    about: "web search for the agent (SearXNG, in Docker)",
    log: LOG_FILE,
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
    about: "resumes, cover letters and job matching (uv, no Docker)",
    log: MATCHMAKER_LOG,
    docker: false,
    uv: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      readyMcp("matchmaker", MATCHMAKER_SRC, MATCHMAKER_BIN);
      this.stop();
      const port = await portFrom(readState().svc?.matchmaker?.port, MATCHMAKER_PORT);
      const out = openSync(MATCHMAKER_LOG, "a");
      // Its own .env still applies (MM_DATA_DIR, models, …); these win over it.
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
        },
      });
      this.child = child;
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        log(`matchmaker exited (${signal ?? code})`);
      });
      writeSvc("matchmaker", { pid: child.pid });
      log(`matchmaker started (pid ${child.pid}) on port ${port}; log at ${MATCHMAKER_LOG}`);
      if (!(await waitUntil(() => this.healthy(port), 60))) {
        throw new Error(`matchmaker did not answer on port ${port} — see ${MATCHMAKER_LOG}`);
      }
      return port;
    },
    stop() {
      if (this.child) this.child.kill("SIGTERM");
      this.child = null;
      // One left behind by a supervisor killed hard (recruiter-mcp: the server before this one).
      const stale = readState().svc?.matchmaker?.pid;
      if (isProcess(stale, /matchmaker-mcp|recruiter-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return { status: 0, stdout: "", stderr: "" };
    },
    // Its headers go on empty, so the user only fills in their values; a Worker older than
    // that ignores them.
    push: (tunnel) => ({
      route: "mcp",
      body: {
        name: "matchmaker",
        url: `${tunnel}/matchmaker/mcp`,
        headers: MATCHMAKER_HEADERS.map(([header]) => header),
      },
    }),
    reached: (tunnel) => `${tunnel}/matchmaker/mcp`,
  },

  analyst: {
    label: "analyst MCP",
    about: "Excel and CSV analysis (uv, no Docker)",
    log: ANALYST_LOG,
    docker: false,
    uv: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      readyMcp("analyst", ANALYST_SRC, ANALYST_BIN);
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
const isTunnel = (pid) => isProcess(pid, /cloudflared/i);

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
 * (a second `start`, the login item) used to keep running with its own tunnel.
 */
async function endStrays(except = 0) {
  const kill = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {}
  };
  const others = supervisorsOf(processList(), withTarget("_supervise"), except);
  for (const pid of others) kill(pid, "SIGTERM"); // each stops its own tunnel on the way out
  for (let i = 0; i < 20 && others.some(alive); i++) await sleep(250);
  for (const pid of others.filter(alive)) kill(pid, "SIGKILL");
  const orphans = orphanTunnels(processList());
  for (const pid of orphans) kill(pid, "SIGTERM");
  return others.length + orphans.length;
}

/**
 * The long-running half: keeps Docker, the services, the gateway and the tunnel up, and
 * the agent pointed at the tunnel.
 *
 * Every heartbeat walks the same list — Docker reachable, each service that is on
 * answering locally (and each that was turned off taken down), cloudflared alive, tunnel
 * answering from outside, agent holding the current address of each — and repairs what
 * is wrong. A laptop waking up on a new network, a killed cloudflared and a Docker that was
 * never started all end up at the same place.
 */
async function supervise() {
  mkdirSync(HOME, { recursive: true });
  try {
    if (statSync(LOG_FILE).size > 1_000_000) rmSync(LOG_FILE);
  } catch {}
  writeFileSync(PID_FILE, String(process.pid));

  // A sleeping Mac drops the tunnel and every service; stay awake while this runs.
  // `-w` ends caffeinate with this process, however it exits.
  if (IS_MAC) {
    spawn("caffeinate", caffeinateArgs(process.pid), { stdio: "ignore" })
      .on("error", (err) => log(`caffeinate: ${err.message}`))
      .unref();
  }

  // One supervisor and one tunnel per target: end any other, and any cloudflared left behind.
  const stale = readState().tunnelPid;
  if (isTunnel(stale)) process.kill(stale, "SIGTERM");
  const ended = await endStrays(process.pid);
  if (ended) log(`ended ${ended} stray supervisor/cloudflared process(es)`);

  let token = readToken();
  const { worker } = readState();
  if (!token || !agentIdsOf(readState()).length) {
    log(`not set up: run \`${SELF} ${withTarget("start")}\` in a terminal first`);
    writeState({ lastError: "not set up" });
    process.exit(1);
  }
  writeState({ url: "", lastError: "", supervisorStartedAt: new Date().toISOString() });

  /** Loopback port of each service that is on and answering; what the gateway routes to. */
  const ports = {};
  const gatewayPort = await portFrom(readState().gatewayPort, GATEWAY_PORT);
  await startGateway(gatewayPort, { token: () => token, routes: () => ports });
  writeState({ gatewayPort });
  log(`supervisor up (pid ${process.pid}) for ${agentsLabel(agentIdsOf(readState()))}; gateway on 127.0.0.1:${gatewayPort}`);

  let tunnel = null;
  let url = "";
  let publicFailures = 0;
  let tunnelStartedAt = 0;
  let busy = false;
  // A tick asked for while one runs (a new tunnel address, a manual restart) runs
  // straight after it rather than waiting out the heartbeat.
  let again = false;

  const startTunnel = () => {
    url = "";
    publicFailures = 0;
    tunnelStartedAt = Date.now();
    const child = spawn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${gatewayPort}`],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
    tunnel = child;
    writeState({ tunnelPid: child.pid, url: "" });
    log(`cloudflared started (pid ${child.pid}) -> 127.0.0.1:${gatewayPort}`);
    // cloudflared logs to stderr; a quick tunnel's address appears once, in a banner,
    // before the tunnel is connected. It is only used once connected and resolvable.
    let pending = "";
    let buf = "";
    const announce = async () => {
      const host = new URL(pending).host;
      pending = "";
      if (!(await resolvable(host))) log(`${host} still does not resolve; using it anyway`);
      if (tunnel !== child) return;
      url = `https://${host}`;
      writeState({ url, lastError: "" });
      log(`tunnel at ${url}`);
      tick();
    };
    child.stderr.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !url) pending = m[0];
        else if (pending && /Registered tunnel connection/.test(line)) announce();
        else if (/\s(ERR|FTL)\s/.test(line)) {
          const err = line.replace(/^\S+\s+(ERR|FTL)\s+/, "").trim();
          log(`cloudflared: ${err}`);
          writeState({ lastError: `cloudflared: ${err}` });
        }
      }
    });
    child.on("exit", (code, signal) => {
      if (tunnel === child) {
        tunnel = null;
        url = "";
        log(`cloudflared exited (${signal ?? code})`);
      }
    });
  };

  const stopTunnel = () => {
    const child = tunnel;
    tunnel = null;
    url = "";
    if (child) child.kill("SIGTERM");
  };

  const restartTunnel = async (why) => {
    log(`restarting the tunnel: ${why}`);
    stopTunnel();
    await sleep(1500);
    startTunnel();
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
          writeSvc(name, { up: false, pushedTo: "", agents: {}, error: "" });
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
    // Read each time, so agents added with `setup` are told on the next heartbeat.
    const { svc = {}, ...state } = readState();
    for (const name of Object.keys(ports)) {
      // Only the agents set to use this service; one switched off for it is left alone.
      const agentIds = agentsFor(state, name);
      // Agents that already have this address are not asked again while another refuses.
      const agents = { ...svc[name]?.agents };
      // Agents where the user removed this server: asked again each heartbeat (410 until
      // they add it back themselves), never counted as a failure.
      const removed = { ...svc[name]?.removed };
      if (svc[name]?.pushedTo === url && agentIds.every((id) => agents[id] === url)) continue;
      let status = 200;
      let agentId = "";
      for (const id of agentIds) {
        if (agents[id] === url) continue;
        const answer = await push(worker || DEFAULT_WORKER, id, token, SERVICES[name].push(url));
        if (answer === 200) {
          agents[id] = url;
          delete removed[id];
          log(`agent ${id}: ${name} now at ${SERVICES[name].reached(url)}`);
        } else if (answer === 410) {
          if (!removed[id]) log(`agent ${id}: ${name} was removed there; not adding it back`);
          removed[id] = true;
        } else if (status === 200) {
          status = answer;
          agentId = id;
        }
      }
      writeSvc(name, { agents, removed });
      if (status === 200) {
        writeSvc(name, { pushedTo: url, pushedAt: new Date().toISOString(), pushStatus: 200, error: "", failedAgent: "" });
        continue;
      }
      const why =
        status === 401
          ? `agent ${agentId} refused the token — paste it into that agent's SearXNG token field, or run \`${SELF} ${withTarget("setup")}\``
          : status === 409
            ? `agent ${agentId} already has an MCP server named "${name}" with a different Authorization header — delete it or set it to this token`
            : status === 0
              ? "could not reach the Worker (offline?)"
              : `the Worker answered ${status}`;
      writeSvc(name, { error: `push: ${why}`, pushStatus: status, failedAgent: agentId });
      log(`${name}: could not update agent ${agentId}: ${why}`);
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

      if (!tunnel) return startTunnel();
      if (!url) {
        if (Date.now() - tunnelStartedAt > TUNNEL_READY_MS) {
          return await restartTunnel(`no reachable address after ${TUNNEL_READY_MS / 1000}s`);
        }
        return;
      }

      if (await ok(`${url}/healthz`, token)) {
        publicFailures = 0;
      } else if (++publicFailures >= PUBLIC_FAILURES_BEFORE_RESTART) {
        return await restartTunnel(`${url} unreachable ${publicFailures} times in a row`);
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
    stopTunnel();
    stopChildren();
    try {
      rmSync(PID_FILE);
    } catch {}
    writeState({ url: "", tunnelPid: 0 });
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
      stopTunnel();
      const svc = readState().svc ?? {};
      for (const name of NAMES) svc[name] = { ...svc[name], pushedTo: "", agents: {} };
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
 * old supervisor and its ngrok are stopped, the agent and web
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
  if (isProcess(prev.ngrokPid, /ngrok/i)) process.kill(prev.ngrokPid, "SIGTERM");

  mkdirSync(HOME, { recursive: true });
  for (const file of ["token", "token.dpapi"]) {
    if (existsSync(path.join(old, file))) copyFileSync(path.join(old, file), path.join(HOME, file));
  }
  writeState({
    agentIds: prev.agentId ? [prev.agentId] : [],
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
  const { tunnelPid, svc } = readState();
  if (isTunnel(tunnelPid)) process.kill(tunnelPid, "SIGTERM");
  if (isProcess(svc?.matchmaker?.pid, /recruiter-mcp/i)) process.kill(svc.matchmaker.pid, "SIGTERM");
  if (isProcess(svc?.analyst?.pid, /analyst-mcp/i)) process.kill(svc.analyst.pid, "SIGTERM");
  return Boolean(pid || strays);
}

/**
 * Ask for `wanted` afresh. A supervisor with a tunnel picks them up on the same address;
 * otherwise a new supervisor starts. Returns its pid and when the ask was made.
 */
async function relaunch(pid, wanted) {
  const since = new Date().toISOString();
  for (const name of wanted) writeSvc(name, { pushedTo: "", agents: {}, pushStatus: 0, error: "" });
  if (pid && readState().url) {
    writeFileSync(RELOAD_FILE, since);
  } else {
    await stopSupervisor();
    writeState({ lastError: "" });
    pid = spawnSupervisor();
  }
  return { pid, since };
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
      if (e.pushStatus === 401 && e.error?.startsWith("push:")) {
        return { ok: false, state: s, refused: true, agentId: e.failedAgent };
      }
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
      `@echo off\r\nstart "salts-tools" /min ${LAUNCH.map((a) => `"${a}"`).join(" ")} ${withTarget("start")}\r\n`
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
ExecStart=${LAUNCH.map(q).join(" ")} ${withTarget("start")}
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
  // launchd starts with a bare PATH; docker, cloudflared and uv live wherever this shell found them.
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${LAUNCH.map((a) => `    <string>${esc(a)}</string>\n`).join("")}    <string>${withTarget("start")}</string>
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
  console.log(`
${BOLD}Token${OFF}  ${token}
${DIM}Paste it into each agent: Capabilities → Web search → SearXNG token, then save.
Leave the Brave key blank. Run \`salts-tools\` to copy it again later.${OFF}
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

  let agentIds = agentIdsOf(state);
  if (!agentIds.length || force) {
    for (;;) {
      const answer = await rl.question(
        `Agent IDs, space separated${agentIds.length ? ` ${DIM}[${agentIds.join(" ")}]${OFF}` : ""}: `
      );
      const typed = parseAgentIds(answer);
      if (typed.length) agentIds = typed;
      if (agentIds.length) break;
    }
  }
  // `agentId` (one agent) is what older versions wrote; the list replaces it.
  writeState({
    agentIds,
    agentId: undefined,
    worker: process.env.SALTS_TOOLS_WORKER || state.worker || DEFAULT_WORKER,
  });

  if (fresh) {
    showToken(token);
    await rl.question("Press Enter once it is saved in every agent… ");
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

/**
 * The headers the matchmaker's paid tools need on the agent's `matchmaker` MCP server,
 * beside the Authorization salts-tools sets. The cap (USD per tool call) is optional.
 */
const MATCHMAKER_HEADERS = [
  ["X-OpenRouter-Api-Key", "<your OpenRouter key>", "pays for its model calls"],
  ["Tool-Call-Max-Charge", "0.25", "most one call may spend; a judged page of 50 is ~$0.10"],
];
const ANALYST_INBOX = path.join(ANALYST_DIR, "data", "inbox");

/** One line per service and its address; what to set on the agent is in the dashboard. */
function report(state, names) {
  console.log(`${GREEN}✓${OFF} tunnel     ${state.url}`);
  for (const name of names) {
    console.log(`${GREEN}✓${OFF} ${name.padEnd(10)} ${SERVICES[name].reached(state.url)}`);
  }
  console.log(`${DIM}  live for ${agentsLabel(agentIdsOf(state))}${OFF}`);
  if (names.some((n) => n !== "web")) {
    console.log(`${DIM}  run \`salts-tools${SUFFIX ? ` :${TARGET}` : ""}\` and open a service for what to set on the agent${OFF}`);
  }
}

async function askAutostart(rl) {
  if (existsSync(AUTOSTART.file)) return;
  const yes = (await rl.question("Start salts-tools automatically when you log in? [Y/n] ")).trim().toLowerCase();
  if (yes === "" || yes === "y" || yes === "yes") {
    autostartOn();
    console.log(`${GREEN}✓${OFF} will start at login (undo with \`${SELF} ${withTarget("autostart")} off\`)`);
  }
}

/** `salts-tools setup`: the questions only. Nothing starts until `start`. */
async function setupOnly() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const before = agentIdsOf(readState()).join(" ");
    // No autostart question here: turning it on runs the login item at once.
    await setup(rl, { force: true });
    if (supervisorPid() && agentIdsOf(readState()).join(" ") !== before) {
      console.log(`salts-tools is running; ${agentsLabel(agentIdsOf(readState()))} get every address within a minute.`);
    } else if (!supervisorPid()) {
      console.log(`Set up. Start a service with \`${SELF} ${withTarget("start")} <${NAMES.join("|")}>\`.`);
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
    console.log(`${GREEN}✓${OFF} cloudflared installed`);

    // At login this runs unattended and Docker may be minutes away; the supervisor
    // waits for it there, so only a person at the terminal waits for it here.
    if (rl && usesDocker(services)) {
      await ensureDocker((m) => console.log(`${DIM}  … ${m}${OFF}`));
      console.log(`${GREEN}✓${OFF} Docker running`);
    }

    const firstRun = !readToken() || !agentIdsOf(readState()).length;
    if (firstRun && !rl) {
      console.error(`${RED}✗${OFF} not set up yet — run \`${SELF} ${withTarget("start")}\` in a terminal`);
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
      let since;
      ({ pid, since } = await relaunch(pid, wanted));
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
        console.log(`${RED}✗${OFF} agent ${result.agentId} refused the token.`);
        const choice = (
          await rl.question("[r] retry after pasting it in that agent, [n] make a new token, [q] quit: ")
        ).trim().toLowerCase();
        if (choice === "n") {
          showToken(newToken());
          await rl.question("Press Enter once it is saved in every agent… ");
        } else if (choice !== "r") {
          console.log(`The supervisor keeps retrying in the background; log at ${LOG_FILE}`);
          return;
        }
        continue;
      }
      const failed = result.pushFailed;
      if (failed && result.state.svc?.[failed]?.pushStatus === 409) {
        console.log(`${RED}✗${OFF} agent ${result.state.svc[failed].failedAgent} already has an MCP server "${failed}" that salts-tools did not set up.
${DIM}  In that agent's MCP servers, delete it (salts-tools re-adds it) or set its Authorization to [t].${OFF}`);
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
    const pid = stopOne(name, rest);
    for (let i = 0; i < 120 && pid && readState().svc?.[name]?.up && alive(pid); i++) await sleep(1000);
    console.log(`${GREEN}✓${OFF} ${name} stopped; still running: ${rest.join(", ")}`);
    return;
  }

  const { was, failed } = await stopAll();
  for (const line of failed) console.log(`${RED}✗${OFF} ${line}`);
  console.log(was ? `${GREEN}✓${OFF} stopped` : "was not running");
  if (existsSync(AUTOSTART.file)) console.log(`${DIM}  starts again at next login (autostart is on)${OFF}`);
}

/**
 * Turn `name` off, leaving `rest` on. A running supervisor takes it down on its next
 * pass (its pid is returned to wait on); with none, it is taken down here.
 */
function stopOne(name, rest) {
  writeState({ services: rest });
  const pid = supervisorPid();
  if (pid) {
    writeFileSync(RELOAD_FILE, new Date().toISOString());
  } else if (!SERVICES[name].docker || dockerUp()) {
    SERVICES[name].down();
    writeSvc(name, { up: false, pushedTo: "", agents: {} });
  }
  return pid;
}

/**
 * Everything: the supervisor, the tunnel and the containers. The list of services is
 * kept, so the next `start` brings them back. Returns whether anything was running and
 * a line for each service that would not go down.
 */
async function stopAll() {
  const was = await stopSupervisor();
  const failed = [];
  if (dockerUp()) {
    for (const name of NAMES) {
      const res = SERVICES[name].down();
      if (res.status !== 0) failed.push(`${name}: ${res.stderr.trim()}`);
    }
  }
  const svc = readState().svc ?? {};
  for (const name of NAMES) svc[name] = { ...svc[name], up: false, pushedTo: "", agents: {} };
  writeState({ url: "", svc });
  return { was, failed };
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
 * token, the state, the logs, the login item and salts-web's leftovers all go. The
 * matchmaker's people and jobs (files in local-mcps/matchmaker-mcp) are kept.
 */
function reset() {
  if (supervisorPid() || pidIn(path.join(homeFor("salts-web"), "supervisor.pid"))) {
    throw new Error(`salts-tools is running — \`${SELF} ${withTarget("stop")}\` first`);
  }
  const done = [];
  const where = tokenStoreName();
  if (deleteToken()) done.push(`deleted the token from ${where}`);
  for (const item of [AUTOSTART, autostartFor("salts-web")]) {
    if (!existsSync(item.file)) continue;
    autostartOff(item);
    done.push(`removed the login item ${item.file}`);
  }
  for (const dir of [HOME, homeFor("salts-web")]) {
    if (clearHome(dir)) done.push(`deleted ${dir}${SUFFIX ? "" : " (staging kept)"}`);
  }
  return done;
}

async function restart() {
  const pid = supervisorPid();
  if (!pid) {
    console.log("supervisor not running; starting it");
    return await start({ interactive: process.stdin.isTTY });
  }
  const since = await requestRestart(pid);
  const services = readState().services ?? [];
  console.log(`${DIM}  … restarting the tunnel${OFF}`);
  const result = await waitForPush(pid, since, services, 120_000);
  if (result.ok) report(result.state, services);
  else console.log(`${RED}✗${OFF} ${result.state.lastError || "no new tunnel yet"} — log at ${LOG_FILE}`);
}

/** Ask the running supervisor `pid` for a new tunnel, pushed again everywhere. Returns when. */
async function requestRestart(pid) {
  await endStrays(pid); // a stray's session would stop the new tunnel from opening
  const since = new Date().toISOString();
  for (const name of readState().services ?? []) writeSvc(name, { pushStatus: 0, error: "" });
  writeState({ lastError: "" });
  writeFileSync(RESTART_FILE, since);
  return since;
}

// ─── the dashboard ──────────────────────────────────────────────────────────────
//
// `salts-tools` with no command, in a terminal. Four tabs, each a list of rows, drawn
// the way admin-cli draws its own. Everything on screen is read back from state.json
// once a second, so it follows the supervisor as it works; the keys do what the
// commands above do, without their questions.
//
//   1 Services  each service, whether it is live, and its address; `enter` opens one:
//               where the agents reach it and what to set on the agent for it
//   2 Agents    the agents served, and whether each holds every address
//   3 Settings  the token, start at login, where things live, reset
//   4 Log       the supervisor's log, newest at the bottom

const TABS = ["Services", "Agents", "Settings", "Log"];

const ui = {
  tab: 0,
  pos: { 0: { sel: 0, top: 0 }, 1: { sel: 0, top: 0 }, 2: { sel: 0, top: 0 }, 3: { sel: 0, top: 0, tail: true } },
  /** The service opened from the Services tab, or "" while the list is showing. */
  open: "",
  openPos: { sel: 0, top: 0 },
  /** The agent opened from the Agents tab, or "" while the list is showing. */
  openAgent: "",
  openAgentPos: { sel: 0, top: 0 },
  /** Non-null while a value is being typed: `{ label, buffer, submit(text) }`. */
  edit: null,
  /** Non-null while a y/n is pending: `{ prompt, run() }`. */
  confirm: null,
  status: "",
  /** Whether the Settings tab shows the token in full. */
  reveal: false,
};

const say = (text) => {
  ui.status = text;
  render();
};

/** Put `text` on the clipboard, with whatever this machine has for it. */
function copy(text) {
  const tool = IS_MAC
    ? ["pbcopy", []]
    : IS_WIN
      ? ["clip", []]
      : have("wl-copy")
        ? ["wl-copy", []]
        : have("xclip")
          ? ["xclip", ["-selection", "clipboard"]]
          : null;
  return Boolean(tool) && run(tool[0], tool[1], { input: text, windowsHide: true }).status === 0;
}

function copyToken() {
  const token = readToken();
  if (!token) return say("no token yet: add an agent first");
  if (copy(token)) return say("token copied");
  ui.reveal = true;
  ui.tab = 2;
  say("no clipboard tool found; the token is shown in full here");
}

/** A running supervisor rereads state.json on its next pass; this makes that now. */
function nudge() {
  if (supervisorPid()) writeFileSync(RELOAD_FILE, new Date().toISOString());
}

function startEdit(label, value, submit) {
  ui.edit = { label, buffer: value, submit };
  say("");
}

function confirm(prompt, run) {
  ui.confirm = { prompt, run };
  say("");
}

function addAgents() {
  startEdit("agent ids, space separated (in the agent's address, after /a/):", "", (text) => {
    const added = parseAgentIds(text);
    if (!added.length) return say("");
    const state = readState();
    writeState({
      agentIds: [...new Set([...agentIdsOf(state), ...added])],
      agentId: undefined,
      worker: process.env.SALTS_TOOLS_WORKER || state.worker || DEFAULT_WORKER,
    });
    nudge();
    if (!readToken()) return freshToken();
    say(`added ${added.join(", ")}${supervisorPid() ? "; sending it every address" : ""}`);
  });
}

/** Switch one service on or off for one agent; the others keep theirs. */
function toggleAgentService(id, name) {
  const state = readState();
  const on = !servesAgent(state, id, name);
  writeState({ agentServices: toggleService(state, id, name, NAMES) });
  nudge();
  say(
    on
      ? `${name} on for ${id}${supervisorPid() ? "; sending it the address" : ""}`
      : `${name} off for ${id}: no longer sent its address (remove or switch the server off in the agent to stop using it)`
  );
}

function removeAgent(id) {
  confirm(`Stop serving agent ${id}?`, () => {
    const { [id]: _, ...agentServices } = readState().agentServices ?? {};
    writeState({ agentIds: agentIdsOf(readState()).filter((a) => a !== id), agentId: undefined, agentServices });
    say(`removed ${id}`);
  });
}

/** A new token, which every agent needs; every address is pushed again with it. */
function freshToken() {
  newToken();
  const svc = readState().svc ?? {};
  for (const name of NAMES) svc[name] = { ...svc[name], pushedTo: "", agents: {} };
  writeState({ svc });
  nudge();
  ui.reveal = true;
  ui.tab = 2;
  ui.pos[2].sel = 0;
  say("new token: paste it into each agent's Capabilities → Web search → SearXNG token, then save (c copies it)");
}

/** Whether a service can start yet; if not, opens what is missing. */
function readyToStart() {
  if (!agentIdsOf(readState()).length) {
    ui.tab = 1;
    addAgents();
    return false;
  }
  if (!readToken()) {
    freshToken();
    return false;
  }
  return true;
}

async function turnOn(name) {
  if (!readyToStart()) return;
  const pid = supervisorPid();
  const services = [...new Set([...(pid ? (readState().services ?? []) : []), name])];
  const problems = missingTools(services);
  if (problems.length) return say(paint(problems[0], "bad"));
  say(`starting ${name}…`);
  writeState({ services });
  if (pid) await endStrays(pid);
  await relaunch(pid, pid && readState().url ? [name] : services);
  say(`starting ${name}; this screen follows it`);
}

async function turnOff(name) {
  const rest = (readState().services ?? []).filter((n) => n !== name);
  if (rest.length) {
    stopOne(name, rest);
    return say(`stopping ${name}`);
  }
  await stopEverything();
}

async function stopEverything() {
  say("stopping…");
  const { was, failed } = await stopAll();
  say(failed.length ? paint(failed.join("; "), "bad") : was ? "stopped" : "was not running");
}

/** Whatever this machine logs in `file`, last lines only: the log can reach a megabyte. */
function tail(file, bytes = 64 * 1024) {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    return len < size ? lines.slice(1) : lines;
  } catch {
    return [];
  }
}

/** What to set on the agent for each service, beside the address salts-tools sends. */
function agentSetup(name) {
  if (name === "web") {
    return [
      ["on the agent", "Capabilities → Web search → SearXNG token", "paste the token there (c copies it); leave the Brave key blank, or the agent uses Brave"],
    ];
  }
  if (name === "matchmaker") {
    return [
      ["on the agent", "MCP servers → matchmaker → add the headers below", "Authorization is set already; headers stay when the address changes"],
      ...MATCHMAKER_HEADERS.map(([header, value, note]) => [
        header,
        value,
        `${note}; caps are the most one call may spend in USD, 0 blocks the tool`,
        header,
      ]),
    ];
  }
  return [
    ["on the agent", "Capabilities → File ingest and MCP on", "users can then attach .xlsx and .csv files in the chat"],
    ["inbox folder", ANALYST_INBOX, `files here are read too; DATA_DIR / INBOX_DIR in ${path.join(ANALYST_DIR, ".env")} move it`, ANALYST_INBOX],
    ["run_python", "off unless ALLOW_PYTHON=true", `set in ${path.join(ANALYST_DIR, ".env")}`],
  ];
}

/** A row whose `enter` copies `text`. */
const copyRow = (cells, text, note) => ({
  cells,
  note,
  enter: () => say(copy(text) ? `copied ${text}` : "no clipboard tool found"),
});

/**
 * What the current tab shows: its columns, its rows, where the selection is, and the
 * keys it answers to beyond moving and `enter`.
 */
function view() {
  const s = readState();
  const running = Boolean(supervisorPid());
  const agents = agentIdsOf(s);
  const on = (name) => running && (s.services ?? []).includes(name);

  switch (ui.tab) {
    case 0: {
      const name = ui.open;
      if (name) {
        const svc = SERVICES[name];
        const st = serviceStatus(s, name, running, agentsFor(s, name));
        const e = s.svc?.[name] ?? {};
        const live = on(name) && s.url;
        return {
          title: `${name}  ${DIM}${svc.about}${OFF}`,
          columns: [["", 34], ["", 0]],
          rows: [
            { cells: ["status", { text: st.label, tone: st.tone }], note: st.note },
            live
              ? copyRow(["address", svc.reached(s.url)], svc.reached(s.url), "where the agents reach it; salts-tools sends each new one")
              : { cells: ["address", { text: "not running", tone: "off" }] },
            { cells: ["local port", live && e.port ? `127.0.0.1:${e.port}` : "—"], note: "loopback only; the tunnel reaches it through the token gate" },
            ...agents.map((id) => ({
              cells: [
                `agent ${id}`,
                !servesAgent(s, id, name)
                  ? { text: "off for this agent", tone: "off" }
                  : live && e.agents?.[id] === s.url
                  ? { text: "has this address", tone: "good" }
                  : { text: live ? "not yet" : "—", tone: live ? "busy" : "off" },
              ],
            })),
            ...agentSetup(name).map(([label, value, note, copyText]) =>
              copyText ? copyRow([label, value], copyText, note) : { cells: [label, value], note }
            ),
            copyRow(["log", svc.log], svc.log),
          ],
          pos: ui.openPos,
          hint: `enter copy   s ${on(name) ? "stop" : "start"}   esc back`,
          keys: {
            s: () => (on(name) ? turnOff(name) : turnOn(name)),
            "\x1b": () => {
              ui.open = "";
              say("");
            },
          },
        };
      }
      return {
        columns: [["service", 12], ["status", 16], ["address", 0]],
        rows: NAMES.map((name) => {
          const st = serviceStatus(s, name, running, agentsFor(s, name));
          return {
            name,
            cells: [name, { text: st.label, tone: st.tone }, on(name) && s.url ? SERVICES[name].reached(s.url) : ""],
            note: st.note || SERVICES[name].about,
            enter: () => {
              ui.open = name;
              ui.openPos = { sel: 0, top: 0 };
              say("");
            },
          };
        }),
        pos: ui.pos[0],
        hint: `enter open   s start/stop${running ? "   r new tunnel   x stop all" : ""}`,
        keys: {
          s: (row) => row && (on(row.name) ? turnOff(row.name) : turnOn(row.name)),
          r: () => {
            const pid = supervisorPid();
            if (!pid) return say("nothing running");
            return requestRestart(pid).then(() => say("opening a new tunnel"));
          },
          x: () => running && confirm("Stop every service and the tunnel?", stopEverything),
        },
      };
    }

    case 1: {
      const id = ui.openAgent;
      if (id && agents.includes(id)) {
        const toggle = (row) => row && toggleAgentService(id, row.name);
        return {
          title: `agent ${id}`,
          columns: [["service", 12], ["for this agent", 18], ["", 0]],
          rows: NAMES.map((name) => {
            const chosen = servesAgent(s, id, name);
            const e = s.svc?.[name] ?? {};
            const state = !chosen ? "" : !on(name) ? "service not running" : e.removed?.[id] ? "removed in the agent" : e.agents?.[id] === s.url ? "has the address" : "not yet";
            return {
              name,
              cells: [name, chosen ? { text: "on", tone: "good" } : { text: "off", tone: "off" }, state],
              note: chosen
                ? `this agent gets ${name}'s address; enter switches it off for this agent only`
                : `this agent is not sent ${name}'s address; enter switches it on for this agent only`,
              enter: () => toggle({ name }),
            };
          }),
          pos: ui.openAgentPos,
          hint: "enter switch on/off   esc back",
          keys: {
            " ": toggle,
            "\x1b": () => {
              ui.openAgent = "";
              say("");
            },
          },
        };
      }
      return {
        columns: [["agent", 40], ["status", 0]],
        rows: agents.map((id) => {
          const st = agentStatus(s, id, running);
          return {
            id,
            cells: [id, { text: st.label, tone: st.tone }],
            note: st.note,
            enter: () => {
              ui.openAgent = id;
              ui.openAgentPos = { sel: 0, top: 0 };
              say("");
            },
          };
        }),
        pos: ui.pos[1],
        empty: "no agents yet: press a to add one",
        hint: "enter choose services   a add   x remove",
        keys: {
          a: addAgents,
          x: (row) => row && removeAgent(row.id),
        },
      };
    }

    case 2: {
      const token = readToken();
      const autostart = existsSync(AUTOSTART.file);
      return {
        columns: [["", 18], ["", 0]],
        rows: [
          {
            cells: ["token", token ? (ui.reveal ? token : `${"•".repeat(12)}${token.slice(-4)}`) : { text: "none yet", tone: "off" }],
            note: "goes in each agent's Capabilities → Web search → SearXNG token; enter shows it, c copies it, n makes a new one",
            enter: () => {
              ui.reveal = !ui.reveal;
              say("");
            },
          },
          {
            cells: ["start at login", autostart ? { text: "on", tone: "good" } : { text: "off", tone: "off" }],
            note: "a login item runs `salts-tools start`, which brings back the services that were on",
            enter: () => {
              if (autostart) autostartOff();
              else autostartOn();
              say(`start at login ${autostart ? "off" : "on"}`);
            },
          },
          { cells: ["worker", s.worker || DEFAULT_WORKER], note: `${TARGET}; SALTS_TOOLS_WORKER, set when adding agents, changes it` },
          { cells: ["token kept in", tokenStoreName()] },
          copyRow(["state and logs", HOME], HOME),
          {
            cells: ["reset", { text: "forget every agent and the token", tone: "bad" }],
            note: "stops everything, then back to a first run; the matchmaker's people and jobs are kept",
            enter: () =>
              confirm("Stop everything and forget every agent and the token?", async () => {
                if (supervisorPid()) await stopEverything();
                const done = reset();
                ui.reveal = false;
                say(done.length ? done.join("; ") : "nothing to reset");
              }),
          },
        ],
        pos: ui.pos[2],
        hint: "enter change   n new token",
        keys: {
          n: () => readToken() && confirm("Make a new token? Every agent will need it pasted in again.", freshToken),
        },
      };
    }

    default: {
      const pos = ui.pos[3];
      const rows = tail(LOG_FILE).map((line) => {
        const m = line.match(/^\d{4}-(\d\d-\d\dT\d\d:\d\d:\d\d)\S*\s(.*)$/);
        return { cells: m ? [m[1].replace("T", " "), m[2]] : ["", line] };
      });
      if (pos.tail) pos.sel = rows.length - 1;
      return {
        columns: [["", 15], ["", 0]],
        rows,
        pos,
        empty: "no log yet",
      };
    }
  }
}

function render() {
  const width = Math.max(40, (process.stdout.columns ?? 80) - 1);
  const size = Math.max(3, (process.stdout.rows ?? 24) - 12);
  const s = readState();
  const running = Boolean(supervisorPid());
  const v = view();
  const out = [];

  out.push(`${BOLD}salts-tools${OFF} ${DIM}${TARGET} · ${s.worker || DEFAULT_WORKER}${OFF}`);
  out.push(
    !running
      ? paint("  not running: pick a service and press s", "off")
      : s.url
        ? paint(`  tunnel ${s.url}`, "good")
        : paint(`  opening a tunnel…${s.lastError ? `  ${s.lastError}` : ""}`, s.lastError ? "bad" : "busy")
  );
  const agents = agentIdsOf(s);
  const trouble = [
    NAMES.some((n) => serviceStatus(s, n, running, agentsFor(s, n)).tone === "bad"),
    agents.some((id) => agentStatus(s, id, running).tone === "bad"),
  ];
  out.push(
    TABS.map((name, i) => {
      let label = ` ${i + 1} ${name}`;
      if (trouble[i]) label += " !";
      label += " ";
      return i === ui.tab ? `${INV}${BOLD}${label}${OFF}` : label;
    }).join(" ")
  );
  out.push(`${DIM}${"─".repeat(width)}${OFF}`);

  if (v.title) out.push(`${BOLD}  ${v.title}${OFF}`);
  if (v.columns.some(([t]) => t)) {
    out.push(`${DIM}  ${rowText(v.columns.map(([t]) => t), v.columns, width - 2)}${OFF}`);
  }

  const pos = v.pos;
  if (!v.rows.length) {
    out.push(`${DIM}  ${v.empty ?? ""}${OFF}`);
  } else {
    follow(pos, v.rows.length, size);
    v.rows.slice(pos.top, pos.top + size).forEach((row, i) => {
      const text = `  ${rowText(row.cells, v.columns, width - 2)}`;
      out.push(pos.top + i === pos.sel ? `${INV}${text}${OFF}` : text);
    });
    if (pos.top + size < v.rows.length) out.push(`${DIM}  ↓ more${OFF}`);
  }

  out.push(`${DIM}${"─".repeat(width)}${OFF}`);
  if (ui.edit) {
    // The cursor is drawn rather than moved: the screen is repainted whole on every
    // change, so a real cursor position would be lost on the next paint.
    out.push(`  ${BOLD}${ui.edit.label}${OFF} ${ui.edit.buffer}${INV} ${OFF}`);
    out.push(`${DIM}  enter save   esc cancel${OFF}`);
  } else if (ui.confirm) {
    out.push(`  ${BOLD}${ui.confirm.prompt}${OFF}`);
    out.push(`${DIM}  y confirm   any other key cancel${OFF}`);
  } else {
    // Two lines kept for the note, so the hints below do not jump as the selection moves.
    const note = wrap(v.rows[pos.sel]?.note ?? "", width - 2);
    for (let i = 0; i < 2; i++) out.push(note[i] ? `${DIM}  ${note[i]}${OFF}` : "");
    const hints = ["↑/↓ move", v.hint, "c copy token", "←/→ tab", "q quit"].filter(Boolean);
    out.push(`${DIM}  ${hints.join("   ")}${OFF}`);
  }
  if (ui.status) out.push(`  ${ui.status}`);

  process.stdout.write(`\x1b[H\x1b[2J${out.join("\n")}\n`);
}

/**
 * The line editor. Deliberately minimal — printable characters, backspace, enter,
 * esc — because the only thing typed is a few agent ids, usually pasted.
 */
async function onEditKey(key) {
  const edit = ui.edit;
  if (key === "\x1b") {
    ui.edit = null;
    return render();
  }
  if (key === "\r" || key === "\n") {
    ui.edit = null;
    return await edit.submit(edit.buffer);
  }
  if (key === "\x7f" || key === "\b") edit.buffer = edit.buffer.slice(0, -1);
  else if (key.length === 1 && key >= " ") edit.buffer += key;
  render();
}

function quit() {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  if (supervisorPid()) console.log(`salts-tools keeps running in the background. \`${SELF} ${withTarget("stop")}\` stops it.`);
  process.exit(0);
}

function switchTab(tab) {
  ui.tab = (tab + TABS.length) % TABS.length;
  say("");
}

async function onKey(key) {
  if (key === "\u0003") quit();
  if (ui.edit) return await onEditKey(key);
  if (ui.confirm) {
    const { run } = ui.confirm;
    ui.confirm = null;
    if (key === "y" || key === "Y") return await run();
    return say("cancelled");
  }
  if (key === "q") quit();

  if (key >= "1" && key <= String(TABS.length)) return switchTab(Number(key) - 1);
  if (key === "\x1b[C" || key === "\t" || key === "l") return switchTab(ui.tab + 1);
  if (key === "\x1b[D" || key === "\x1b[Z" || key === "h") return switchTab(ui.tab - 1);
  if (key === "c") return copyToken();

  const v = view();
  const row = v.rows[v.pos.sel];
  if (key === "\x1b[A" || key === "k") {
    v.pos.sel = Math.max(0, v.pos.sel - 1);
    v.pos.tail = false;
  } else if (key === "\x1b[B" || key === "j") {
    v.pos.sel = Math.max(0, Math.min(v.rows.length - 1, v.pos.sel + 1));
    v.pos.tail = v.pos.sel === v.rows.length - 1;
  } else if ((key === "\r" || key === "\n") && row?.enter) {
    ui.status = "";
    return await row.enter();
  } else if (v.keys?.[key]) return await v.keys[key](row);
  render();
}

function dashboard() {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  if (!agentIdsOf(readState()).length) {
    ui.tab = 1;
    addAgents();
  } else {
    render();
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    for (const key of keys(chunk)) {
      try {
        await onKey(key);
      } catch (err) {
        say(paint(err.message, "bad"));
      }
    }
  });
  process.stdout.on("resize", render);
  process.on("SIGINT", quit);
  // The supervisor works in the background; repaint so the screen keeps up with it.
  setInterval(render, 1000);
}

const usage = `${BOLD}salts-tools${OFF}                 open the dashboard
${BOLD}salts-tools start${OFF} [service…]  start services (${NAMES.join(", ")})
${BOLD}salts-tools stop${OFF} [service]    stop one service, or everything
${BOLD}salts-tools restart${OFF}           open a new tunnel
${BOLD}salts-tools setup${OFF}             ask for the agent ids again
${BOLD}salts-tools reset${OFF}             forget the agents and the token
${BOLD}salts-tools autostart${OFF} on|off  start at login

Add :staging to any of them (\`salts-tools :staging\`, \`start:staging\`) for the staging Worker.`;

try {
  // Not before `reset`: it deletes salts-web's leftovers rather than moving them.
  if (cmd !== "_supervise" && cmd !== "reset") await migrateFromSaltsWeb();
  switch (cmd) {
    case "":
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(usage);
        break;
      }
      dashboard();
      break;
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
    case "reset": {
      const done = reset();
      for (const line of done) console.log(`${GREEN}✓${OFF} ${line}`);
      if (!done.length) console.log("nothing to reset");
      break;
    }
    case "autostart":
      if (args[0] === "on") autostartOn();
      else if (args[0] === "off") autostartOff();
      else throw new Error(`autostart on|off`);
      console.log(`${GREEN}✓${OFF} autostart ${args[0]}`);
      break;
    case "_supervise":
      await supervise();
      break;
    case "help":
      console.log(usage);
      break;
    default:
      console.log(usage);
      process.exit(1);
  }
} catch (err) {
  console.error(`${RED}✗${OFF} ${err.message}`);
  process.exit(1);
}
