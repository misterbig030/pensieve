import { describe, expect, it } from "vitest";
import {
  ALLOCATE_EFFORT,
  AVAILABLE_MODELS,
  DEFAULT_ALLOCATE_MODEL,
  DEFAULT_OUTLINE_MODEL,
  DEFAULT_RESEARCH_MODEL,
  OUTLINE_EFFORT,
  RESEARCH_LOOP_EFFORT,
  estimateCostUsd,
  type AiModelId,
} from "@/lib/ai/models";
import { assertPriced, BASELINE, CONTESTANTS, contestantsFor } from "./contestants";

describe("BASELINE", () => {
  it("is the app's default model and effort for each role", () => {
    expect(BASELINE.name).toBe("baseline");
    expect(BASELINE.roles).toEqual({
      allocate: { model: DEFAULT_ALLOCATE_MODEL, effort: ALLOCATE_EFFORT },
      outline: { model: DEFAULT_OUTLINE_MODEL, effort: OUTLINE_EFFORT },
      research: { model: DEFAULT_RESEARCH_MODEL, effort: RESEARCH_LOOP_EFFORT },
    });
  });
});

describe("CONTESTANTS", () => {
  it("gives each rival its model in every role at the baseline's effort for that role", () => {
    expect(Object.keys(CONTESTANTS)).toEqual([
      "baseline",
      "sonnet-5.5",
      "haiku-4.5",
      "gemini-3-flash",
      "gemini-3.1-pro",
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-6.1-sol",
      "gemini-4-argon",
      "gpt-6.1-terra",
      "gemini-3.8-flash",
      "deepseek-v4-pro",
      "haiku-5.5",
      "gpt-6-luna",
      "gemini-4-argon@medium",
      "gemini-4-argon@low",
      "gemini-3.8-flash@medium",
      "gemini-3.8-flash@low",
      "deepseek-v4-pro@medium",
      "deepseek-v4-pro@low",
    ]);
  });

  it("runs an effort variant at its own effort in every role", () => {
    expect(CONTESTANTS["gemini-3.8-flash@low"]).toEqual({
      name: "gemini-3.8-flash@low",
      roles: {
        allocate: { model: "google/gemini-3.8-flash", effort: "low" },
        outline: { model: "google/gemini-3.8-flash", effort: "low" },
        research: { model: "google/gemini-3.8-flash", effort: "low" },
      },
    });
    expect(CONTESTANTS["gemini-3.1-pro"].roles).toEqual({
      allocate: { model: "google/gemini-3.1-pro-preview", effort: ALLOCATE_EFFORT },
      outline: { model: "google/gemini-3.1-pro-preview", effort: OUTLINE_EFFORT },
      research: { model: "google/gemini-3.1-pro-preview", effort: RESEARCH_LOOP_EFFORT },
    });
  });

  it("runs DeepSeek V4 Pro at its gateway price, $0.66 in and $1.98 out per million", () => {
    expect(CONTESTANTS["deepseek-v4-pro"].roles.allocate).toEqual({ model: "deepseek/deepseek-v4-pro", effort: ALLOCATE_EFFORT });
    expect(estimateCostUsd("deepseek/deepseek-v4-pro", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(2.64, 5);
  });

  it("only uses priced models", () => {
    for (const contestant of Object.values(CONTESTANTS)) expect(() => assertPriced(contestant)).not.toThrow();
  });
});

describe("contestantsFor", () => {
  it("puts baseline first and refuses an unknown model", () => {
    expect(contestantsFor(["gpt-5.4-mini"]).map((c) => c.name)).toEqual(["baseline", "gpt-5.4-mini"]);
    expect(() => contestantsFor(["nope"])).toThrow('Unknown contestant "nope"');
    expect(() => contestantsFor(["nope"])).toThrow("known: baseline, sonnet-5.5");
  });

  it("keeps baseline first and once when it is named", () => {
    expect(contestantsFor(["haiku-4.5", "baseline"]).map((c) => c.name)).toEqual(["baseline", "haiku-4.5"]);
    expect(contestantsFor([]).map((c) => c.name)).toEqual(["baseline"]);
  });
});

describe("assertPriced", () => {
  it("throws for a model missing from AVAILABLE_MODELS", () => {
    const unlisted = { name: "x", roles: { outline: { model: "acme/model-1" as AiModelId, effort: "low" as const } } };
    expect(AVAILABLE_MODELS.some((m) => m.id === unlisted.roles.outline.model)).toBe(false);
    expect(() => assertPriced(unlisted)).toThrow('Model "acme/model-1" has no price in AVAILABLE_MODELS');
  });
});
