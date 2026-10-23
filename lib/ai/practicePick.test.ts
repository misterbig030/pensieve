import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), generateObject: vi.fn() }));
import { APICallError, generateObject } from "ai";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY } from "@/lib/practice";
import type { ModelCall } from "./logged";
import { buildPracticePickPrompt, pickPractice } from "./practicePick";
import { appModel } from "./resolve";

const mockedGenerateObject = vi.mocked(generateObject);

const brief = { topic: "Software engineering interviews", weeks: 6, daysPerWeek: 5, hoursPerWeek: 8, sources: [] };

function respond(object: unknown) {
  mockedGenerateObject.mockResolvedValueOnce({
    object,
    usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
    finishReason: "stop",
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
}

describe("buildPracticePickPrompt", () => {
  it("lists every format with its line and gives the worked examples", () => {
    const prompt = buildPracticePickPrompt(brief);
    for (const f of PRACTICE_FORMATS) expect(prompt).toContain(PRACTICE_REGISTRY[f].prompt);
    for (const example of ["an SDE interview loop", "an MLE interview loop", "a history topic", "Git", "Couch to 5K"]) {
      expect(prompt).toContain(example);
    }
  });

  it("puts the learner's instructions above the examples", () => {
    const prompt = buildPracticePickPrompt({ ...brief, instructions: "No apps and no video" });
    expect(prompt).toContain("No apps and no video");
    expect(prompt).toContain("The learner's instructions win over the examples.");
    expect(prompt.indexOf("No apps and no video")).toBeLessThan(prompt.indexOf("an SDE interview loop"));
  });
});

describe("pickPractice", () => {
  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("returns the normalised split", async () => {
    respond({
      readingShare: 30,
      practice: "interview practice",
      reason: "r",
      picks: [
        { format: "problem-set", share: 50, focus: "arrays", reason: "x" },
        { format: "mock", share: 50, focus: "behavioral", reason: "y" },
      ],
    });
    const calls: ModelCall[] = [];
    const { split, costUsd } = await pickPractice({ ...brief, model: appModel("anthropic/claude-sonnet-5.5"), log: { onCall: (c) => void calls.push(c) } });
    expect(split.readingShare).toBe(30);
    expect(split.formats?.map((p) => [p.format, p.share])).toEqual([["problem-set", 50], ["mock", 50]]);
    expect(costUsd).toBeGreaterThanOrEqual(0);
    expect(calls[0].label).toBe("Practice · pick");
    expect(calls[0].facts.join(" ")).toContain("problem-set 50%");
  });

  it("falls back to all reading when the model returns nothing usable", async () => {
    respond({ readingShare: "lots", practice: "", reason: "", picks: [] });
    const calls: ModelCall[] = [];
    const { split } = await pickPractice({ ...brief, model: appModel("anthropic/claude-sonnet-5.5"), log: { onCall: (c) => void calls.push(c) } });
    expect(split).toEqual({ readingShare: 100, practice: "reading", reason: "", formats: [] });
    expect(calls[0].facts).toContain("no split returned");
  });

  it("falls back to all reading and says so when the model leaves the picks out", async () => {
    respond({ readingShare: 40, practice: "practice", reason: "r" });
    const calls: ModelCall[] = [];
    const { split } = await pickPractice({ ...brief, model: appModel("anthropic/claude-sonnet-5.5"), log: { onCall: (c) => void calls.push(c) } });
    expect(split).toEqual({ readingShare: 100, practice: "reading", reason: "", formats: [] });
    expect(calls[0].facts).toContain("no picks returned");
  });

  it("falls back to all reading when the call itself fails on the app's key", async () => {
    mockedGenerateObject.mockRejectedValueOnce(new Error("No object generated: response did not match schema."));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { split, costUsd } = await pickPractice({ ...brief, model: appModel("anthropic/claude-sonnet-5.5") });
    expect(split).toEqual({ readingShare: 100, practice: "reading", reason: "", formats: [] });
    expect(costUsd).toBe(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("lets a provider refusal on the learner's own key through, for the key guard to name", async () => {
    const refusal = new APICallError({ message: "invalid x-api-key", url: "https://api.anthropic.com", requestBodyValues: {}, statusCode: 401 });
    mockedGenerateObject.mockRejectedValueOnce(refusal);
    await expect(pickPractice({ ...brief, model: { ...appModel("anthropic/claude-sonnet-5.5"), keyOwner: "user" } })).rejects.toBe(refusal);
  });

  it("passes the request's abort signal and stops when the request is gone", async () => {
    const controller = new AbortController();
    controller.abort();
    mockedGenerateObject.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(pickPractice({ ...brief, model: appModel("anthropic/claude-sonnet-5.5"), signal: controller.signal })).rejects.toThrow("aborted");
    expect(mockedGenerateObject.mock.calls[0][0]).toMatchObject({ abortSignal: controller.signal });
  });
});
