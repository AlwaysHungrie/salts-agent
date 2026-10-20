import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startStdioBridge } from "../stdio-bridge.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "stdio-mcp.mjs");

describe("stdio bridge", () => {
  const TOKEN = "b".repeat(64);
  let bridge, base;

  before(async () => {
    bridge = await startStdioBridge({ command: process.execPath, args: [FAKE], port: 0, token: TOKEN, timeoutMs: 300 });
    base = `http://127.0.0.1:${bridge.server.address().port}`;
  });
  after(() => bridge.close());

  const post = (body, token = TOKEN) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const call = async (id, name) =>
    (await (await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name } })).json()).result;

  it("answers /healthz without a token while the server runs", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });

  it("refuses a request without the token", async () => {
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status, 401);
  });

  it("answers under the caller's id, whatever id the server saw", async () => {
    const res = await post({ jsonrpc: "2.0", id: "mine", method: "tools/call", params: { name: "x" } });
    const body = await res.json();
    assert.equal(body.id, "mine");
    assert.notEqual(body.result.seenId, "mine");
    assert.deepEqual(body.result.echo, { name: "x" });
  });

  it("keeps two callers' equal ids apart", async () => {
    const [a, b] = await Promise.all([
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a" } }).then((r) => r.json()),
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "b" } }).then((r) => r.json()),
    ]);
    assert.deepEqual([a.result.echo.name, b.result.echo.name], ["a", "b"]);
  });

  it("initializes the server once, however many callers do", async () => {
    for (const id of [1, 2]) {
      const res = await post({ jsonrpc: "2.0", id, method: "initialize", params: {} });
      const body = await res.json();
      assert.equal(body.id, id);
      assert.equal(body.result.instructions, "be kind");
      assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    }
    assert.deepEqual(await call(3, "stats"), { initializes: 1, notified: 1 });
  });

  it("refuses what the server asks of the client, so it does not wait", async () => {
    assert.deepEqual(await call(4, "ask_client"), { refused: -32601 });
  });

  it("gives up on an answer that never comes", async () => {
    const res = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "never" } });
    const body = await res.json();
    assert.equal(body.id, 5);
    assert.match(body.error.message, /did not answer in time/);
  });

  it("refuses a body that is not one JSON-RPC request", async () => {
    assert.equal((await post("nope")).status, 400);
    assert.equal((await post([{ jsonrpc: "2.0", id: 1, method: "x" }])).status, 400);
  });

  it("says it has stopped once the server exits", async () => {
    bridge.child.kill("SIGTERM");
    await new Promise((resolve) => bridge.child.once("exit", resolve));
    assert.equal((await fetch(`${base}/healthz`)).status, 503);
    assert.equal((await post({ jsonrpc: "2.0", id: 6, method: "tools/list" })).status, 503);
  });
});
