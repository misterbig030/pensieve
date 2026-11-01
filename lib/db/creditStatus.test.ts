import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: vi.fn() }));

import { eq } from "drizzle-orm";
import { db } from "./client";
import { getCreditStatus } from "./creditStatus";
import { generationLog, users } from "./schema";
import { upsertUserApiKey } from "./userApiKeys";

describe("getCreditStatus", () => {
  it("counts this period's app spend and says whether the user's key covers every role", async () => {
    const now = new Date("2026-11-20T10:00:00Z");
    await db.insert(users).values({ id: "u1", signedUpAt: new Date("2026-09-14T17:30:00Z") });
    await db.insert(generationLog).values({
      caller: "outline",
      model: "anthropic/claude-opus-5.5",
      costUsd: 2,
      latencyMs: 1,
      userId: "u1",
      keyOwner: "app",
      createdAt: new Date("2026-11-13T23:00:00Z"),
    });
    await db.insert(generationLog).values({
      caller: "outline",
      model: "anthropic/claude-opus-5.5",
      costUsd: 1.234,
      latencyMs: 1,
      userId: "u1",
      keyOwner: "app",
      createdAt: new Date("2026-11-15T09:00:00Z"),
    });

    expect(await getCreditStatus("u1", now)).toEqual({ left: 376, allowance: 500, resetsAt: new Date("2026-12-14T00:00:00Z"), keyCoversAll: false, paused: false });

    await upsertUserApiKey({ userId: "u1", provider: "anthropic", ciphertext: "c", last4: "abcd", secretVersion: 1 });
    expect((await getCreditStatus("u1", now)).keyCoversAll).toBe(true);
  });

  it("is paused at zero, unless the user's key pays or they are an admin", async () => {
    const now = new Date("2026-11-20T10:00:00Z");
    await db.insert(users).values({ id: "u2", signedUpAt: new Date("2026-11-01T08:00:00Z") });
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
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, "u2"));
    expect(await getCreditStatus("u2", now)).toMatchObject({ left: 0, paused: false });
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, "u2"));
    await upsertUserApiKey({ userId: "u2", provider: "anthropic", ciphertext: "c", last4: "abcd", secretVersion: 1 });
    expect(await getCreditStatus("u2", now)).toMatchObject({ left: 0, paused: false });
  });

  it("uses the calendar month when Clerk can't give the signup date, and keeps nothing", async () => {
    const status = await getCreditStatus("u6", new Date("2026-11-20T10:00:00Z"));
    expect(status).toMatchObject({ left: 500, resetsAt: new Date("2026-12-01T00:00:00Z") });
    expect((await db.select().from(users).where(eq(users.id, "u6")))[0]?.signedUpAt ?? null).toBeNull();
  });

  it("is back to the full allowance after a manual reset, which lapses with the period", async () => {
    await db.insert(users).values({ id: "u7", signedUpAt: new Date("2026-09-14T17:30:00Z") });
    const spend = (costUsd: number, at: string) =>
      db.insert(generationLog).values({ caller: "outline", model: "anthropic/claude-opus-5.5", costUsd, latencyMs: 1, userId: "u7", keyOwner: "app", createdAt: new Date(at) });
    await spend(5, "2026-11-15T09:00:00Z");
    expect(await getCreditStatus("u7", new Date("2026-11-20T10:00:00Z"))).toMatchObject({ left: 0, paused: true });

    await db.update(users).set({ creditsResetAt: new Date("2026-11-16T00:00:00Z") }).where(eq(users.id, "u7"));
    await spend(1, "2026-11-17T09:00:00Z");
    expect(await getCreditStatus("u7", new Date("2026-11-20T10:00:00Z"))).toMatchObject({ left: 400, paused: false });

    await spend(4.5, "2026-12-15T09:00:00Z");
    expect(await getCreditStatus("u7", new Date("2026-12-20T10:00:00Z"))).toMatchObject({ left: 50 });
  });
});
