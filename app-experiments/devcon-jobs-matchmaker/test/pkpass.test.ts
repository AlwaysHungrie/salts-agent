import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_PKPASS_BYTES, passUserId, ticketEmail, verifyPkpass } from "@/lib/pkpass";

const PASS_TYPE = "pass.org.devcon.test";
const TEAM = "TEAM123456";
const SAMPLE = join(__dirname, "fixtures", "devcon.pkpass");

let dir: string;
let root: Uint8Array;
const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
const der = (pem: string) => new Uint8Array(ssl("x509", "-in", pem, "-outform", "DER"));

/** Root → intermediate → leaf, like Apple Root CA → WWDR → Pass Type ID. */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pkpass-"));
  writeFileSync(
    join(dir, "ext.cnf"),
    [
      "[ca]",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "[pass]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "1.2.840.113635.100.6.1.16=ASN1:UTF8String:" + PASS_TYPE,
      "[plain]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
    ].join("\n"),
  );
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "30", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  issue("inter", "/CN=Test WWDR", "root", "ca");
  const subject = `/UID=${PASS_TYPE}/CN=Pass Type ID: ${PASS_TYPE}/OU=${TEAM}/O=Devcon`;
  issue("leaf", subject, "inter", "pass");
  issue("plain", subject, "inter", "plain");
  root = der("root.pem");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function issue(name: string, subj: string, ca: string, ext: string) {
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subj);
  ssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "30", "-extfile", "ext.cnf", "-extensions", ext);
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

function passJson(over: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    passTypeIdentifier: PASS_TYPE,
    teamIdentifier: TEAM,
    serialNumber: "TICKET-42",
    organizationName: "Devcon",
    description: "Devcon 8 ticket",
    eventTicket: {
      primaryFields: [{ key: "event", label: "EVENT", value: "Devcon 8" }],
      backFields: [{ key: "email", label: "Ordered by", value: "ada.lovelace@example.org" }],
    },
    ...over,
  };
}

/** A .pkpass signed by `signer`, with optional tampering after signing. */
function makePass({
  pass = passJson(),
  signer = "leaf",
  attached = false,
  tamper,
}: {
  pass?: unknown;
  signer?: string;
  attached?: boolean;
  tamper?: (files: Record<string, Uint8Array>) => void;
} = {}): Uint8Array {
  const files: Record<string, Uint8Array> = { "pass.json": enc(pass), "icon.png": new Uint8Array([1, 2, 3]) };
  const manifest = enc(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha1(v)])));
  writeFileSync(join(dir, "manifest.json"), manifest);
  ssl("cms", "-sign", "-binary", "-outform", "DER", "-md", "sha256", "-signer", `${signer}.pem`, "-inkey", `${signer}.key`, "-certfile", "inter.pem", "-in", "manifest.json", "-out", "signature", ...(attached ? ["-nodetach"] : []));
  const all = { ...files, "manifest.json": manifest, signature: new Uint8Array(readFileSync(join(dir, "signature"))) };
  tamper?.(all);
  return zipSync(all);
}

const ISSUER = { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM };
const opts = () => ({ issuer: ISSUER, trust: [root] });

