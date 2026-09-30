import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { startGateway } from "../gateway.mjs";

/** An upstream that echoes what reached it. */
function echo() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, auth: req.headers.authorization }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("gateway", () => {
  const TOKEN = "t".repeat(64);
  let web, gateway, base;

  before(async () => {
    web = await echo();
    gateway = await startGateway(0, { token: () => TOKEN, routes: () => ({ web: web.address().port }) });
    base = `http://127.0.0.1:${gateway.address().port}`;
  });
  after(() => {
    web.close();
    gateway.close();
  });

  const get = (path, token = TOKEN) =>
    fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("refuses a request without the token", async () => {
    assert.equal((await get("/web/search", "")).status, 401);
    assert.equal((await get("/healthz", "wrong")).status, 401);
  });

  it("answers its own health check", async () => {
    assert.equal((await get("/healthz")).status, 200);
  });

  it("routes by the first segment, strips it, and passes the token on", async () => {
    const body = await (await get("/web/search?q=a&format=json")).json();
    assert.equal(body.path, "/search?q=a&format=json");
    assert.equal(body.host, `127.0.0.1:${web.address().port}`);
    assert.equal(body.auth, `Bearer ${TOKEN}`);
  });

  it("404s a service that is not running", async () => {
    assert.equal((await get("/matchmaker/mcp")).status, 404);
  });
});
