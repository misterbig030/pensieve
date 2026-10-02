import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A researched material is "verified" only if the server says so. The gate signs what it checked, the browser
 * carries the signature, and saving a plan re-checks it; a bad or missing signature sends the material back
 * through the gate. Without `MATERIALS_SIGNING_SECRET` a random per-process secret is used, which is still
 * unforgeable but means a plan confirmed on another instance re-verifies its materials.
 */

export interface SignedFields {
  url: string;
  fetchedTitle: string | null;
  verifiedAt: string | null;
}

let processSecret: string | null = null;
let warned = false;

export function signingSecret(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MATERIALS_SIGNING_SECRET?.trim();
  if (configured) return configured;
  if (!warned) {
    warned = true;
    console.warn("[materials] MATERIALS_SIGNING_SECRET is not set; using a per-process secret");
  }
  processSecret ??= randomBytes(32).toString("hex");
  return processSecret;
}

function payload(fields: SignedFields): string {
  return [fields.url, fields.fetchedTitle ?? "", fields.verifiedAt ?? ""].join("|");
}

export function signMaterial(fields: SignedFields, secret: string = signingSecret()): string {
  return createHmac("sha256", secret).update(payload(fields)).digest("base64url");
}

export function verifyMaterialSig(fields: SignedFields, sig: string | null | undefined, secret: string = signingSecret()): boolean {
  if (!sig || !fields.verifiedAt) return false;
  const expected = Buffer.from(signMaterial(fields, secret));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
