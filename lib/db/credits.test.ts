import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { db } from "./client";
import { getAppSpendUsd } from "./credits";
import { generationLog } from "./schema";

const row = (userId: string | null, keyOwner: "app" | "user", costUsd: number, at: string) => ({
  caller: "outline" as const,
  model: "anthropic/claude-opus-5.5",
  costUsd,
  latencyMs: 1,
  userId,
  keyOwner,
  createdAt: new Date(at),
});

describe("getAppSpendUsd", () => {
  it("sums only this user's app-paid rows since the month start", async () => {
    await db.insert(generationLog).values([
      row("u1", "app", 1.25, "2026-10-31T23:59:59Z"),
      row("u1", "app", 0.5, "2026-11-01T00:00:00Z"),
      row("u1", "app", 0.25, "2026-11-20T10:00:00Z"),
      row("u1", "user", 3, "2026-11-05T10:00:00Z"),
      row("u2", "app", 2, "2026-11-05T10:00:00Z"),
      row(null, "app", 9, "2026-11-05T10:00:00Z"),
    ]);
    expect(await getAppSpendUsd("u1", new Date("2026-11-01T00:00:00Z"))).toBeCloseTo(0.75);
    expect(await getAppSpendUsd("nobody", new Date("2026-11-01T00:00:00Z"))).toBe(0);
  });
});
