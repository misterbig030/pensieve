import { describe, expect, it, vi } from "vitest";
import { generateText, TypeValidationError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import { reportServiceFailure, reportingModel, type ServiceEvent } from "./serviceEvents";

function apiError(statusCode: number): APICallError {
  return new APICallError({ message: `status ${statusCode}`, url: "https://api.anthropic.com", requestBodyValues: {}, statusCode });
}

const GENERATED = {
  content: [{ type: "text" as const, text: "hi" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

describe("reportingModel", () => {
  it("reports a failed attempt and rethrows; a successful attempt reports nothing", async () => {
    let calls = 0;
    const inner = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++calls === 1) throw apiError(529);
        return GENERATED;
      },
    });
    const onService = vi.fn();
    const result = await generateText({ model: reportingModel(inner, onService), prompt: "p", maxRetries: 1 });
    expect(result.text).toBe("hi");
    expect(calls).toBe(2);
    expect(onService).toHaveBeenCalledTimes(1);
    expect(onService).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service", name: "anthropic", ok: false, final: false, status: 529, ms: expect.any(Number) }),
    );
  });

  it("reports nothing for an attempt its caller aborted, and still reports a timeout", async () => {
    const aborted = new AbortController();
    const hung = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        aborted.abort(new Error("clock"));
        throw abortSignal?.reason;
      },
    });
    const onService = vi.fn();
    await expect(generateText({ model: reportingModel(hung, onService), prompt: "p", maxRetries: 0, abortSignal: aborted.signal })).rejects.toThrow();
    expect(onService).not.toHaveBeenCalled();

    const timedOut = AbortSignal.timeout(1);
    const slow = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw abortSignal?.reason;
      },
    });
    await expect(generateText({ model: reportingModel(slow, onService), prompt: "p", maxRetries: 0, abortSignal: timedOut })).rejects.toThrow();
    expect(onService).toHaveBeenCalledWith(expect.objectContaining({ name: "anthropic", ok: false, final: false }));
  });

  it("keeps the inner model id", () => {
    expect(reportingModel("anthropic/claude-sonnet-5.5", vi.fn())).toHaveProperty("modelId", "anthropic/claude-sonnet-5.5");
  });
});

describe("reportServiceFailure", () => {
  it("reports a final failure only for a provider error or a timeout", () => {
    const events: ServiceEvent[] = [];
    const log = { onService: (e: ServiceEvent) => events.push(e) };

    reportServiceFailure(log, apiError(400), "structure");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "service", name: "anthropic", ok: false, final: true, status: 400, where: "structure" });

    reportServiceFailure(log, new TypeValidationError({ value: 1, cause: new Error("bad") }), "structure");
    expect(events).toHaveLength(1);

    reportServiceFailure(log, new DOMException("x", "TimeoutError"), "outline");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ final: true, where: "outline" });
    expect(events[1].status).toBeUndefined();

    expect(() => reportServiceFailure(undefined, apiError(500), "x")).not.toThrow();
  });

  it("reports an error once, however many catch sites it passes through", () => {
    const events: ServiceEvent[] = [];
    const log = { onService: (e: ServiceEvent) => events.push(e) };
    const refusal = apiError(400);
    reportServiceFailure(log, refusal, "items");
    reportServiceFailure(log, refusal, "structure");
    reportServiceFailure(log, new Error("wrapped", { cause: refusal }), "arm");
    expect(events).toHaveLength(1);
    expect(events[0].where).toBe("items");
  });

  it("does not take an abort for a timeout", () => {
    const events: ServiceEvent[] = [];
    const caller = new AbortController();
    caller.abort(new Error("clock"));
    reportServiceFailure({ onService: (e) => events.push(e) }, new DOMException("This operation was aborted", "AbortError"), "x");
    reportServiceFailure({ onService: (e) => events.push(e) }, caller.signal.reason, "x");
    expect(events).toEqual([]);
  });
});
