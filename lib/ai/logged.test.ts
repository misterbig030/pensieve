import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { estimateCostUsd } from "./models";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { loggedGenerateObject, type GenerationLogRow } from "./logged";

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
