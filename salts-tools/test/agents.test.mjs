import assert from "node:assert/strict";
import { test } from "node:test";

import { agentIdsOf, agentsLabel, parseAgentIds } from "../agents.mjs";

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