describe("verifyPkpass", () => {
  it("accepts a correctly signed pass and names the user after their email", async () => {
    const pass = await verifyPkpass(makePass(), opts());
    expect(pass).toEqual({ passTypeIdentifier: PASS_TYPE, serialNumber: "TICKET-42", name: "ada.lovelace" });
  });

  it("accepts a ticket in another layout from the same issuer", async () => {
    const pass = passJson({ organizationName: "Devcon SEA", serialNumber: "x", eventTicket: undefined });
    const bytes = makePass({ pass: { ...pass, generic: { secondaryFields: [{ key: "who", value: "bo@devcon.org" }] } } });
    expect((await verifyPkpass(bytes, opts())).name).toBe("bo");
  });

  it("refuses a voided or expired ticket", async () => {
    await expect(verifyPkpass(makePass({ pass: passJson({ voided: true }) }), opts())).rejects.toThrow(/voided/);
    const expired = makePass({ pass: passJson({ expirationDate: "2020-01-01T00:00:00Z" }) });
    await expect(verifyPkpass(expired, opts())).rejects.toThrow(/expired/);
    const current = makePass({ pass: passJson({ expirationDate: "2999-01-01T00:00:00Z" }) });
    await expect(verifyPkpass(current, opts())).resolves.toBeTruthy();
  });

  it("refuses a signer certificate that is no longer valid", async () => {
    const later = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await expect(verifyPkpass(makePass(), { ...opts(), now: later })).rejects.toThrow(/signature is invalid/);
  });

  it("refuses a pass whose files were changed after signing", async () => {
    const bytes = makePass({ tamper: (f) => (f["pass.json"] = enc(passJson({ serialNumber: "TICKET-43" }))) });
    await expect(verifyPkpass(bytes, opts())).rejects.toThrow(/altered/);
  });

  it("refuses a pass with a file the manifest does not list", async () => {
    const bytes = makePass({ tamper: (f) => (f["extra.png"] = new Uint8Array([9])) });
    await expect(verifyPkpass(bytes, opts())).rejects.toThrow(/altered/);
  });

  it("refuses a pass whose manifest was rewritten to match", async () => {
    const bytes = makePass({
      tamper: (f) => {
        f["pass.json"] = enc(passJson({ serialNumber: "TICKET-43" }));
        f["manifest.json"] = enc({ "pass.json": sha1(f["pass.json"]), "icon.png": sha1(f["icon.png"]) });
      },
    });
    await expect(verifyPkpass(bytes, opts())).rejects.toThrow(/signature is invalid/);
  });

  it("refuses a signature that does not chain to the trusted root", async () => {
    await expect(verifyPkpass(makePass(), { issuer: ISSUER })).rejects.toThrow(/signature is invalid/);
  });

  it("refuses a signer certificate that is not a Pass Type ID certificate", async () => {
    await expect(verifyPkpass(makePass({ signer: "plain" }), opts())).rejects.toThrow(/pass certificate/);
  });

  it("refuses a pass claiming a pass type its certificate was not issued for", async () => {
    const bytes = makePass({ pass: passJson({ passTypeIdentifier: "pass.org.other" }) });
    const issuer = { passTypeIdentifier: "pass.org.other", teamIdentifier: TEAM };
    await expect(verifyPkpass(bytes, { issuer, trust: [root] })).rejects.toThrow(/issuer/);
  });

  it("refuses a validly signed pass that is not a Devcon ticket", async () => {
    const issuer = { passTypeIdentifier: "pass.org.devcon", teamIdentifier: TEAM };
    await expect(verifyPkpass(makePass(), { issuer, trust: [root] })).rejects.toThrow(/not a Devcon ticket/);
  });

  it("refuses an attached signature", async () => {
    await expect(verifyPkpass(makePass({ attached: true }), opts())).rejects.toThrow(/signature is invalid/);
  });

  it("refuses a file that is not a pass", async () => {
    await expect(verifyPkpass(new Uint8Array([1, 2, 3]), opts())).rejects.toThrow(/not a .pkpass/);
    await expect(verifyPkpass(zipSync({ "a.txt": enc("hi") }), opts())).rejects.toThrow(/not a .pkpass/);
  });

  it("refuses a file over MAX_PKPASS_BYTES", async () => {
    await expect(verifyPkpass(new Uint8Array(MAX_PKPASS_BYTES + 1), opts())).rejects.toThrow(/too large/);
  });

  it("refuses a ticket with no email on it", async () => {
    const bytes = makePass({ pass: passJson({ eventTicket: { primaryFields: [{ key: "event", value: "Devcon 8" }] } }) });
    await expect(verifyPkpass(bytes, opts())).rejects.toThrow(/No email/);
  });
});

describe("ticketEmail", () => {
  it("prefers a field keyed email, else any field holding one", () => {
    const fields = [{ key: "website", value: "https://devcon.org" }, { key: "contact", value: "x@y.org" }, { key: "email", value: " a@b.org " }];
    expect(ticketEmail({ eventTicket: { backFields: fields } })).toBe("a@b.org");
    expect(ticketEmail({ eventTicket: { backFields: fields.slice(0, 2) } })).toBe("x@y.org");
    expect(ticketEmail({ eventTicket: { backFields: [{ key: "email", value: "not an email" }] } })).toBeNull();
    expect(ticketEmail({})).toBeNull();
  });
});

describe("passUserId", () => {
  it("is stable, opaque and a valid user id", () => {
    const id = passUserId({ passTypeIdentifier: PASS_TYPE, serialNumber: "TICKET-42" });
    expect(id).toBe(passUserId({ passTypeIdentifier: PASS_TYPE, serialNumber: "TICKET-42" }));
    expect(id).not.toContain("TICKET");
    expect(id).toMatch(/^dc-[0-9a-f]{32}$/);
  });
});

/** A real Devcon pass, kept out of git (it is a live ticket). Checked against Apple's root. */
describe.skipIf(!existsSync(SAMPLE))("real Devcon .pkpass", () => {
  it("verifies against Apple's root as a Devcon ticket, named after its email", async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE));
    const email = ticketEmail(JSON.parse(new TextDecoder().decode(unzipSync(bytes)["pass.json"])));
    const pass = await verifyPkpass(bytes);
    expect(pass.name).toBe(email?.split("@")[0]);
  });

  it("is refused once any file in it is changed", async () => {
    const files = unzipSync(new Uint8Array(readFileSync(SAMPLE)));
    const pass = JSON.parse(new TextDecoder().decode(files["pass.json"]));
    files["pass.json"] = enc({ ...pass, serialNumber: pass.serialNumber + "1" });
    await expect(verifyPkpass(zipSync(files))).rejects.toThrow(/altered/);
  });
});
