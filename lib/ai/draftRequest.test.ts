import { describe, expect, it } from "vitest";
import { DEFAULT_HOURS_PER_WEEK } from "@/lib/studyTime";
import type { ResolvedModels } from "./resolve";
import { appModel } from "./resolve";
import { researchedDraftInput, type DraftRequestBody } from "./draftRequest";
import { DEFAULT_ALLOCATE_MODEL, DEFAULT_OUTLINE_MODEL, DEFAULT_RESEARCH_MODEL } from "./models";

const models = {
  outline: appModel(DEFAULT_OUTLINE_MODEL),
  content: appModel(DEFAULT_OUTLINE_MODEL),
  chat: appModel(DEFAULT_OUTLINE_MODEL),
  research: appModel(DEFAULT_RESEARCH_MODEL),
  allocate: appModel(DEFAULT_ALLOCATE_MODEL),
  keyErrors: {},
} satisfies ResolvedModels;

const request: DraftRequestBody = {
  topic: "Linear algebra",
  weeks: 6,
  daysPerWeek: 5,
  granularity: "week",
  instructions: "",
  materials: [],
};

const env = { TAVILY_API_KEY: "test-key" };

describe("researchedDraftInput", () => {
  it("builds the route's draft input", () => {
    const signal = new AbortController().signal;
    const log = { userId: "u1", keyOwner: "app" as const };
    const input = researchedDraftInput({ request, models, deadline: 123, signal, log, env });

    expect(input).toMatchObject({
      topic: "Linear algebra",
      weeks: 6,
      daysPerWeek: 5,
      granularity: "week",
      instructions: undefined,
      materials: [],
      hoursPerWeek: DEFAULT_HOURS_PER_WEEK,
      outlineModel: models.outline,
      allocateModel: models.allocate,
      deadline: 123,
    });
    expect(input.signal).toBe(signal);
    expect(input.log).toBe(log);
    expect(input.arm).not.toBeNull();
    expect(input.research?.structure).toBeDefined();
  });

  it("keeps the requested hours and instructions", () => {
    const input = researchedDraftInput({
      request: { ...request, hoursPerWeek: 4, instructions: "focus on proofs" },
      models,
      deadline: 1,
      log: {},
      env,
    });
    expect(input.hoursPerWeek).toBe(4);
    expect(input.instructions).toBe("focus on proofs");
  });

  it("wraps the models only when the log reports services", () => {
    const plain = researchedDraftInput({ request, models, deadline: 1, log: {}, env });
    expect(plain.outlineModel).toBe(models.outline);
    expect(plain.allocateModel).toBe(models.allocate);

    const reported = researchedDraftInput({ request, models, deadline: 1, log: { onService: () => {} }, env });
    for (const [wrapped, resolved] of [
      [reported.outlineModel, models.outline],
      [reported.allocateModel, models.allocate],
    ] as const) {
      expect(typeof wrapped?.model).toBe("object");
      expect((wrapped?.model as { modelId: string }).modelId).toBe(resolved.id);
      expect(wrapped?.id).toBe(resolved.id);
      expect(wrapped?.keyOwner).toBe(resolved.keyOwner);
    }
  });
});
