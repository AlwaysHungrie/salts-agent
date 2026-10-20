import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WALLET_BASE, installCoinbaseWallet, patchVersions } from "../coinbase-wallet.mjs";

test("patchVersions steps back through the patch releases of a version", () => {
  assert.deepEqual(patchVersions("2.12.2"), ["2.12.2", "2.12.1", "2.12.0"]);
  assert.deepEqual(patchVersions("1.0.9", 2), ["1.0.9", "1.0.8"]);
  assert.deepEqual(patchVersions("latest"), []);
});

/** Coinbase's download server, with only the zips in `have`. */
const coinbase = (latest, have) => async (url) => {
  if (url === `${WALLET_BASE}/api/version`) return Response.json({ version: latest });
  const v = url.match(/payments-mcp-v(.+)\.zip$/)?.[1];
  return have.includes(v) ? new Response(`zip ${v}`) : new Response("Not Found", { status: 404 });
};
const done = { status: 0, stdout: "", stderr: "" };

test("installs the newest release whose zip exists, skipping a missing one", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "wallet-test-")), ".payments-mcp");
  const calls = [];
  const version = await installCoinbaseWallet({
    dir,
    fetchImpl: coinbase("2.12.2", ["2.12.1", "2.12.0"]),
    extract: (zip, into) => {
      calls.push(["extract", existsSync(zip), into]);
      return done;
    },
    npmInstall: (into) => {
      calls.push(["npm", into]);
      return done;
    },
  });
  assert.equal(version, "2.12.1");
  assert.deepEqual(calls, [
    ["extract", true, dir],
    ["npm", dir],
  ]);
});

test("says which versions it tried when none downloads", async () => {
  await assert.rejects(
    installCoinbaseWallet({ dir: os.tmpdir(), fetchImpl: coinbase("3.0.1", []), extract: () => done, npmInstall: () => done }),
    /none of 3\.0\.1, 3\.0\.0 could be downloaded/
  );
});

test("reports a failed npm install", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wallet-test-"));
  await assert.rejects(
    installCoinbaseWallet({
      dir,
      fetchImpl: coinbase("1.0.0", ["1.0.0"]),
      extract: () => done,
      npmInstall: () => ({ status: 1, stdout: "", stderr: "ENOSPC" }),
    }),
    /npm install failed: ENOSPC/
  );
});
