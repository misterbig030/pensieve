import { describe, expect, it } from "vitest";
import { adminUserIds, isAdminUserId } from "./admin";

describe("admin gating", () => {
  it("parses a comma-separated list, trimming blanks", () => {
    expect([...adminUserIds(" user_a, user_b ,,user_c ")]).toEqual(["user_a", "user_b", "user_c"]);
    expect(adminUserIds(undefined).size).toBe(0);
    expect(adminUserIds("").size).toBe(0);
  });

  it("matches only listed ids and never a missing one", () => {
    expect(isAdminUserId("user_a", "user_a,user_b")).toBe(true);
    expect(isAdminUserId("user_z", "user_a,user_b")).toBe(false);
    expect(isAdminUserId(null, "user_a")).toBe(false);
    expect(isAdminUserId(undefined, "user_a")).toBe(false);
    expect(isAdminUserId("", "")).toBe(false);
  });
});
