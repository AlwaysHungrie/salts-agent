// Puts an MCP server that only speaks stdio on loopback HTTP, the way the gateway reaches
// every other service: `POST /mcp` carries one JSON-RPC message and gets its answer back
// as JSON, `GET /healthz` says whether the server is running.
//
// One stdio server serves every caller. Request ids are swapped for the bridge's own, so
// two callers' `1`s cannot collide. `initialize` runs once: later callers get the same
// answer, and their `notifications/initialized` goes no further. Anything the server asks
// of the client (sampling, elicitation) is refused; none of the bridge's callers can answer.
//
// The token is checked here too, as every service behind the gateway does.

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

/** Equal strings, compared in time that does not depend on where they first differ. */
function sameSecret(a, b) {
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const MAX_BODY = 4 * 1024 * 1024;

/**
 * Run `command args` and listen on 127.0.0.1:`port` (0 picks one). `output` takes the
 * server's stderr. Resolves to `{ server, child, close() }` once listening.
 */
export function startStdioBridge({ command, args = [], env, cwd, port, token, output, timeoutMs = 120_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", output ?? "ignore"], windowsHide: true });
  let alive = true;
  let nextId = 1;
  /** Bridge id → what to do with the answer. */
  const pending = new Map();
  /** The first `initialize` answer, reused for every later one. */
  let initialized;
  let initializedSent = false;

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const fail = (entry, message) => {
    clearTimeout(entry.timer);
    entry.resolve({ jsonrpc: "2.0", id: entry.id, error: { code: -32603, message } });
  };

  child.on("exit", () => {
    alive = false;
    for (const entry of pending.values()) fail(entry, "the MCP server stopped");
    pending.clear();
  });
  child.stdin.on("error", () => {});

  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method !== undefined) {
        // The server asking the client something: say no, so it does not wait forever.
        if (message.id !== undefined) {
          write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported over this bridge" } });
        }
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve({ ...message, id: entry.id });
    }
  });

  /** Send one request to the server and wait for its answer, under the caller's id. */
  const ask = (message) =>
    new Promise((resolve) => {
      const id = nextId++;
      const entry = { id: message.id, resolve };
      entry.timer = setTimeout(() => {
        pending.delete(id);
        fail(entry, "the MCP server did not answer in time");
      }, timeoutMs);
      pending.set(id, entry);
      write({ ...message, id });
    });

  async function answer(message) {
    if (message.id === undefined) {
      if (message.method === "notifications/initialized") {
        if (initializedSent) return undefined;
        initializedSent = true;
      }
      write(message);
      return undefined;
    }
    if (message.method === "initialize") {
      if (initialized) return { ...initialized, id: message.id };
      const reply = await ask(message);
      if (reply.result !== undefined) initialized = reply;
      return reply;
    }
    return ask(message);
  }

  const server = http.createServer((req, res) => {
    const reply = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://bridge");
    if (url.pathname === "/healthz") return alive ? reply(200, "ok", "text/plain") : reply(503, "stopped", "text/plain");
    if (!token || !sameSecret(req.headers.authorization ?? "", `Bearer ${token}`)) {
      return reply(401, "unauthorized", "text/plain");
    }
    if (url.pathname !== "/mcp") return reply(404, "not found", "text/plain");
    if (req.method !== "POST") return reply(405, "POST only", "text/plain");
    if (!alive) return reply(503, "the MCP server is not running", "text/plain");

    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", async () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
        return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "one JSON-RPC request per POST" } });
      }
      const result = await answer(message);
      if (result === undefined) {
        res.writeHead(202);
        return res.end();
      }
      reply(200, result);
    });
  });

  const close = () => {
    server.close();
    if (alive) child.kill("SIGTERM");
  };

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      child.kill("SIGTERM");
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve({ server, child, close }));
  });
}
