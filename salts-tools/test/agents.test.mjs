import assert from "node:assert/strict";
import { test } from "node:test";

import { agentIdsOf, agentsFor, agentsLabel, parseAgentIds, servesAgent, toggleService } from "../agents.mjs";

test("parseAgentIds splits on spaces and commas and drops duplicates", () => {
  assert.deepEqual(parseAgentIds("  a1  b2,c3 a1 "), ["a1", "b2", "c3"]);
  assert.deepEqual(parseAgentIds(""), []);
});

test("agentIdsOf reads the list, or the single id an older state file holds", () => {
  assert.deepEqual(agentIdsOf({ agentIds: ["a", "b"], agentId: "old" }), ["a", "b"]);
  assert.deepEqual(agentIdsOf({ agentId: "old" }), ["old"]);
  assert.deepEqual(agentIdsOf({}), []);
});

test("agentsLabel says agent or agents", () => {
  assert.equal(agentsLabel(["a"]), "agent a");
  assert.equal(agentsLabel(["a", "b"]), "agents a, b");
});

test("an agent with no services chosen gets every one; a chosen list narrows it", () => {
  const state = { agentIds: ["a", "b"], agentServices: { b: ["web"] } };
  assert.equal(servesAgent(state, "a", "matchmaker"), true);
  assert.equal(servesAgent(state, "b", "matchmaker"), false);
  assert.deepEqual(agentsFor(state, "matchmaker"), ["a"]);
  assert.deepEqual(agentsFor(state, "web"), ["a", "b"]);
});

test("toggleService switches one service for one agent and keeps the order", () => {
  const all = ["web", "matchmaker", "analyst"];
  const state = { agentIds: ["a", "b"], agentServices: { b: ["web"] } };
  assert.deepEqual(toggleService(state, "a", "matchmaker", all), { a: ["web", "analyst"], b: ["web"] });
  assert.deepEqual(toggleService(state, "b", "analyst", all), { b: ["web", "analyst"] });
  assert.deepEqual(toggleService(state, "b", "web", all), { b: [] });
});
