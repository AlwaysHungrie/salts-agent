// Installing Coinbase Wallet (Coinbase's Payments MCP package) when its own installer cannot.
//
// The installer (`npx @coinbase/payments-mcp install`) downloads the version Coinbase's
// API names as the latest, and gives up when that zip is missing, which happens when a
// release is announced before its zip is up. This does the same steps itself (zip into
// ~/.payments-mcp, then `npm install` for the wallet app) and steps back through earlier
// patch releases of that version until one downloads.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WALLET_BASE = "https://payments-mcp.coinbase.com";

/** `2.12.2` → `["2.12.2", "2.12.1", "2.12.0"]`, at most `max` of them. */
export function patchVersions(latest, max = 5) {
  const m = String(latest).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return [];
  const out = [];
  for (let patch = Number(m[3]); patch >= 0 && out.length < max; patch--) out.push(`${m[1]}.${m[2]}.${patch}`);
  return out;
}

/**
 * Download the newest release whose zip exists into `dir`, unpack it with `extract(zip,
 * dir)` and run `npmInstall(dir)`. Both return `{ status, stderr, stdout }` like spawnSync.
 * Returns the version installed; throws with what went wrong.
 */
export async function installCoinbaseWallet({ dir, extract, npmInstall, log = () => {}, fetchImpl = fetch }) {
  const res = await fetchImpl(`${WALLET_BASE}/api/version`);
  if (!res.ok) throw new Error(`Coinbase's version check answered ${res.status}`);
  const { version } = await res.json();
  const versions = patchVersions(version);
  if (versions.length === 0) throw new Error(`Coinbase named no usable version (${version})`);

  for (const v of versions) {
    const zip = await fetchImpl(`${WALLET_BASE}/install/payments-mcp-v${v}.zip`);
    if (zip.status === 404) {
      log(`coinbase-wallet: v${v} is not downloadable, trying the one before`);
      continue;
    }
    if (!zip.ok) throw new Error(`downloading v${v} failed: ${zip.status}`);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "payments-mcp-"));
    try {
      const file = path.join(tmp, "payments-mcp.zip");
      writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
      mkdirSync(dir, { recursive: true });
      const unpacked = extract(file, dir);
      if (unpacked.status !== 0) throw new Error(`unpacking v${v} failed: ${(unpacked.stderr || unpacked.stdout || "").trim()}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    log(`coinbase-wallet: installing the wallet app for v${v} (npm install)`);
    const installed = npmInstall(dir);
    if (installed.status !== 0) throw new Error(`npm install failed: ${(installed.stderr || installed.stdout || "").trim().slice(-500)}`);
    return v;
  }
  throw new Error(`none of ${versions.join(", ")} could be downloaded`);
}
