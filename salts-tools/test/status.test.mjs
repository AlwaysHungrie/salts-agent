import assert from "node:assert/strict";
import { test } from "node:test";

import { agentStatus, serviceStatus } from "../status.mjs";

const URL = "https://a-b.trycloudflare.com";
const live = (agents) => ({ up: true, port: 8180, pushedTo: URL, agents });

test("a service that is not on, or with no supervisor, is off", () => {
  const state = { services: ["web"], url: URL, svc: { web: live({ a: URL }) } };
  assert.equal(serviceStatus(state, "matchmaker", true, ["a"]).label, "off");
  assert.equal(serviceStatus(state, "web", false, ["a"]).label, "off");
});

test("a service walks starting → opening tunnel → connecting → live", () => {
  const base = { services: ["web"] };
  assert.equal(serviceStatus({ ...base, svc: { web: { up: false } } }, "web", true, ["a"]).label, "starting");
  assert.equal(serviceStatus({ ...base, url: "", svc: { web: { up: true } } }, "web", true, ["a"]).label, "opening tunnel");
  const half = { ...base, url: URL, svc: { web: live({ a: URL }) } };
  assert.deepEqual(serviceStatus(half, "web", true, ["a", "b"]).label, "connecting 1/2");
  const st = serviceStatus(half, "web", true, ["a"]);
  assert.equal(st.label, "live");
  assert.equal(st.tone, "good");
});

test("a refused push names the agent and what to do", () => {
  const svc = (pushStatus) => ({
    services: ["matchmaker"],
    url: URL,
    svc: { matchmaker: { up: true, error: "push: …", pushStatus, failedAgent: "b" } },
  });
  const refused = serviceStatus(svc(401), "matchmaker", true, ["a", "b"]);
  assert.equal(refused.label, "token refused");
  assert.equal(refused.tone, "bad");
  assert.match(refused.note, /agent b/);
  assert.match(serviceStatus(svc(409), "matchmaker", true, ["b"]).note, /MCP server "matchmaker"/);
  assert.equal(serviceStatus(svc(404), "matchmaker", true, ["b"]).label, "worker too old");
  assert.equal(serviceStatus(svc(0), "matchmaker", true, ["b"]).tone, "busy");
});

test("a service that failed to come up shows its error", () => {
  const state = { services: ["web"], svc: { web: { up: false, error: "Docker did not come up within 180s" } } };
  const st = serviceStatus(state, "web", true, ["a"]);
  assert.equal(st.label, "failing");
  assert.equal(st.note, "Docker did not come up within 180s");
});

test("an agent is connected once it holds every service's current address", () => {
  const state = {
    services: ["web", "analyst"],
    url: URL,
    svc: { web: live({ a: URL, b: URL }), analyst: live({ a: URL }) },
  };
  assert.equal(agentStatus(state, "a", true).label, "connected");
  const b = agentStatus(state, "b", true);
  assert.equal(b.label, "connecting 1/2");
  assert.equal(b.note, "has web");
  assert.equal(agentStatus(state, "a", false).label, "nothing running");
});

test("only the agent that refused is marked as refusing", () => {
  const state = {
    services: ["web"],
    url: URL,
    svc: { web: { up: true, agents: { a: URL }, error: "push: …", pushStatus: 401, failedAgent: "b" } },
  };
  assert.equal(agentStatus(state, "a", true).label, "connected");
  assert.equal(agentStatus(state, "b", true).label, "token refused");
});
