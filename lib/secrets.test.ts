import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SECRET_VERSION, openSecret, sealSecret } from "./secrets";

const env = { USER_KEY_ENCRYPTION_SECRET: randomBytes(32).toString("base64") };
const other = { USER_KEY_ENCRYPTION_SECRET: randomBytes(32).toString("base64") };

describe("sealSecret / openSecret", () => {
  it("round-trips, with a fresh IV each time", () => {
    const a = sealSecret("sk-ant-api03-abc", env);
    const b = sealSecret("sk-ant-api03-abc", env);
    expect(a.version).toBe(SECRET_VERSION);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(openSecret(a.ciphertext, a.version, env)).toBe("sk-ant-api03-abc");
    expect(openSecret(b.ciphertext, b.version, env)).toBe("sk-ant-api03-abc");
  });

  it("refuses tampered data, the wrong secret and an unknown version", () => {
    const { ciphertext, version } = sealSecret("sk-ant-api03-abc", env);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] ^= 0x01;
    expect(() => openSecret(bytes.toString("base64"), version, env)).toThrow(/wrong secret or tampered/);
    expect(() => openSecret(ciphertext, version, other)).toThrow(/wrong secret or tampered/);
    expect(() => openSecret(ciphertext, 2, env)).toThrow(/version/);
  });

  it("fails loudly when the secret is missing or not 32 bytes", () => {
    expect(() => sealSecret("x", {})).toThrow(/USER_KEY_ENCRYPTION_SECRET is not set/);
    expect(() => sealSecret("x", { USER_KEY_ENCRYPTION_SECRET: Buffer.from("short").toString("base64") })).toThrow(/32 bytes/);
    expect(() => openSecret("AAAA", 1, {})).toThrow(/USER_KEY_ENCRYPTION_SECRET is not set/);
  });
});
