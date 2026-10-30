import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { estimateCostUsd } from "./models";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { effortSettings, loggedGenerateObject, type GenerationLogRow, type ModelCall } from "./logged";

const mockedGenerateObject = vi.mocked(generateObject);

const schema = z.object({ answer: z.string() });

function mockResult(overrides: Partial<{ inputTokens: number; outputTokens: number }> = {}) {
  return {
    object: { answer: "42" },
    usage: {
      inputTokens: 1_000,
      inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: undefined },
      outputTokens: 500,
      outputTokenDetails: { textTokens: 400, reasoningTokens: 100 },
      totalTokens: 1_500,
      ...overrides,
    },
  } as unknown as Awaited<ReturnType<typeof generateObject>>;
}

describe("loggedGenerateObject", () => {
  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("returns the object plus timing and cost, and forwards model/schema/prompt to generateObject", async () => {
    mockedGenerateObject.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return mockResult();
    });

    const result = await loggedGenerateObject(
      { model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" },
      { caller: "outline" },
    );

    expect(result.object).toEqual({ answer: "42" });
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.costUsd).toBe(
      estimateCostUsd("anthropic/claude-haiku-4.5", { inputTokens: 1_000, outputTokens: 500 }),
    );
    expect(mockedGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" }),
    );
  });

  it("emits one normalized row to onLog", async () => {
    mockedGenerateObject.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return mockResult();
    });
    const rows: GenerationLogRow[] = [];

    await loggedGenerateObject(
      { model: "anthropic/claude-sonnet-5", schema, prompt: "hi" },
      { caller: "daily", trackId: "track-1", userId: "user-1", onLog: (row) => void rows.push(row) },
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      caller: "daily",
      model: "anthropic/claude-sonnet-5",
      effort: null,
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 200,
      reasoningTokens: 100,
      trackId: "track-1",
      userId: "user-1",
    });
    expect(row.latencyMs).toBeGreaterThan(0);
    expect(row.costUsd).toBe(
      estimateCostUsd("anthropic/claude-sonnet-5", { inputTokens: 1_000, outputTokens: 500 }),
    );
  });

  it("sends an effort as the Anthropic provider option and records it on the row", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    const rows: GenerationLogRow[] = [];
    await loggedGenerateObject(
      { model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi", effort: "low" },
      { caller: "research", onLog: (row) => void rows.push(row) },
    );
    expect(mockedGenerateObject).toHaveBeenCalledWith(expect.objectContaining({ providerOptions: { anthropic: { effort: "low" } } }));
    expect(rows[0].effort).toBe("low");
  });

  it("records the effort on the log row whatever the provider, sending other providers the portable setting", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    const rows: GenerationLogRow[] = [];
    await loggedGenerateObject(
      { model: "openai/gpt-5.4", schema, prompt: "hi", effort: "high" },
      { caller: "research", onLog: (row) => void rows.push(row) },
    );
    expect(mockedGenerateObject).toHaveBeenCalledWith(expect.objectContaining({ reasoning: "high" }));
    expect(mockedGenerateObject.mock.calls[0][0]).not.toHaveProperty("providerOptions");
    expect(rows[0].effort).toBe("high");
  });

  it("records who paid: the app by default, the user when the context or the call says so", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    const rows: GenerationLogRow[] = [];
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi" }, { caller: "research", onLog: (row) => void rows.push(row) });
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi" }, { caller: "research", keyOwner: "user", onLog: (row) => void rows.push(row) });
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5.5", schema, prompt: "hi", keyOwner: "user" }, { caller: "daily", onLog: (row) => void rows.push(row) });
    expect(rows.map((r) => r.keyOwner)).toEqual(["app", "user", "user"]);
  });

  it("sends no provider options when no effort is given", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    await loggedGenerateObject({ model: "anthropic/claude-sonnet-5", schema, prompt: "hi" }, { caller: "daily" });
    expect(mockedGenerateObject.mock.calls[0][0]).not.toHaveProperty("providerOptions");
  });

  it("hands the whole call to onCall: prompt, raw JSON response, label and finish reason", async () => {
    mockedGenerateObject.mockResolvedValue({ ...mockResult(), finishReason: "stop" } as unknown as Awaited<
      ReturnType<typeof generateObject>
    >);
    const calls: ModelCall[] = [];

    await loggedGenerateObject(
      { model: "anthropic/claude-haiku-4.5", schema, prompt: "hi", label: "Revision" },
      { caller: "outline_revision", userId: "user-1", onCall: (call) => void calls.push(call) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      caller: "outline_revision",
      userId: "user-1",
      label: "Revision",
      system: null,
      prompt: "hi",
      response: JSON.stringify({ answer: "42" }, null, 2),
      finishReason: "stop",
      facts: [],
      inputTokens: 1_000,
    });
  });

  it("labels the call by its caller when no label is given", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    const onCall = vi.fn();
    await loggedGenerateObject({ model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" }, { caller: "daily", onCall });
    expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ label: "daily", finishReason: null }));
  });

  it("maps undefined usage counts to null and omitted meta to null", async () => {
    mockedGenerateObject.mockResolvedValue({
      object: { answer: "42" },
      usage: {
        inputTokens: undefined,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const rows: GenerationLogRow[] = [];

    await loggedGenerateObject(
      { model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" },
      { caller: "outline", onLog: (row) => void rows.push(row) },
    );

    expect(rows[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      trackId: null,
      userId: null,
      costUsd: 0,
    });
  });

  it("has no side effect when onLog is omitted", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    await expect(
      loggedGenerateObject({ model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" }, { caller: "outline" }),
    ).resolves.toBeDefined();
  });

  it("still returns the generation when onLog throws", async () => {
    mockedGenerateObject.mockResolvedValue(mockResult());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await loggedGenerateObject(
      { model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" },
      {
        caller: "outline",
        onLog: async () => {
          throw new Error("db down");
        },
      },
    );

    expect(result.object).toEqual({ answer: "42" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not log when generateObject rejects", async () => {
    mockedGenerateObject.mockRejectedValue(new Error("gateway 500"));
    const onLog = vi.fn();

    await expect(
      loggedGenerateObject({ model: "anthropic/claude-haiku-4.5", schema, prompt: "hi" }, { caller: "outline", onLog }),
    ).rejects.toThrow("gateway 500");
    expect(onLog).not.toHaveBeenCalled();
  });
});

describe("effortSettings", () => {
  it("sends Anthropic models their effort as a provider option, as before", () => {
    expect(effortSettings("high", "anthropic/claude-opus-5.5")).toEqual({ providerOptions: { anthropic: { effort: "high" } } });
  });

  it("sends other providers the portable reasoning setting", () => {
    expect(effortSettings("medium", "google/gemini-3-flash")).toEqual({ reasoning: "medium" });
    expect(effortSettings("high", "openai/gpt-5.4-mini")).toEqual({ reasoning: "high" });
  });

  it("treats a direct Anthropic instance (a user's key) as Anthropic", () => {
    const instance = { modelId: "claude-sonnet-5-5", provider: "anthropic.messages" } as unknown as LanguageModel;
    expect(effortSettings("low", instance)).toEqual({ providerOptions: { anthropic: { effort: "low" } } });
  });
});
