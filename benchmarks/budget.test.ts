import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "@/lib/ai/models";
import { BASELINE, CONTESTANTS } from "./contestants";
import type { AllocateFixture } from "./fixtures";
import { JUDGE, SECOND_JUDGE } from "./judge";
import { cutAdvice, estimateAllocateRun, SpendCap } from "./budget";

function fixture(id: string, baseline: AllocateFixture["baseline"]): AllocateFixture {
  return {
    id,
    topic: "t",
    sourceRun: id,
    commit: "abc",
    input: { topic: "t", weeks: 4, daysPerWeek: 5, hoursPerWeek: 5, materials: [] },
    baseline,
  };
}
const tokens = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, ms: 1000 });
const mini = CONTESTANTS["gpt-5.4-mini"];

describe("estimateAllocateRun", () => {
  it("prices every fixture and epoch at the fixture's baseline tokens, on each contestant's allocate model", () => {
    const estimate = estimateAllocateRun({
      fixtures: [fixture("a-1", tokens(10_000, 2_000))],
      contestants: [BASELINE, mini],
      epochs: 3,
      judgeDimensions: 3,
      renderedChars: 8_000,
    });
    // Opus 5.5: 10k in × $4/M + 2k out × $20/M = 0.08; gpt-5.4-mini: 0.0075 + 0.009 = 0.0165.
    expect(estimate.contestantsUsd).toBeCloseTo(3 * (0.04 + 0.04) + 3 * (0.0075 + 0.009), 4);
    expect(estimate.contestantsUsd).toBeCloseTo(0.2895, 4);
  });

  it("prices judging at the judge's rate on every sample, and the second judge on a fifth of each contestant's", () => {
    const estimate = estimateAllocateRun({
      fixtures: [fixture("a-1", tokens(10_000, 2_000)), fixture("a-2", tokens(10_000, 2_000))],
      contestants: [BASELINE, mini],
      epochs: 3,
      judgeDimensions: 3,
      renderedChars: 8_000,
    });
    const usage = { inputTokens: 8_000 / 4 + 500, outputTokens: 1_500 };
    const samples = 2 * 2 * 3;
    const secondSamples = 2 * Math.ceil((2 * 3) / 5);
    const expected = samples * 3 * estimateCostUsd(JUDGE.model, usage) + secondSamples * 3 * estimateCostUsd(SECOND_JUDGE.model, usage);
    expect(estimate.judgingUsd).toBeCloseTo(expected, 10);
    expect(estimate.totalUsd).toBeCloseTo(estimate.contestantsUsd + estimate.judgingUsd, 10);
  });

  it("gives a fixture with no baseline the mean tokens of the others", () => {
    const common = { contestants: [BASELINE], epochs: 1, judgeDimensions: 3, renderedChars: 4_000 };
    const withNull = estimateAllocateRun({
      ...common,
      fixtures: [fixture("a-1", tokens(10_000, 2_000)), fixture("a-2", tokens(30_000, 4_000)), fixture("a-3", null)],
    });
    const filled = estimateAllocateRun({
      ...common,
      fixtures: [fixture("a-1", tokens(10_000, 2_000)), fixture("a-2", tokens(30_000, 4_000)), fixture("a-3", tokens(20_000, 3_000))],
    });
    expect(withNull.contestantsUsd).toBeCloseTo(filled.contestantsUsd, 10);
  });

  it("costs the contestants nothing when no fixture has a baseline, but still prices judging", () => {
    const estimate = estimateAllocateRun({
      fixtures: [fixture("a-1", null), fixture("a-2", null)],
      contestants: [BASELINE, mini],
      epochs: 2,
      judgeDimensions: 3,
      renderedChars: 4_000,
    });
    expect(estimate.contestantsUsd).toBe(0);
    expect(estimate.judgingUsd).toBeGreaterThan(0);
    expect(estimate.totalUsd).toBe(estimate.judgingUsd);
  });

  it("falls back to the baseline's allocate model for a contestant without one", () => {
    const args = { fixtures: [fixture("a-1", tokens(10_000, 2_000))], epochs: 1, judgeDimensions: 3, renderedChars: 4_000 };
    const fallback = estimateAllocateRun({ ...args, contestants: [{ name: "outline-only", roles: {} }] });
    const base = estimateAllocateRun({ ...args, contestants: [BASELINE] });
    expect(fallback.contestantsUsd).toBeCloseTo(base.contestantsUsd, 10);
  });
});

