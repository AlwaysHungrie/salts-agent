import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { installMcp, launchArgs, mcpSource, viaNpx } from "../mcps.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "salts-mcps-"));

test("mcpSource runs in place from a clone, and from an installed copy out of npm", () => {
  const repo = tmp();
  const here = path.join(repo, "salts-tools");
  mkdirSync(path.join(repo, "local-mcps", "analyst-mcp"), { recursive: true });
  writeFileSync(path.join(repo, "local-mcps", "analyst-mcp", "pyproject.toml"), "");
  assert.deepEqual(mcpSource(here, "analyst-mcp", "/root"), {
    dir: path.join(repo, "local-mcps", "analyst-mcp"),
  });

  const pkg = path.join(tmp(), "salts-tools");
  assert.deepEqual(mcpSource(pkg, "analyst-mcp", "/root"), {
    dir: path.join("/root", "analyst-mcp"),
    bundled: path.join(pkg, "mcps", "analyst-mcp"),
  });
});

test("installMcp copies a new version over the old and keeps the user's .env, data and .venv", () => {
  const bundled = tmp();
  const target = path.join(tmp(), "analyst-mcp");
  writeFileSync(path.join(bundled, "pyproject.toml"), "v1");

  assert.equal(installMcp(bundled, target, "1.0.0"), true);
  assert.equal(readFileSync(path.join(target, "pyproject.toml"), "utf8"), "v1");
  assert.equal(installMcp(bundled, target, "1.0.0"), false, "same version: nothing to do");

  for (const kept of [".venv", "data"]) mkdirSync(path.join(target, kept));
  writeFileSync(path.join(target, ".env"), "ALLOW_PYTHON=true");
  writeFileSync(path.join(target, "old.py"), "");
  writeFileSync(path.join(bundled, "pyproject.toml"), "v2");

  assert.equal(installMcp(bundled, target, "1.1.0"), true);
  assert.equal(readFileSync(path.join(target, "pyproject.toml"), "utf8"), "v2");
  assert.equal(readFileSync(path.join(target, ".env"), "utf8"), "ALLOW_PYTHON=true");
  assert.ok(existsSync(path.join(target, ".venv")) && existsSync(path.join(target, "data")));
  assert.ok(!existsSync(path.join(target, "old.py")), "files the new version dropped go");
});

test("installMcp refuses a package with no bundled server", () => {
  assert.throws(() => installMcp(tmp(), path.join(tmp(), "x"), "1.0.0"), /missing/);
});

test("a login item starts a clone or install directly, and an npx run through npx", () => {
  const cli = "/home/u/salts-agent/salts-tools/cli.mjs";
  assert.deepEqual(launchArgs({ cli, execPath: "/usr/bin/node", platform: "linux" }), ["/usr/bin/node", cli]);

  const cached = "/home/u/.npm/_npx/ab12/node_modules/salts-tools/cli.mjs";
  assert.ok(viaNpx(cached) && !viaNpx(cli));
  assert.deepEqual(launchArgs({ cli: cached, execPath: "/opt/node/bin/node", platform: "darwin" }), [
    "/opt/node/bin/npx",
    "--yes",
    "--prefer-offline",
    "salts-tools",
  ]);
});
