import { createHash, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import { unzipSync } from "fflate";
import * as pkijs from "pkijs";
import { APPLE_ROOT_CA, APPLE_WWDR_G4 } from "./apple-certs";

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto }));

/** Largest .pkpass accepted, in bytes, and the most any one file inside may unpack to. */
export const MAX_PKPASS_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/** Marks an Apple-issued Pass Type ID certificate. */
const PASS_TYPE_ID_EXTENSION = "1.2.840.113635.100.6.1.16";
const OID_UID = "0.9.2342.19200300.100.1.1";
const OID_OU = "2.5.4.11";

const PASS_STYLES = ["eventTicket", "generic", "boardingPass", "coupon", "storeCard"] as const;
const FIELD_GROUPS = ["primaryFields", "secondaryFields", "auxiliaryFields", "headerFields", "backFields"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who a pass must come from. Both are bound to Apple's certificate, so only the issuer
 * can sign a pass carrying them; the rest of pass.json may vary from ticket to ticket.
 */
export type PassIssuer = { passTypeIdentifier: string; teamIdentifier: string };

/** Devcon 8 tickets, as issued by tickets.devcon.org. */
export const DEVCON_ISSUER: PassIssuer = { passTypeIdentifier: "pass.devcon-test", teamIdentifier: "B6ZYYG9TU6" };

/** Why a pass was refused; the message is safe to show the user. */
export class PassError extends Error {}

/** What a verified pass identifies: one ticket, and the name its holder goes by. */
export type VerifiedPass = { passTypeIdentifier: string; serialNumber: string; name: string };

export type VerifyOptions = {
  /** Issuer the pass must come from. Defaults to Devcon; any other validly signed pass is refused. */
  issuer?: PassIssuer;
  /** DER certificates the signer must chain to. Defaults to Apple Root CA + WWDR G4. */
  trust?: Uint8Array[];
  /** When the chain must be valid. Defaults to now. */
  now?: Date;
};

const APPLE_TRUST = [APPLE_ROOT_CA, APPLE_WWDR_G4].map((b64) => new Uint8Array(Buffer.from(b64, "base64")));

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/**
 * Unzip a .pkpass, check every file against manifest.json, check the detached CMS
 * signature over manifest.json, check the signer chains to Apple and is the Pass Type ID
 * certificate the pass claims, and check that the issuer is Devcon and the ticket is
 * current. Throws PassError on anything short of that.
 */
export async function verifyPkpass(bytes: Uint8Array, opts: VerifyOptions = {}): Promise<VerifiedPass> {
  if (bytes.byteLength > MAX_PKPASS_BYTES) throw new PassError("That file is too large to be a pass.");

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.originalSize <= MAX_ENTRY_BYTES });
  } catch {
    throw new PassError("That file is not a .pkpass.");
  }
  const manifestBytes = files["manifest.json"];
  const signature = files["signature"];
  const passBytes = files["pass.json"];
  if (!manifestBytes || !signature || !passBytes) throw new PassError("That file is not a .pkpass.");

  checkManifest(files, manifestBytes);
  const signer = await checkSignature(signature, manifestBytes, opts.trust ?? APPLE_TRUST, opts.now ?? new Date());

  let pass: Record<string, unknown>;
  try {
    pass = JSON.parse(new TextDecoder().decode(passBytes));
  } catch {
    throw new PassError("The pass is unreadable.");
  }
  const issuer = opts.issuer ?? DEVCON_ISSUER;
  const { passTypeIdentifier, teamIdentifier, serialNumber } = pass;
  if (typeof passTypeIdentifier !== "string" || typeof teamIdentifier !== "string" || typeof serialNumber !== "string" || !serialNumber)
    throw new PassError("The pass is unreadable.");

  // The certificate is issued for one pass type and one team; the pass must claim both.
  if (subjectValue(signer, OID_UID) !== passTypeIdentifier || subjectValue(signer, OID_OU) !== teamIdentifier)
    throw new PassError("The pass was not signed by its issuer.");
  if (passTypeIdentifier !== issuer.passTypeIdentifier || teamIdentifier !== issuer.teamIdentifier)
    throw new PassError("That is not a Devcon ticket.");
  if (pass.voided === true) throw new PassError("That ticket has been voided.");
  const expires = typeof pass.expirationDate === "string" ? Date.parse(pass.expirationDate) : NaN;
  if (expires <= (opts.now ?? new Date()).getTime()) throw new PassError("That ticket has expired.");

  const name = ticketEmail(pass)?.split("@")[0];
  if (!name) throw new PassError("No email was found on the ticket.");
  return { passTypeIdentifier, serialNumber, name: name.slice(0, 64) };
}

