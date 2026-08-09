import { describe, expect, it } from "vitest";
import { formatCostUsd } from "./formatCost";

describe("formatCostUsd", () => {
  it("formats zero as $0", () => {
    expect(formatCostUsd(0)).toBe("$0");
  });

  it("formats sub-cent amounts below the display threshold as < $0.0001", () => {
    expect(formatCostUsd(0.00005)).toBe("< $0.0001");
  });

  it("formats amounts at or above the threshold with 4 decimal places", () => {
    expect(formatCostUsd(0.0012)).toBe("$0.0012");
    expect(formatCostUsd(1.5)).toBe("$1.5000");
  });
});
