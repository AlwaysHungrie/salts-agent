import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { startGateway } from "../gateway.mjs";

/** An upstream that echoes what reached it. */
function echo() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        path: req.url,
        host: req.headers.host,
        auth: req.headers.authorization,
        forwarded: [
          req.headers["x-forwarded-proto"],
          req.headers["x-forwarded-host"],
          req.headers["x-forwarded-prefix"],
        ],
      })
    );
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

  it("tells the service the address the request came in on", async () => {
    const body = await (await get("/web/search")).json();
    assert.deepEqual(body.forwarded, ["http", `127.0.0.1:${gateway.address().port}`, "/web"]);
    // fetch will not send another Host, so this one goes by hand, as cloudflared's would arrive.
    const tunnelled = await new Promise((resolve, reject) => {
      const req = http.get(
        `${base}/web/search`,
        { headers: { authorization: `Bearer ${TOKEN}`, host: "abc.trycloudflare.com" } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }
      );
      req.on("error", reject);
    });
    assert.deepEqual(tunnelled.forwarded, ["https", "abc.trycloudflare.com", "/web"]);
  });

  it("lets a share link through without the token, for the service to check", async () => {
    const res = await get("/web/share/abc/f/cv.pdf", "");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).path, "/share/abc/f/cv.pdf");
    assert.equal((await get("/web/shared", "")).status, 401);
    assert.equal((await get("/web/x/share/abc", "")).status, 401);
    assert.equal((await get("/web/share/../search", "")).status, 401);
    const put = await fetch(`${base}/web/share/abc`, { method: "PUT" });
    assert.equal(put.status, 401);
  });

  it("404s a service that is not running", async () => {
    assert.equal((await get("/matchmaker/mcp")).status, 404);
  });
});
