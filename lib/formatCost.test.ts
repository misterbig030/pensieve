import { describe, expect, it } from "vitest";
import { callCost, formatCallCost, formatCostUsd, sumCallCosts, type CostedCall } from "./formatCost";

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

  it("shows a call with no charge, one on the user's own key, as a dash", () => {
    expect(formatCostUsd(null)).toBe("—");
  });
});

const call = (over: Partial<CostedCall>): CostedCall => ({
  model: "anthropic/claude-opus-5.5",
  keyOwner: "app",
  costUsd: 0.01,
  inputTokens: 10_000,
  outputTokens: 1_000,
  cacheReadTokens: 2_000,
  ...over,
});

describe("callCost", () => {
  it("is what the gateway charged for a call on Pensieve's key", () => {
    expect(callCost(call({ costUsd: 0.0123 }))).toEqual({ usd: 0.0123, estimated: false });
  });

  it("is a list-price estimate for a call on the user's own key, which the gateway never sees", () => {
    const cost = callCost(call({ keyOwner: "user", costUsd: null }));
    expect(cost.estimated).toBe(true);
    expect(cost.usd).toBeCloseTo(0.0524, 10);
  });

  it("stays unknown for a model no longer priced", () => {
    expect(callCost(call({ keyOwner: "user", model: "anthropic/claude-gone" as CostedCall["model"] }))).toEqual({ usd: null, estimated: true });
  });

  it("stays unknown for a Pensieve call the gateway reported no charge for", () => {
    expect(callCost(call({ costUsd: null }))).toEqual({ usd: null, estimated: false });
  });
});

describe("sumCallCosts", () => {
  it("adds the charged and the estimated calls up apart", () => {
    const totals = sumCallCosts([call({ costUsd: 0.01 }), call({ costUsd: 0.02 }), call({ keyOwner: "user", costUsd: null }), call({ costUsd: null })]);
    expect(totals.chargedUsd).toBeCloseTo(0.03, 10);
    expect(totals.estimatedUsd).toBeCloseTo(0.0524, 10);
    expect(totals.estimatedCalls).toBe(1);
  });
});

describe("formatCallCost", () => {
  it("marks an estimate with ≈ and leaves a charge as it is", () => {
    expect(formatCallCost({ usd: 0.0524, estimated: true })).toBe("≈\u00a0$0.0524");
    expect(formatCallCost({ usd: 0.0524, estimated: false })).toBe("$0.0524");
    expect(formatCallCost({ usd: null, estimated: false })).toBe("—");
    expect(formatCallCost({ usd: null, estimated: true })).toBe("—");
  });
});
