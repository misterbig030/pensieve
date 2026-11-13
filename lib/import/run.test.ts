import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), generateObject: vi.fn() }));
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { ResolvedModel } from "@/lib/ai/resolve";
import type { GenerationLogRow } from "@/lib/ai/logged";
import { WEEKLY_PLAN_DRAFT } from "./__fixtures__/weekly-plan.draft";
import { UNSAVABLE_PLAN_MESSAGE, runImport } from "./run";

const mockedGenerateObject = vi.mocked(generateObject);
const instance = { modelId: "claude-sonnet-5", provider: "anthropic.messages" } as unknown as LanguageModel;
const model: ResolvedModel = { model: instance, id: "anthropic/claude-sonnet-5" as ResolvedModel["id"], keyOwner: "user" };

beforeEach(() => {
  mockedGenerateObject.mockReset();
  mockedGenerateObject.mockResolvedValue({
    object: WEEKLY_PLAN_DRAFT,
    usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
    finishReason: "stop",
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("runImport", () => {
  it("returns the converted plan", async () => {
    const { result } = await runImport({ fileName: "weekly-plan.md", text: "# Plan", model });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.tree).toHaveLength(8);
  });

  it("logs caller import", async () => {
    const rows: GenerationLogRow[] = [];
    await runImport({ fileName: "weekly-plan.md", text: "# Plan", model, log: { onLog: (r) => void rows.push(r) } });
    expect(rows).toHaveLength(1);
    expect(rows[0].caller).toBe("import");
  });

  it("refuses a converted plan the app could not save, and logs why", async () => {
    // A week of 70 days: the converter copies it, but a saved week holds at most 60 units below it.
    const days = Array.from({ length: 70 }, (_, i) => ({ title: `Day ${i + 1}`, summary: "s", budgetHours: null, reading: [], practice: [], children: null }));
    const draft = { ...WEEKLY_PLAN_DRAFT, units: [{ title: "Week 1", summary: "s", budgetHours: null, reading: [], practice: [], children: days }] };
    mockedGenerateObject.mockResolvedValueOnce({
      object: draft,
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
      finishReason: "stop",
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await runImport({ fileName: "weekly-plan.md", text: "# Plan", model });
    expect(result).toEqual({ ok: false, reason: "unsavable", message: UNSAVABLE_PLAN_MESSAGE });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[import]"), expect.anything());
    error.mockRestore();
  });

  it("passes the user's model instance", async () => {
    await runImport({ fileName: "weekly-plan.md", text: "# Plan", model });
    expect(mockedGenerateObject.mock.calls[0][0].model).toBe(instance);
  });
});