/** Every file but manifest.json and signature is listed, and every listed file matches its SHA-1. */
function checkManifest(files: Record<string, Uint8Array>, manifestBytes: Uint8Array) {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new PassError("The pass manifest is unreadable.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new PassError("The pass manifest is unreadable.");
  const listed = manifest as Record<string, unknown>;
  for (const [path, data] of Object.entries(files)) {
    if (path === "manifest.json" || path === "signature" || path.endsWith("/")) continue;
    const want = listed[path];
    const got = createHash("sha1").update(data).digest("hex");
    if (typeof want !== "string" || want.toLowerCase() !== got) throw new PassError("The pass has been altered.");
  }
  for (const path of Object.keys(listed)) {
    if (!files[path]) throw new PassError("The pass is missing files.");
  }
}

async function checkSignature(signature: Uint8Array, manifest: Uint8Array, trust: Uint8Array[], now: Date) {
  let signed: pkijs.SignedData;
  try {
    const asn1 = asn1js.fromBER(buf(signature));
    if (asn1.offset === -1) throw new Error("bad BER");
    const info = new pkijs.ContentInfo({ schema: asn1.result });
    if (info.contentType !== pkijs.ContentInfo.SIGNED_DATA) throw new Error("not SignedData");
    signed = new pkijs.SignedData({ schema: info.content });
  } catch {
    throw new PassError("The pass signature is unreadable.");
  }
  // Detached only: an embedded payload would be verified in place of manifest.json.
  if (signed.encapContentInfo.eContent || signed.signerInfos.length !== 1)
    throw new PassError("The pass signature is invalid.");

  const trustedCerts = trust.map((der) => pkijs.Certificate.fromBER(buf(der)));
  let result: pkijs.SignedDataVerifyResult;
  try {
    result = await signed.verify({
      signer: 0,
      data: buf(manifest),
      trustedCerts,
      checkChain: true,
      checkDate: now,
      extendedMode: true,
    });
  } catch {
    throw new PassError("The pass signature is invalid.");
  }
  const cert = result.signerCertificate;
  if (!result.signatureVerified || !cert) throw new PassError("The pass signature is invalid.");
  if (!cert.extensions?.some((e) => e.extnID === PASS_TYPE_ID_EXTENSION))
    throw new PassError("The pass was not signed with a pass certificate.");
  return cert;
}

function subjectValue(cert: pkijs.Certificate, oid: string): string | undefined {
  const tv = cert.subject.typesAndValues.find((t) => t.type === oid);
  const v = tv?.value.valueBlock.value;
  return typeof v === "string" ? v : undefined;
}

/** A stable app user id for a pass: never the serial itself. */
export function passUserId(pass: Pick<VerifiedPass, "passTypeIdentifier" | "serialNumber">): string {
  return "dc-" + createHash("sha256").update(`${pass.passTypeIdentifier}\n${pass.serialNumber}`).digest("hex").slice(0, 32);
}

/** The email on the ticket: a field keyed `email`, else the first field whose value is one. */
export function ticketEmail(pass: Record<string, unknown>): string | null {
  const fields: { key?: unknown; value?: unknown }[] = [];
  for (const style of PASS_STYLES) {
    const body = pass[style];
    if (!body || typeof body !== "object") continue;
    for (const group of FIELD_GROUPS) {
      const list = (body as Record<string, unknown>)[group];
      if (Array.isArray(list)) fields.push(...list.filter((f) => f && typeof f === "object"));
    }
  }
  const isEmail = (v: unknown): v is string => typeof v === "string" && EMAIL.test(v.trim());
  const found = fields.find((f) => typeof f.key === "string" && /email/i.test(f.key) && isEmail(f.value))?.value ?? fields.find((f) => isEmail(f.value))?.value;
  return typeof found === "string" ? found.trim() : null;
}