describe("cutAdvice", () => {
  const estimate = (totalUsd: number) => ({ contestantsUsd: totalUsd / 2, judgingUsd: totalUsd / 2, totalUsd });

  it("is empty when the estimate fits the cap, even exactly", () => {
    expect(cutAdvice(estimate(8), 10, { epochs: 3, fixtures: 4, contestants: 4 })).toBe("");
    expect(cutAdvice(estimate(10), 10, { epochs: 3, fixtures: 4, contestants: 4 })).toBe("");
  });

  it("picks fewer epochs when that fits", () => {
    // 12.4 × 2/3 = 8.27
    expect(cutAdvice(estimate(12.4), 10, { epochs: 3, fixtures: 4, contestants: 4 })).toBe(
      "Estimated $12.40 over the $10.00 cap. Fits with --epochs 2 ($8.27).",
    );
  });

  it("takes the most epochs that fit before cutting anything else", () => {
    // 3 epochs 40; 2 epochs 26.67; 1 epoch 13.33 fits 25.
    expect(cutAdvice(estimate(40), 25, { epochs: 3, fixtures: 4, contestants: 4 })).toBe(
      "Estimated $40.00 over the $25.00 cap. Fits with --epochs 1 ($13.33).",
    );
  });

  it("falls back to fewer fixtures, at the epochs asked for, when one epoch is not enough", () => {
    // epochs 1: 20 > 15; fixtures 3: 30, 2: 20, 1: 10 fits.
    expect(cutAdvice(estimate(40), 15, { epochs: 2, fixtures: 4, contestants: 4 })).toBe(
      "Estimated $40.00 over the $15.00 cap. Fits with --fixtures, using 1 fixture ($10.00).",
    );
  });

  it("takes the most fixtures that fit", () => {
    expect(cutAdvice(estimate(40), 25, { epochs: 1, fixtures: 4, contestants: 4 })).toBe(
      "Estimated $40.00 over the $25.00 cap. Fits with --fixtures, using 2 fixtures ($20.00).",
    );
  });

  it("falls back to fewer contestants after epochs and fixtures", () => {
    // contestants 4: 80, 3: 60, 2: 40 fits.
    expect(cutAdvice(estimate(100), 40, { epochs: 1, fixtures: 1, contestants: 5 })).toBe(
      "Estimated $100.00 over the $40.00 cap. Fits with --contestants, using 2 contestants ($40.00).",
    );
  });

  it("says the cap is too low when even the smallest run does not fit", () => {
    // 1 epoch, 1 fixture, the baseline and one more: 100 / 2 / 2 × 2/3.
    expect(cutAdvice(estimate(100), 1, { epochs: 2, fixtures: 2, contestants: 3 })).toBe(
      "Estimated $100.00 over the $1.00 cap. The cap is too low for even the smallest run ($16.67).",
    );
  });
});

describe("SpendCap", () => {
  it("is reached once spend passes the cap", () => {
    const cap = new SpendCap(10);
    cap.add(6);
    expect(cap.reached).toBe(false);
    cap.add(4.01);
    expect(cap.spentUsd).toBeCloseTo(10.01, 10);
    expect(cap.reached).toBe(true);
  });

  it("is not reached at exactly the cap", () => {
    const cap = new SpendCap(10);
    cap.add(10);
    expect(cap.reached).toBe(false);
  });
});
