import { describe, expect, it } from "vitest";
import { AVAILABLE_MODELS, CANDIDATE_STEP_EFFORT, OUTLINE_EFFORT, DEFAULT_CHAT_MODEL, DEFAULT_OUTLINE_MODEL, DEFAULT_CONTENT_MODEL, DEFAULT_RESEARCH_MODEL, MODEL_PROVIDERS, RESEARCH_LOOP_EFFORT, estimateCostUsd, providerOf } from "./models";

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
  });

  it("the outline runs on Opus 5.5 at high effort", () => {
    expect(DEFAULT_OUTLINE_MODEL).toBe("anthropic/claude-opus-5.5");
    expect(OUTLINE_EFFORT).toBe("high");
  });

  it("knows every listed model's provider, which is the id's prefix", () => {
    for (const model of AVAILABLE_MODELS) expect(MODEL_PROVIDERS).toContain(providerOf(model.id));
    expect(providerOf("anthropic/claude-sonnet-5.5")).toBe("anthropic");
    expect(providerOf("google/gemini-3-flash")).toBe("google");
    expect(providerOf("openai/gpt-5.4-mini")).toBe("openai");
    expect(AVAILABLE_MODELS.map((m) => m.id)).toContain(DEFAULT_CHAT_MODEL);
  });
});

describe("estimateCostUsd", () => {
  it("prices fresh input, cached input and output at the model's list price", () => {
    // Opus 5.5: $4 in, $0.20 cached in, $20 out per million tokens.
    const usd = estimateCostUsd("anthropic/claude-opus-5.5", { inputTokens: 10_000, cacheReadTokens: 2_000, outputTokens: 1_000 });
    expect(usd).toBeCloseTo(8_000 * 4e-6 + 2_000 * 0.2e-6 + 1_000 * 20e-6, 10);
  });

  it("counts missing token counts as none", () => {
    expect(estimateCostUsd("anthropic/claude-haiku-4.5", { inputTokens: null, cacheReadTokens: null, outputTokens: 1_000_000 })).toBeCloseTo(5, 10);
  });

  it("has no estimate for a model it has no price for", () => {
    expect(estimateCostUsd("anthropic/claude-gone" as never, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })).toBeNull();
  });

  it("knows a price for every model in the list", () => {
    for (const model of AVAILABLE_MODELS) expect(estimateCostUsd(model.id, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })).toBeGreaterThan(0);
  });
});
