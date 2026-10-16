import assert from "node:assert/strict";
import { test } from "node:test";

import { connectionStatus, serviceStatus } from "../status.mjs";

const URL = "https://a-b.trycloudflare.com";
const APP = "https://app.test/salts-tools";

test("a service no agent uses, or with no supervisor, is off and says where to switch it on", () => {
  const state = { services: ["web"], url: URL, svc: { web: { up: true } } };
  const unused = serviceStatus(state, "matchmaker", true, APP);
  assert.equal(unused.label, "off");
  assert.match(unused.note, /app\.test/);
  assert.equal(serviceStatus(state, "web", false, APP).label, "off");
});

test("a service walks starting → opening tunnel → live", () => {
  const base = { services: ["web"] };
  assert.equal(serviceStatus({ ...base, svc: { web: { up: false } } }, "web", true, APP).label, "starting");
  assert.equal(serviceStatus({ ...base, url: "", svc: { web: { up: true } } }, "web", true, APP).label, "opening tunnel");
  const st = serviceStatus({ ...base, url: URL, svc: { web: { up: true } } }, "web", true, APP);
  assert.equal(st.label, "live");
  assert.equal(st.tone, "good");
});

test("something missing to run it is shown even when it is off", () => {
  const state = { services: [], tools: { web: { state: "missing", detail: "install Docker" } } };
  const st = serviceStatus(state, "web", true, APP);
  assert.equal(st.label, "missing");
  assert.equal(st.note, "install Docker");
});

test("a failing service says why", () => {
  const state = { services: ["analyst"], url: URL, svc: { analyst: { up: false, error: "uv sync failed" } } };
  assert.equal(serviceStatus(state, "analyst", true, APP).note, "uv sync failed");
});

test("the connection reads disconnected, connecting, can't report or connected", () => {
  assert.equal(connectionStatus({ unpaired: true }, true).label, "disconnected");
  assert.equal(connectionStatus({}, false).label, "not running");
  assert.equal(connectionStatus({}, true).label, "connecting");
  assert.equal(connectionStatus({ reportedAt: "x", reportError: "offline" }, true).tone, "busy");
  assert.equal(connectionStatus({ reportedAt: "x" }, true).label, "connected");
});
