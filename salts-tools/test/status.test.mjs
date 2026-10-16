import assert from "node:assert/strict";
import { test } from "node:test";

import { connectionStatus, serviceStatus } from "../status.mjs";

const URL = "https://a-b.trycloudflare.com";

test("a running service is live when an agent uses it, and live · not in use otherwise", () => {
  const state = { services: ["web"], url: URL, svc: { web: { up: true }, matchmaker: { up: true } } };
  const live = serviceStatus(state, "web", true);
  assert.equal(live.label, "live");
  assert.equal(live.tone, "good");
  const unused = serviceStatus(state, "matchmaker", true);
  assert.equal(unused.label, "live · not in use");
  assert.match(unused.note, /Agents tab/);
});

test("on the way up a service is starting, and with no supervisor it is stopped", () => {
  assert.equal(serviceStatus({ svc: { web: { up: false } } }, "web", true).label, "starting");
  assert.equal(serviceStatus({ url: "", svc: { web: { up: true } } }, "web", true).label, "starting");
  assert.equal(serviceStatus({ url: URL, svc: { web: { up: true } } }, "web", false).label, "stopped");
});

test("something missing to run it, or a failure, is an error that says why", () => {
  const missing = serviceStatus({ tools: { web: { state: "missing", detail: "install Docker" } } }, "web", true);
  assert.equal(missing.label, "error");
  assert.match(missing.note, /install Docker/);
  const failed = serviceStatus({ url: URL, svc: { analyst: { up: false, error: "uv sync failed" } } }, "analyst", true);
  assert.deepEqual([failed.label, failed.note], ["error", "uv sync failed"]);
});

test("the connection reads disconnected, connecting, can't report or connected", () => {
  assert.equal(connectionStatus({ unpaired: true }, true).label, "disconnected");
  assert.equal(connectionStatus({}, false).label, "not running");
  assert.equal(connectionStatus({}, true).label, "connecting");
  assert.equal(connectionStatus({ reportedAt: "x", reportError: "offline" }, true).tone, "busy");
  assert.equal(connectionStatus({ reportedAt: "x" }, true).label, "connected");
});
