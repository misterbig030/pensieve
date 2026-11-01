import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { db } from "./client";
import { getCreditStatus } from "./creditStatus";
import { generationLog } from "./schema";
import { upsertUserApiKey } from "./userApiKeys";

describe("getCreditStatus", () => {
  it("counts this month's app spend and says whether the user's key covers every role", async () => {
    const now = new Date("2026-11-20T10:00:00Z");
    await db.insert(generationLog).values({
      caller: "outline",
      model: "anthropic/claude-opus-5.5",
      costUsd: 1.234,
      latencyMs: 1,
      userId: "u1",
      keyOwner: "app",
      createdAt: new Date("2026-11-03T09:00:00Z"),
    });

    expect(await getCreditStatus("u1", now)).toEqual({ left: 376, allowance: 500, resetsAt: new Date("2026-12-01T00:00:00Z"), keyCoversAll: false, paused: false });

    await upsertUserApiKey({ userId: "u1", provider: "anthropic", ciphertext: "c", last4: "abcd", secretVersion: 1 });
    expect((await getCreditStatus("u1", now)).keyCoversAll).toBe(true);
  });

  it("is paused at zero, unless the user's key pays or they are an admin", async () => {
    const now = new Date("2026-11-20T10:00:00Z");
    await db.insert(generationLog).values({
      caller: "outline",
      model: "anthropic/claude-opus-5.5",
      costUsd: 5.2,
      latencyMs: 1,
      userId: "u2",
      keyOwner: "app",
      createdAt: new Date("2026-11-03T09:00:00Z"),
    });

    expect(await getCreditStatus("u2", now)).toMatchObject({ left: 0, paused: true });
    vi.stubEnv("ADMIN_USER_IDS", "u2");
    expect(await getCreditStatus("u2", now)).toMatchObject({ left: 0, paused: false });
    vi.unstubAllEnvs();
    await upsertUserApiKey({ userId: "u2", provider: "anthropic", ciphertext: "c", last4: "abcd", secretVersion: 1 });
    expect(await getCreditStatus("u2", now)).toMatchObject({ left: 0, paused: false });
  });
});
