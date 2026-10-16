import assert from "node:assert/strict";
import { test } from "node:test";

import { openCommand, toolsReport, waitForApproval, wantedServices } from "../computer.mjs";

const SERVICES = {
  web: { kind: "searxng", label: "Web search", needs: ["cap_web_search"] },
  matchmaker: { kind: "mcp", label: "Matchmaker", headers: ["X-OpenRouter-Api-Key"], needs: ["cap_mcp"] },
  analyst: { kind: "mcp", label: "Spreadsheet analyst", needs: ["cap_mcp", "cap_file_ingest"] },
};

test("the report says what each tool is, and whether it is ready, starting, off, failed or missing", () => {
  const report = toolsReport(SERVICES, {
    wanted: ["web", "matchmaker"],
    missing: { analyst: "install uv" },
    svc: { matchmaker: { error: "" } },
    ports: { web: 8180 },
  });
  assert.equal(report.web.state, "ready");
  assert.equal(report.web.kind, "searxng");
  assert.deepEqual(report.web.needs, ["cap_web_search"]);
  assert.equal(report.matchmaker.state, "starting");
  assert.deepEqual(report.matchmaker.headers, ["X-OpenRouter-Api-Key"]);
  assert.deepEqual([report.analyst.state, report.analyst.detail], ["missing", "install uv"]);

  const failed = toolsReport(SERVICES, { wanted: ["web"], missing: {}, svc: { web: { error: "boom" } }, ports: {} });
  assert.deepEqual([failed.web.state, failed.web.detail], ["failed", "boom"]);
  assert.equal(failed.matchmaker.state, "off");
});

test("only services this CLI knows are run, whatever the Worker asks for", () => {
  assert.deepEqual(wantedServices({ wanted: ["web", "nope", "analyst"] }, ["web", "matchmaker", "analyst"]), [
    "web",
    "analyst",
  ]);
  assert.deepEqual(wantedServices({}, ["web"]), []);
});

test("waiting for approval returns the credential, or nothing once the code is gone", async (t) => {
  const answers = [{ status: "pending" }, { status: "approved", credential: "salts_c_x" }];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(answers.shift())));
  const pairing = { device_code: "d", expires_in: 60, interval: 0 };
  assert.equal(await waitForApproval("https://w.test", pairing, { sleep: async () => {} }), "salts_c_x");

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: "gone" })));
  assert.equal(await waitForApproval("https://w.test", pairing, { sleep: async () => {} }), undefined);
});

test("the browser opens with each platform's own command", () => {
  assert.deepEqual(openCommand("https://x", "darwin"), ["open", ["https://x"]]);
  assert.deepEqual(openCommand("https://x", "linux"), ["xdg-open", ["https://x"]]);
  assert.equal(openCommand("https://x", "win32")[0], "cmd");
});
