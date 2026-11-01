import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: vi.fn() }));

import { eq } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";
import { db } from "./client";
import { users } from "./schema";
import { ensureUser, getUserRow, signedUpAt } from "./users";

describe("users", () => {
  it("makes a user's row once, with no signup date and no admin rights", async () => {
    await ensureUser(db, "u1");
    await ensureUser(db, "u1");
    expect(await getUserRow("u1")).toMatchObject({ id: "u1", signedUpAt: null, isAdmin: false });
    expect(await getUserRow("nobody")).toBeNull();
  });

  it("asks Clerk for the signup date once, then keeps it", async () => {
    const lookup = vi.fn(async () => new Date("2026-09-14T17:30:00Z"));
    expect(await signedUpAt("u2", lookup)).toEqual(new Date("2026-09-14T17:30:00Z"));
    expect(await signedUpAt("u2", lookup)).toEqual(new Date("2026-09-14T17:30:00Z"));
    expect(lookup).toHaveBeenCalledOnce();
    expect(await getUserRow("u2")).toMatchObject({ signedUpAt: new Date("2026-09-14T17:30:00Z") });

    await ensureUser(db, "u3");
    expect(await signedUpAt("u3", async () => new Date("2026-10-01T08:00:00Z"))).toEqual(new Date("2026-10-01T08:00:00Z"));
    expect(await getUserRow("u3")).toMatchObject({ signedUpAt: new Date("2026-10-01T08:00:00Z") });
  });

  it("is admin only when the row says so", async () => {
    expect(await isAdmin("u4")).toBe(false);
    expect(await isAdmin(null)).toBe(false);
    await ensureUser(db, "u4");
    expect(await isAdmin("u4")).toBe(false);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, "u4"));
    expect(await isAdmin("u4")).toBe(true);
  });
});
