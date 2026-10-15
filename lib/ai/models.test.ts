import { describe, expect, it } from "vitest";
import { AVAILABLE_MODELS, CANDIDATE_STEP_EFFORT, DEFAULT_OUTLINE_MODEL, DEFAULT_CONTENT_MODEL, DEFAULT_RESEARCH_MODEL, RESEARCH_LOOP_EFFORT, estimateCostUsd } from "./models";

describe("AVAILABLE_MODELS", () => {
  it("every model id matches the provider/model gateway format", () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
    }
  });

  it("defaults point at ids present in the list", () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id);
    expect(ids).toContain(DEFAULT_OUTLINE_MODEL);
    expect(ids).toContain(DEFAULT_CONTENT_MODEL);
    expect(ids).toContain(DEFAULT_RESEARCH_MODEL);
  });

  it("research runs on Sonnet 5.5: the loops at high effort, the candidate step at low; priced like Sonnet 5", () => {
    // Measured 2026-10-13/14 (evals/research/candidates-bench.ts, effort-bench.ts): at low the workers used 2 of 12 reads
    // and declared the backbone from snippets; at high they used all 12. The candidate step at low chose the same list
    // from good notes in 8 s that it chose in 25 s at high.
    expect(DEFAULT_RESEARCH_MODEL).toBe("anthropic/claude-sonnet-5.5");
    expect(RESEARCH_LOOP_EFFORT).toBe("high");
    expect(CANDIDATE_STEP_EFFORT).toBe("low");
    expect(estimateCostUsd("anthropic/claude-sonnet-5.5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(12, 5);
  });

  it("lists Opus 5.5 at its gateway price, $4 in and $20 out per million", () => {
    expect(estimateCostUsd("anthropic/claude-opus-5.5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(24, 5);
  });

  it("every model has positive input and output pricing", () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model.pricing.input).toBeGreaterThan(0);
      expect(model.pricing.output).toBeGreaterThan(0);
    }
  });
});

describe("estimateCostUsd", () => {
  it("computes cost from input/output token counts at the model's list price", () => {
    // claude-sonnet-5: $2/M input, $10/M output
    const cost = estimateCostUsd("anthropic/claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(12, 5);
  });

  it("treats missing token counts as zero", () => {
    const cost = estimateCostUsd("anthropic/claude-sonnet-5", {});
    expect(cost).toBe(0);
  });

  it("returns 0 for an unknown model id", () => {
    // @ts-expect-error - intentionally passing an id outside AiModelId to test the fallback
    const cost = estimateCostUsd("anthropic/does-not-exist", { inputTokens: 100, outputTokens: 100 });
    expect(cost).toBe(0);
  });
});
