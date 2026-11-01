import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/credits", () => ({ getAppSpendUsd: vi.fn() }));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn() }));
vi.mock("@/lib/db/users", () => ({ signedUpAtFor: vi.fn() }));

import { isAdmin } from "@/lib/admin";
import { getAppSpendUsd } from "@/lib/db/credits";
import { signedUpAtFor } from "@/lib/db/users";
import { creditRefusal } from "./creditGate";
import type { ResolvedModel } from "./resolve";

const spend = vi.mocked(getAppSpendUsd);
const admin = vi.mocked(isAdmin);
const signup = vi.mocked(signedUpAtFor);
const app: ResolvedModel = { model: "anthropic/claude-haiku-4.5", id: "anthropic/claude-haiku-4.5", keyOwner: "app" };
const user: ResolvedModel = { ...app, keyOwner: "user" };
const now = new Date("2026-11-20T10:00:00Z");

beforeEach(() => {
  spend.mockReset();
  admin.mockReset().mockResolvedValue(false);
  signup.mockReset().mockResolvedValue(new Date("2026-09-14T17:30:00Z"));
});

describe("creditRefusal", () => {
  it("refuses at zero credits with 402 and the user's own reset date", async () => {
    spend.mockResolvedValue(5);
    const res = await creditRefusal("u1", [app], now);
    expect(res?.status).toBe(402);
    expect(await res?.json()).toEqual({ code: "out_of_credits", resetsAt: "2026-12-14T00:00:00.000Z" });
    expect(spend).toHaveBeenCalledWith("u1", new Date("2026-11-14T00:00:00Z"));
  });

  it("refuses when less than one whole credit is left", async () => {
    spend.mockResolvedValue(4.996);
    expect((await creditRefusal("u1", [app], now))?.status).toBe(402);
  });

  it("falls back to the calendar month when the signup date can't be had", async () => {
    signup.mockRejectedValue(new Error("Clerk signup lookup timed out after 3000ms"));
    spend.mockResolvedValue(5);
    const res = await creditRefusal("u1", [app], now);
    expect(await res?.json()).toEqual({ code: "out_of_credits", resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(spend).toHaveBeenCalledWith("u1", new Date("2026-11-01T00:00:00Z"));
  });

  it("allows one credit left", async () => {
    spend.mockResolvedValue(4.99);
    expect(await creditRefusal("u1", [app], now)).toBeNull();
  });

  it("checks when any role runs on Pensieve's key", async () => {
    spend.mockResolvedValue(6);
    expect((await creditRefusal("u1", [user, app], now))?.status).toBe(402);
  });

  it("skips users whose key covers every role, without querying", async () => {
    expect(await creditRefusal("u1", [user, user], now)).toBeNull();
    expect(spend).not.toHaveBeenCalled();
    expect(signup).not.toHaveBeenCalled();
  });

  it("skips admins", async () => {
    admin.mockResolvedValue(true);
    spend.mockResolvedValue(50);
    expect(await creditRefusal("u1", [app], now)).toBeNull();
  });
});
