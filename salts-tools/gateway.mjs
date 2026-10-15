// The one door the tunnel opens onto. Every service shares the tunnel address and is told
// apart by the first path segment: `/web/search` reaches SearXNG as `/search`,
// `/matchmaker/mcp` reaches the matchmaker as `/mcp`.
//
// Nothing gets past without `Authorization: Bearer <token>`, except a share link
// (`/<service>/share/…`): it opens in a browser, which has no token, and carries its own
// signature that the service checks. Every service checks the token again behind the
// gateway, so a service without share links still refuses one.
//
// The header is passed on unchanged, with the address the request came in on
// (X-Forwarded-Host, -Proto, -Prefix), so a service can write links back to itself.

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

/** Equal strings, compared in time that does not depend on where they first differ. */
function sameSecret(a, b) {
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** A signed link a service hands out to open in a browser; see the top of this file. */
const SHARE = /^\/[a-z0-9-]+\/share\//;

/** https behind the tunnel (cloudflared says so, or the Host is not this machine), http on loopback. */
function forwardedProto(req) {
  const said = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  if (said === "http" || said === "https") return said;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "") ? "http" : "https";
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
    const url = new URL(req.url ?? "/", "http://gateway");
    const share = SHARE.test(url.pathname) && (req.method === "GET" || req.method === "POST");
    const expected = token();
    if (!share && (!expected || !sameSecret(req.headers.authorization ?? "", `Bearer ${expected}`))) {
      return reply(401, "unauthorized");
    }
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
        headers: {
          ...req.headers,
          host: `127.0.0.1:${target}`,
          "x-forwarded-host": req.headers.host ?? "",
          "x-forwarded-proto": forwardedProto(req),
          "x-forwarded-prefix": `/${m[1]}`,
        },
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
