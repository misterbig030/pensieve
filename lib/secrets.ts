/**
 * Encryption at rest for secrets the app holds on a user's behalf (their API keys). AES-256-GCM with a server secret
 * from the environment; a fresh IV per seal; the version says which secret sealed a row so the secret can rotate.
 * The plaintext is never logged by anything here.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_VERSION = 1;
const ENV_NAME = "USER_KEY_ENCRYPTION_SECRET";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFromEnv(env: Record<string, string | undefined>): Buffer {
  const raw = env[ENV_NAME];
  if (!raw) throw new Error(`${ENV_NAME} is not set; generate one with: openssl rand -base64 32`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${ENV_NAME} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
  return key;
}

export function sealSecret(plaintext: string, env: Record<string, string | undefined> = process.env): { ciphertext: string; version: number } {
  const key = keyFromEnv(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, tag, body]).toString("base64"), version: SECRET_VERSION };
}

export function openSecret(ciphertext: string, version: number, env: Record<string, string | undefined> = process.env): string {
  if (version !== SECRET_VERSION) throw new Error(`Unknown secret version ${version}`);
  const key = keyFromEnv(env);
  const bytes = Buffer.from(ciphertext, "base64");
  if (bytes.length <= IV_BYTES + TAG_BYTES) throw new Error("Ciphertext could not be opened: wrong secret or tampered data");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Ciphertext could not be opened: wrong secret or tampered data");
  }
}
