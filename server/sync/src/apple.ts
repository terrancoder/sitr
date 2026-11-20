/**
 * Offline verification of Apple's signed transactions and notifications
 * (JWS, ES256, x5c chain), docs/sync-protocol.md §Claim API → Apple
 * verification, steps 1 to 11. node:crypto only.
 *
 * The trust anchor and the accepted environments are constructor
 * arguments: claim-server.ts is the only place that builds the production
 * verifier, from APPLE_TRUST_ANCHOR below; tests pass their own root. A
 * TestAnchor (Xcode's StoreKit test certificate) is built only by
 * tests/src/devClaimServer.ts; no environment variable selects one.
 */
import { X509Certificate, verify } from "node:crypto";
import { jsonObject } from "./http.js";

export interface TrustAnchor {
  /** X509Certificate.fingerprint256 of the root ("AB:CD:…"). */
  rootFingerprint256: string;
  /** Full DER TLV of the OID the leaf must carry (step 10). */
  leafOid: Buffer;
  /** Full DER TLV of the OID the intermediate must carry (step 10). */
  intermediateOid: Buffer;
}

/**
 * DEVELOPMENT ONLY: Xcode's StoreKit test certificate, a root with no Apple
 * OIDs. The x5c chain (1 to 3 certificates) must end in exactly this
 * certificate and each link must verify; steps 6 and 10 do not apply.
 */
export interface TestAnchor {
  testRoot: X509Certificate;
}

export const APPLE_LEAF_OID = Buffer.from("060a2a864886f76364060b01", "hex");
export const APPLE_INTERMEDIATE_OID = Buffer.from("060a2a864886f76364060201", "hex");

/**
 * SHA-256 fingerprint of Apple Root CA - G3, as X509Certificate.fingerprint256
 * prints it. The certificate is server/sync/certs/AppleRootCA-G3.cer (see the
 * README there); a test checks the file against this value.
 */
export const APPLE_ROOT_CA_G3_FINGERPRINT256 =
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

export const APPLE_TRUST_ANCHOR: TrustAnchor = {
  rootFingerprint256: APPLE_ROOT_CA_G3_FINGERPRINT256,
  leafOid: APPLE_LEAF_OID,
  intermediateOid: APPLE_INTERMEDIATE_OID,
};

/** One DER TLV: tag byte, and where its contents start and end. */
function tlv(buf: Buffer, off: number): { tag: number; start: number; end: number } {
  if (off + 2 > buf.length) throw new Error("der");
  const tag = buf[off]!;
  let len = buf[off + 1]!;
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || start + n > buf.length) throw new Error("der");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!;
    start += n;
  }
  if (start + len > buf.length) throw new Error("der");
  return { tag, start, end: start + len };
}

/** The extnID TLVs of a certificate: TBSCertificate → [3] → each Extension. */
export function extensionOids(der: Buffer): Buffer[] {
  const cert = tlv(der, 0);
  const tbs = tlv(der, cert.start);
  const oids: Buffer[] = [];
  for (let off = tbs.start; off < tbs.end; ) {
    const field = tlv(der, off);
    if (field.tag === 0xa3) {
      const list = tlv(der, field.start); // SEQUENCE OF Extension
      for (let e = list.start; e < list.end; ) {
        const ext = tlv(der, e);
        const id = tlv(der, ext.start);
        if (id.tag !== 0x06) throw new Error("der");
        oids.push(der.subarray(ext.start, id.end));
        e = ext.end;
      }
    }
    off = field.end;
  }
  return oids;
}

/** A certificate whose extensions cannot be read carries no OID (a bad receipt). */
function hasOid(cert: X509Certificate, oid: Buffer): boolean {
  let oids: Buffer[];
  try {
    oids = extensionOids(cert.raw);
  } catch {
    return false;
  }
  return oids.some((o) => o.equals(oid));
}

const json = (part: string) => jsonObject(Buffer.from(part, "base64url").toString("utf8"));

export class AppleVerifier {
  constructor(
    private readonly anchor: TrustAnchor | TestAnchor,
    /** Environments accepted, e.g. Production (+ Sandbox when enabled). */
    readonly environments: ReadonlySet<string>,
  ) {
    // Added in Node v22.10.0 / v23.0.0; fail at start-up, not per receipt.
    if (!("validFromDate" in X509Certificate.prototype) || !("validToDate" in X509Certificate.prototype)) {
      throw new Error("Apple verification needs Node 22.10 or later (X509Certificate.validFromDate)");
    }
  }

  /**
   * Steps 1 to 11. The verified payload, or null when the receipt is bad.
   * A fault of the verifier itself is thrown, not reported as a bad receipt.
   */
  verify(jws: string): Record<string, unknown> | null {
    const parts = jws.split(".");
    if (parts.length !== 3) return null; // 1
    const header = json(parts[0]!);
    if (header === null || header["alg"] !== "ES256") return null; // 2
    const x5c = header["x5c"];
    const test = "testRoot" in this.anchor;
    if (!Array.isArray(x5c) || (test ? x5c.length < 1 || x5c.length > 3 : x5c.length !== 3)) return null; // 3
    const certs: X509Certificate[] = [];
    for (const c of x5c) {
      if (typeof c !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(c)) return null;
      try {
        certs.push(new X509Certificate(Buffer.from(c, "base64")));
      } catch {
        return null; // not a certificate
      }
    }
    const payload = json(parts[1]!);
    if (payload === null) return null;
    const signedDate = payload["signedDate"]; // 4
    if (typeof signedDate !== "number") return null;
    for (const c of certs) {
      // 5
      if (!(c.validFromDate.getTime() <= signedDate && signedDate <= c.validToDate.getTime())) return null;
    }
    const leaf = certs[0]!;
    if ("testRoot" in this.anchor) {
      if (!certs[certs.length - 1]!.raw.equals(this.anchor.testRoot.raw)) return null;
      for (let i = 0; i + 1 < certs.length; i++) {
        if (!certs[i]!.checkIssued(certs[i + 1]!) || !certs[i]!.verify(certs[i + 1]!.publicKey)) return null;
      }
      return this.signed(parts, leaf) ? payload : null;
    }
    const [, inter, root] = certs as [X509Certificate, X509Certificate, X509Certificate];
    if (root.fingerprint256 !== this.anchor.rootFingerprint256) return null; // 6
    if (!inter.checkIssued(root) || !inter.verify(root.publicKey)) return null; // 7
    if (!leaf.checkIssued(inter) || !leaf.verify(inter.publicKey)) return null; // 8
    if (inter.ca !== true || leaf.ca !== false) return null; // 9
    if (!hasOid(leaf, this.anchor.leafOid) || !hasOid(inter, this.anchor.intermediateOid)) return null; // 10
    return this.signed(parts, leaf) ? payload : null; // 11
  }

  /** Step 11: an ES256 signature by the leaf's P-256 key. */
  private signed(parts: string[], leaf: X509Certificate): boolean {
    if (leaf.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
    const sig = Buffer.from(parts[2]!, "base64url");
    if (sig.length !== 64) return false;
    return verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );
  }
}
