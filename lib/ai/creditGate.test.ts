import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/credits", () => ({ getAppSpendUsd: vi.fn() }));
vi.mock("@/lib/admin", () => ({ isAdminUserId: vi.fn() }));

import { isAdminUserId } from "@/lib/admin";
import { getAppSpendUsd } from "@/lib/db/credits";
import { creditRefusal } from "./creditGate";
import type { ResolvedModel } from "./resolve";

const spend = vi.mocked(getAppSpendUsd);
const admin = vi.mocked(isAdminUserId);
const app: ResolvedModel = { model: "anthropic/claude-haiku-4.5", id: "anthropic/claude-haiku-4.5", keyOwner: "app" };
const user: ResolvedModel = { ...app, keyOwner: "user" };
const now = new Date("2026-11-20T10:00:00Z");

beforeEach(() => {
  spend.mockReset();
  admin.mockReset().mockReturnValue(false);
});

describe("creditRefusal", () => {
  it("refuses at zero credits with 402 and the reset date", async () => {
    spend.mockResolvedValue(5);
    const res = await creditRefusal("u1", [app], now);
    expect(res?.status).toBe(402);
    expect(await res?.json()).toEqual({ code: "out_of_credits", resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(spend).toHaveBeenCalledWith("u1", new Date("2026-11-01T00:00:00Z"));
  });

  it("refuses when less than one whole credit is left", async () => {
    spend.mockResolvedValue(4.996);
    expect((await creditRefusal("u1", [app], now))?.status).toBe(402);
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
  });

  it("skips admins", async () => {
    admin.mockReturnValue(true);
    spend.mockResolvedValue(50);
    expect(await creditRefusal("u1", [app], now)).toBeNull();
  });
});
