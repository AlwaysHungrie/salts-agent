// The one door the tunnel opens onto. Every service shares the ngrok address and is told
// apart by the first path segment: `/web/search` reaches SearXNG as `/search`,
// `/matchmaker/mcp` reaches the matchmaker as `/mcp`.
//
// Nothing gets past without `Authorization: Bearer <token>`. The header is passed on
// unchanged, so each service checks the same token again behind it.

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

/** Equal strings, compared in time that does not depend on where they first differ. */
function sameSecret(a, b) {
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Listen on 127.0.0.1:`port`. `token()` and `routes()` are read on every request, so a
 * replaced token or a service coming up or going down applies straight away.
 * `routes()` maps a service name to the loopback port it answers on.
 */
export function startGateway(port, { token, routes }) {
  const server = http.createServer((req, res) => {
    const reply = (status, text) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(text);
    };
    const expected = token();
    if (!expected || !sameSecret(req.headers.authorization ?? "", `Bearer ${expected}`)) {
      return reply(401, "unauthorized");
    }
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname === "/healthz") return reply(200, "ok");

    const m = url.pathname.match(/^\/([a-z0-9-]+)(\/.*)?$/);
    const target = m ? routes()[m[1]] : 0;
    if (!target) return reply(404, "no such service");

    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target,
        method: req.method,
        path: `${m[2] ?? "/"}${url.search}`,
        // The services only answer to a loopback Host (the MCP SDK refuses any other).
        headers: { ...req.headers, host: `127.0.0.1:${target}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) reply(502, `${m[1]} is not answering`);
      else res.destroy();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
