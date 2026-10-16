import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { clearUserApiKeyError, deleteUserApiKey, getUserApiKeys, recordUserApiKeyError, upsertUserApiKey } from "./userApiKeys";

describe("user_api_keys queries", () => {
  it("stores one row per user and provider, replacing on save and clearing any error", async () => {
    await upsertUserApiKey({ userId: "u1", provider: "anthropic", ciphertext: "c1", last4: "k9Qa", secretVersion: 1 });
    await recordUserApiKeyError("u1", "anthropic", "credits", new Date("2026-10-15T10:00:00Z"));
    let rows = await getUserApiKeys("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "anthropic", ciphertext: "c1", last4: "k9Qa", secretVersion: 1, lastError: "credits" });
    expect(rows[0].lastErrorAt?.toISOString()).toBe("2026-10-15T10:00:00.000Z");

    await upsertUserApiKey({ userId: "u1", provider: "anthropic", ciphertext: "c2", last4: "zz99", secretVersion: 1 });
    rows = await getUserApiKeys("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ciphertext: "c2", last4: "zz99", lastError: null, lastErrorAt: null });
    expect(await getUserApiKeys("someone-else")).toEqual([]);
  });

  it("clears an error and deletes a key", async () => {
    await upsertUserApiKey({ userId: "u2", provider: "anthropic", ciphertext: "c", last4: "abcd", secretVersion: 1 });
    await recordUserApiKeyError("u2", "anthropic", "invalid");
    await clearUserApiKeyError("u2", "anthropic");
    expect((await getUserApiKeys("u2"))[0]).toMatchObject({ lastError: null, lastErrorAt: null });
    await deleteUserApiKey("u2", "anthropic");
    expect(await getUserApiKeys("u2")).toEqual([]);
  });
});
