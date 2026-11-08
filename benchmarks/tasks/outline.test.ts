import { APICallError, JSONParseError, NoContentGeneratedError, NoObjectGeneratedError, RetryError, StreamProviderError, TypeValidationError } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import type { draftLevel } from "@/lib/ai/planDraft";
import type { ResolvedModel } from "@/lib/ai/resolve";
import type { Breach } from "@/lib/materials";
import { layout, makeRoot, type PlanNode } from "@/lib/planTree";
import type { ChapterList, Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";
import { BASELINE } from "../contestants";
import { listPriceUsd } from "../price";
import type { Contestant } from "../types";
import type { OutlineFixture } from "./outlineFixtures";
import { JUDGE_INSTRUCTIONS } from "../judge";
import { codeResults, judgeCriteriaFor, OUTLINE_CRITERIA, OUTLINE_JUDGE_INSTRUCTIONS, renderOutline, runOutlineSample, type OutlineOutput } from "./outline";
import { minutesOffSize, setAsideOffSize } from "./outlineChecks";

// The size checks as they are, counted, so a test can see how often a level is sized.
vi.mock("./outlineChecks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outlineChecks")>();
  return { ...actual, minutesOffSize: vi.fn(actual.minutesOffSize), setAsideOffSize: vi.fn(actual.setAsideOffSize) };
});

function chapters(minutes: number[]): ChapterList {
  return {
    source: "catalogue",
    url: "https://example.com/toc",
    printPages: false,
    end: null,
    chapters: minutes.map((m, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, sections: [], minutes: m })),
  };
}

function material(id: string, title: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "book", url: `https://x/${id}`, title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 600, ...extra } as Material;
}

function node(extra: Partial<PlanNode>): PlanNode {
  return { id: "n", level: "day", title: "t", summary: "s", len: 1, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1, ...extra };
}

const BOOK = material("csapp", "Computer Systems: A Programmer's Perspective", { toc: chapters([120, 120, 120]), backbone: true });
const ESSAY = material("essay", "What every programmer should know about memory", { kind: "essay", toc: null, minutes: 90 });

const WEEK: PlanNode = node({
  id: "w1",
  level: "week",
  title: "Bits and bytes",
  summary: "How data is stored",
  len: 2,
  covers: [{ id: "csapp", chapter: 1, note: null }],
  time: { reading: 240, practice: {} },
});

const TREE = layout(makeRoot([WEEK, node({ id: "w2", level: "week", title: "Machine code", summary: "Assembly", len: 2 })]));

const REQUEST: OutlineFixture["request"] = { topic: "Computer systems", granularity: "day", weeks: 2, daysPerWeek: 2, hoursPerWeek: 4 };

const LEAF: OutlineFixture = {
  id: "csapp-1/week-1",
  topic: "csapp",
  sourceRun: "run",
  commit: "abc1234",
  label: "Week 1 · 2 days",
  group: "leaves",
  leaf: true,
  request: REQUEST,
  materials: [BOOK],
  split: { readingShare: 100, practice: "reading", reason: "", formats: [] },
  level: "day",
  spans: [1, 1],
  tree: TREE,
  parentId: "w1",
  timeLimitMs: 197_295,
  baseline: { inputTokens: 20_000, outputTokens: 4_000, ms: 30_000 },
};

const HEADING: OutlineFixture = { ...LEAF, id: "csapp-1/top", label: "Top level · 2 weeks", group: "top", leaf: false, level: "week", spans: [2, 2], tree: undefined, parentId: undefined };

const DAY_UNITS: UnitDraft[] = [
  { title: "Bits", summary: "How numbers are stored", materials: [{ id: "M1.1", tier: "must", minutes: 60, note: "Sections 1.1–1.4" }] },
  { title: "Bytes", summary: "How bytes are ordered", materials: [{ id: "M1.1", tier: "must", minutes: 60, note: "Sections 1.5–1.9" }] },
];

const DAYS: PlanNode[] = [
  node({ id: "d1", title: "Bits", summary: "How numbers are stored", materials: [{ id: "csapp", chapter: 1, tier: "must", minutes: 60, note: "Sections 1.1–1.4" }] }),
  node({ id: "d2", title: "Bytes", summary: "How bytes are ordered", materials: [{ id: "csapp", chapter: 1, tier: "must", minutes: 60, note: "Sections 1.5–1.9" }] }),
];

function breach(kind: Breach["kind"], text = `${kind} on Day 1`): Breach {
  return { kind, index: 0, unit: "Day 1", refs: [], names: "", text };
}

function leafOutput(extra: Partial<OutlineOutput> = {}): OutlineOutput {
  return { nodes: DAYS, units: DAY_UNITS, breaches: [], problems: [], ...extra };
}

const result = (out: OutlineOutput, id: string, fixture = LEAF) => codeResults(out, { fixture }).find((r) => r.id === id);

describe("outline criteria", () => {
  it("prefixes every id by its kind, and gives judge criteria the kind's dimension", () => {
    for (const c of OUTLINE_CRITERIA) {
      expect(c.id).toMatch(/^(leaf|head)-/);
      if (c.grader === "judge") expect(c.dimension).toBe(c.id.startsWith("leaf-") ? "leaf" : "heading");
    }
  });

  it("leaves ids to the code criteria: the judge's words criteria do not ask about them", () => {
    // The judge reads the level after the app put ids in words, so it would always find none.
    for (const id of ["leaf-words-judge", "head-words-judge"]) {
      const c = OUTLINE_CRITERIA.find((x) => x.id === id)!;
      expect(c.text, id).not.toMatch(/\bids?\b/i);
    }
  });
});

describe("OUTLINE_JUDGE_INSTRUCTIONS", () => {
  it("tells the judge it grades one level of an outline, not an allocation", () => {
    expect(OUTLINE_JUDGE_INSTRUCTIONS).toMatch(/one level of a study plan's outline/);
    expect(OUTLINE_JUDGE_INSTRUCTIONS).not.toMatch(/allocation/i);
    expect(OUTLINE_JUDGE_INSTRUCTIONS).toContain("Judge each criterion on its own");
  });

  it("keeps allocate's lines on harms and on answering every id", () => {
    const shared = JUDGE_INSTRUCTIONS.split("\n").slice(2);
    expect(shared).toHaveLength(2);
    for (const line of shared) expect(OUTLINE_JUDGE_INSTRUCTIONS.split("\n")).toContain(line);
  });
});

describe("codeResults", () => {
  it("marks leaf-time unmet on an over-budget breach", () => {
    expect(result(leafOutput({ breaches: [breach("over-budget", "Day 1 runs 150 min against 120")] }), "leaf-time")).toMatchObject({
      met: false,
      grader: "code",
      evidence: expect.stringContaining("150 min"),
    });
  });

  it("marks leaf-time met with no breach, and gives head-* criteria no result on a leaf call", () => {
    const results = codeResults(leafOutput(), { fixture: LEAF });
    expect(results.find((r) => r.id === "leaf-time")?.met).toBe(true);
    expect(results.some((r) => r.id.startsWith("head-"))).toBe(false);
  });

  it("holds the top level to budget-miss under leaf-time, and other levels not", () => {
    const missed = leafOutput({ breaches: [breach("budget-miss")] });
    expect(result(missed, "leaf-time")?.met).toBe(true);
    expect(result(missed, "leaf-time", { ...LEAF, group: "top", tree: undefined, parentId: undefined })?.met).toBe(false);
  });

  it("checks minutes in code only where the material gives a size", () => {
    expect(result(leafOutput(), "leaf-minutes-code")?.met).toBe(true);
    const unsized: UnitDraft[] = [{ title: "Bits", summary: "s", materials: [{ id: "M1", tier: "must", minutes: 60 }] }];
    expect(result(leafOutput({ units: unsized }), "leaf-minutes-code")).toBeUndefined();
  });

  it("finds ids in the units' prose", () => {
    const leaked: UnitDraft[] = [{ ...DAY_UNITS[0], summary: "Read M1.1 closely" }];
    expect(result(leafOutput({ units: leaked }), "leaf-words-code")).toMatchObject({ met: false, evidence: expect.stringContaining("M1.1") });
    expect(result(leafOutput(), "leaf-words-code")?.met).toBe(true);
  });

  it("takes only the fixture's aliases for ids: one material, so an M5 chip is prose", () => {
    const prose: UnitDraft[] = [{ ...DAY_UNITS[0], summary: "Why an M5 chip runs this fast" }];
    expect(result(leafOutput({ units: prose }), "leaf-words-code")?.met).toBe(true);
    const weeks = [node({ id: "a", level: "week", time: { reading: 120, practice: {} } })];
    const heading = codeResults({ nodes: weeks, units: [{ title: "M5 chips", summary: "s" }], breaches: [], problems: [] }, { fixture: HEADING });
    expect(heading.find((r) => r.id === "head-words-code")?.met).toBe(true);
  });

  it("sizes a level once for its criteria' tests, its checks and the judge's criteria", () => {
    vi.mocked(minutesOffSize).mockClear();
    vi.mocked(setAsideOffSize).mockClear();
    const leaf = leafOutput();
    judgeCriteriaFor(leaf, { fixture: LEAF });
    codeResults(leaf, { fixture: LEAF });
    expect(minutesOffSize).toHaveBeenCalledTimes(1);
    const weeks: OutlineOutput = { nodes: [node({ id: "a", level: "week", covers: [{ id: "csapp", chapter: 1, note: null }], time: { reading: 120, practice: {} } })], units: [], breaches: [], problems: [] };
    judgeCriteriaFor(weeks, { fixture: HEADING });
    codeResults(weeks, { fixture: HEADING });
    expect(setAsideOffSize).toHaveBeenCalledTimes(1);
    // Another fixture is another sizing.
    codeResults(leaf, { fixture: { ...LEAF } });
    expect(minutesOffSize).toHaveBeenCalledTimes(2);
  });

  it("marks leaf-order-code unmet on a chapter read out of order", () => {
    const back = [node({ id: "d1", materials: [{ id: "csapp", chapter: 2, tier: "must", minutes: 60, note: null }] }), node({ id: "d2", materials: [{ id: "csapp", chapter: 1, tier: "must", minutes: 60, note: null }] })];
    expect(result(leafOutput({ nodes: back }), "leaf-order-code")?.met).toBe(false);
    expect(result(leafOutput(), "leaf-order-code")?.met).toBe(true);
  });

  it("gives a heading call only head-* results", () => {
    const weeks = [node({ id: "a", level: "week", covers: [{ id: "csapp", chapter: 1, note: null }], time: { reading: 120, practice: {} } })];
    const results = codeResults({ nodes: weeks, units: [{ title: "a", summary: "s" }], breaches: [breach("no-time")], problems: [] }, { fixture: HEADING });
    expect(results.every((r) => r.id.startsWith("head-"))).toBe(true);
    expect(results.find((r) => r.id === "head-time")?.met).toBe(false);
    expect(results.find((r) => r.id === "head-set-aside-code")?.met).toBe(true);
  });

  it("gives head-set-aside-code no result when no heading sets aside anything to size", () => {
    const weeks = [node({ id: "a", level: "week", time: { reading: 120, practice: {} } }), node({ id: "b", level: "week" })];
    const results = codeResults({ nodes: weeks, units: [], breaches: [], problems: [] }, { fixture: HEADING });
    expect(results.find((r) => r.id === "head-set-aside-code")).toBeUndefined();
    expect(results.find((r) => r.id === "head-time")).toBeDefined();
  });
});

describe("judgeCriteriaFor", () => {
  /** LEAF, with the parent setting aside the essay (no chapter list) beside the book's chapter. */
  const WITH_ESSAY: OutlineFixture = {
    ...LEAF,
    materials: [BOOK, ESSAY],
    tree: layout(makeRoot([{ ...WEEK, covers: [...WEEK.covers!, { id: "essay", note: null }] }, node({ id: "w2", level: "week", title: "Machine code", summary: "Assembly", len: 2 })])),
  };

  it("leaves out leaf-order-judge when everything the parent set aside has a toc", () => {
    // The essay is among the materials but not set aside for this week: the level was not given it.
    const ids = judgeCriteriaFor(leafOutput(), { fixture: { ...LEAF, materials: [BOOK, ESSAY] } }).map((c) => c.id);
    expect(ids).not.toContain("leaf-order-judge");
    expect(ids).toContain("leaf-note");
    expect(ids.every((id) => id.startsWith("leaf-"))).toBe(true);
  });

  it("includes leaf-order-judge when the parent set aside a material with no toc", () => {
    expect(judgeCriteriaFor(leafOutput(), { fixture: WITH_ESSAY }).map((c) => c.id)).toContain("leaf-order-judge");
  });

  it("at the top level, includes leaf-order-judge for a reading material with no toc, not for a practice-only one", () => {
    const top: OutlineFixture = { ...LEAF, group: "top", tree: undefined, parentId: undefined };
    const ids = (materials: Material[]) => judgeCriteriaFor(leafOutput(), { fixture: { ...top, materials } }).map((c) => c.id);
    expect(ids([BOOK, ESSAY])).toContain("leaf-order-judge");
    const problems = material("lc", "LeetCode 75", { kind: "tool", minutes: null, practice: { format: "problem-set" } as Material["practice"] });
    expect(ids([BOOK, problems])).not.toContain("leaf-order-judge");
  });

  it("gives every contestant on a fixture the same leaf-order-judge decision, whatever it wrote", () => {
    const readsEssay = [...DAYS, node({ id: "d3", materials: [{ id: "essay", chapter: null, tier: "must", minutes: 45, note: "The first half" }] })];
    const has = (fixture: OutlineFixture, out: OutlineOutput) => judgeCriteriaFor(out, { fixture }).some((c) => c.id === "leaf-order-judge");
    for (const fixture of [LEAF, WITH_ESSAY]) {
      expect(has(fixture, leafOutput())).toBe(has(fixture, leafOutput({ nodes: readsEssay })));
      expect(has(fixture, leafOutput({ nodes: [] }))).toBe(has(fixture, leafOutput()));
    }
  });

  it("asks the judge about minutes only for rows with no size", () => {
    expect(judgeCriteriaFor(leafOutput(), { fixture: LEAF }).map((c) => c.id)).not.toContain("leaf-minutes-judge");
    const unsized: UnitDraft[] = [{ title: "Bits", summary: "s", materials: [{ id: "M1", tier: "must", minutes: 60 }] }];
    expect(judgeCriteriaFor(leafOutput({ units: unsized }), { fixture: LEAF }).map((c) => c.id)).toContain("leaf-minutes-judge");
  });

  it("gives a heading call the heading criteria", () => {
    const ids = judgeCriteriaFor({ nodes: [], units: [], breaches: [], problems: [] }, { fixture: HEADING }).map((c) => c.id);
    expect(ids).toEqual(["head-title", "head-builds", "head-words-judge"]);
  });
});

describe("renderOutline", () => {
  const text = renderOutline(leafOutput(), LEAF);

  it("marks the parent and shows each unit's title", () => {
    expect(text).toContain(">> Week 1");
    expect(text).toContain("Bits");
    expect(text).toContain("Bytes");
    expect(text).toContain("Sections 1.5–1.9");
  });

  it("names no model and shows no JSON", () => {
    expect(text).not.toContain("gpt-test");
    expect(text).not.toContain('{"');
  });

  it("shows what the parent set aside and the level's budgets", () => {
    expect(text).toContain("What the parent set aside");
    expect(text).toContain("Chapter 1");
    expect(text).toContain("4 h reading");
    expect(text).toMatch(/Each day: about 2 h/);
  });

  it("shows the backbone's sections and each listed item, as the contestant's prompt does", () => {
    const book = { ...BOOK, toc: { ...chapters([120]), chapters: [{ n: 1, title: "Chapter 1", page: null, sections: ["Information is bits", "Programs are translated"], minutes: 120 }] } };
    const item = (title: string, group: string, minutes: number) => ({ title, number: null, group, difficulty: null, url: null, solutionUrl: null, minutes });
    const lab = material("lab", "Prompt tutorial", {
      kind: "course",
      minutes: null,
      practice: {
        format: "lab",
        items: 3,
        perItemMinutes: null,
        minutes: 75,
        answers: false,
        list: { source: "page", url: "https://x/lab", items: [item("01_Basic_Prompt_Structure.ipynb", "Beginner", 20), item("02_Being_Clear_and_Direct.ipynb", "Beginner", 25), item("03_Assigning_Roles.ipynb", "Intermediate", 30)] },
      },
    });
    const view = renderOutline(leafOutput(), { ...LEAF, materials: [book, lab] });
    expect(view).toContain("Information is bits; Programs are translated");
    expect(view).toContain("M2.1 01_Basic_Prompt_Structure.ipynb · Beginner · 20 min");
    expect(view).toContain("M2.3 03_Assigning_Roles.ipynb · Intermediate · 30 min");
  });

  it("places a top-level call's units at the top", () => {
    const weeks = [node({ id: "a", level: "week", title: "Foundations", summary: "s", len: 2 }), node({ id: "b", level: "week", title: "Machines", summary: "s", len: 2 })];
    const top = renderOutline({ nodes: weeks, units: [], breaches: [], problems: [] }, HEADING);
    expect(top).toContain("Foundations");
    expect(top).not.toContain(">>");
  });
});

const CALL = { label: "Week 1 · 2 days", model: "anthropic/claude-opus-5.5", costUsd: 0.4, inputTokens: 1000, outputTokens: 100, latencyMs: 5 } as ModelCall;

type Done = { breaches?: Breach[]; calls?: ModelCall[] };

/** A draft that reports `calls` and finishes with the leaf output, or throws `error`. */
function fakeDraft(opts: Done & { error?: unknown } = {}) {
  return vi.fn<typeof draftLevel>(async function* (input) {
    if (opts.error !== undefined) throw opts.error;
    for (const call of opts.calls ?? [CALL]) input.log?.onCall?.(call);
    yield { type: "done", nodes: DAYS, problems: [], costUsd: 0.4, units: DAY_UNITS, breaches: opts.breaches ?? [] };
  });
}

function apiError(statusCode: number) {
  return new APICallError({ message: `status ${statusCode}`, url: "https://ai-gateway.vercel.sh", requestBodyValues: {}, statusCode });
}

describe("runOutlineSample", () => {
  it("completes with the level, its calls and their cost", async () => {
    const unpriced = { ...CALL, costUsd: null } as ModelCall;
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ calls: [CALL, unpriced] }) });
    expect(sample.gate).toEqual({ status: "completed" });
    expect(sample.output?.units).toEqual(DAY_UNITS);
    expect(sample.calls).toHaveLength(2);
    expect(sample.costUsd).toBeCloseTo(0.4 + listPriceUsd("anthropic/claude-opus-5.5", unpriced));
    expect(sample.ms).toBeGreaterThanOrEqual(0);
    expect(sample.estimatedCostUsd).toBeUndefined();
  });

  describe("a call that threw before reporting", () => {
    const flash: Contestant = { name: "flash", roles: { outline: { model: "google/gemini-3-flash", effort: "low" } } };
    const abort = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

    it("is charged the fixture's baseline tokens at the contestant's price, with output at the baseline's pace", async () => {
      // The baseline wrote 4k tokens in 30 s; this call ran 90 s, so it is charged three times that.
      const ticks = [0, 90_000];
      const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ error: abort() }), now: () => ticks.shift()! });
      const estimate = listPriceUsd("google/gemini-3-flash", { inputTokens: 20_000, outputTokens: 12_000 });
      expect(sample.estimatedCostUsd).toBeGreaterThan(0);
      expect(sample.estimatedCostUsd).toBeCloseTo(estimate);
      expect(sample.costUsd).toBe(sample.estimatedCostUsd);
    });

    it("is charged the tokens the error says it used, when it carries them", async () => {
      const usage = { inputTokens: 30_000, outputTokens: 7_000, inputTokenDetails: { cacheReadTokens: 10_000 } };
      const error = new NoObjectGeneratedError({ message: "No object generated: response did not match schema.", usage, finishReason: "stop" } as unknown as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
      const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ error }) });
      expect(sample.gate.status).toBe("failed");
      expect(sample.estimatedCostUsd).toBeCloseTo(listPriceUsd("google/gemini-3-flash", { inputTokens: 30_000, outputTokens: 7_000, cacheReadTokens: 10_000 }));
    });

    it("is not charged when it was voided and the error carries no usage: nothing was billed", async () => {
      // An outage (5xx, 429), the gateway refusing the key (401–403) and a stream's error part are voided.
      for (const error of [apiError(503), apiError(429), apiError(402), apiError(401), { type: "overloaded_error", message: "Overloaded" }]) {
        const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ error }) });
        expect(sample.gate.status).toBe("void");
        expect(sample.costUsd).toBe(0);
        expect(sample).not.toHaveProperty("estimatedCostUsd");
      }
    });

    it("is charged the usage a voided call's error carries", async () => {
      const usage = { inputTokens: 30_000, outputTokens: 7_000, inputTokenDetails: { cacheReadTokens: 10_000 } };
      const used = new NoObjectGeneratedError({ message: "No object generated.", usage, finishReason: "stop" } as unknown as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
      const error = new APICallError({ message: "status 503", url: "https://ai-gateway.vercel.sh", requestBodyValues: {}, statusCode: 503, cause: used });
      const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ error }) });
      expect(sample.gate.status).toBe("void");
      expect(sample.estimatedCostUsd).toBeCloseTo(listPriceUsd("google/gemini-3-flash", { inputTokens: 30_000, outputTokens: 7_000, cacheReadTokens: 10_000 }));
    });

    it("is estimated when it failed on the model's own output and the error carries no usage", async () => {
      const error = new JSONParseError({ text: "{", cause: new Error("Unexpected end") });
      const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ error }), now: () => 0 });
      expect(sample.gate.status).toBe("failed");
      expect(sample.estimatedCostUsd).toBeCloseTo(listPriceUsd("google/gemini-3-flash", { inputTokens: 20_000, outputTokens: 4_000 }));
    });

    it("is not charged when the provider refused the request (a 400): nothing was generated or billed", async () => {
      const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ error: apiError(400) }), now: () => 0 });
      expect(sample.gate.status).toBe("failed");
      expect(sample.costUsd).toBe(0);
      expect(sample).not.toHaveProperty("estimatedCostUsd");
    });

    it("is not estimated past the time ceiling, where the call reported its cost", async () => {
      const sample = await runOutlineSample(LEAF, flash, { draft: fakeDraft({ breaches: [breach("over-budget")] }) });
      expect(sample.gate.status).toBe("failed");
      expect(sample.estimatedCostUsd).toBeUndefined();
      expect(sample.costUsd).toBe(0.4);
    });
  });

  it("fails an aborted call as timed out after the fixture's limit", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: abort }) });
    expect(sample.gate).toEqual({ status: "failed", reason: "timed out after 197.295 s" });
    expect(sample.output).toBeNull();
  });

  it("voids a gateway outage (503) without halting", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: apiError(503) }) });
    expect(sample.gate.status).toBe("void");
    expect(sample.gate).not.toHaveProperty("halt");
  });

  it("voids and halts on the gateway refusing the key or its budget (402)", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: apiError(402) }) });
    expect(sample.gate).toMatchObject({ status: "void", halt: true });
  });

  it("voids and halts when the owner's own key is out of credits, Anthropic's 400, rather than failing the model", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
    const error = new APICallError({ message: "Your credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: body });
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error }) });
    expect(sample.gate).toMatchObject({ status: "void", halt: true });
    expect(sample.costUsd).toBe(0);
  });

  it("calls the outline model the way the route says, the gateway id when no route is given", async () => {
    const onKey = { model: "direct-instance", id: "anthropic/claude-opus-5.5", keyOwner: "user" } as unknown as ResolvedModel;
    const route = vi.fn(() => onKey);
    const draft = fakeDraft();
    await runOutlineSample(LEAF, BASELINE, { draft, route });
    expect(route).toHaveBeenCalledWith("anthropic/claude-opus-5.5");
    expect(draft.mock.calls[0][0].ctx.outlineModel).toBe(onKey);

    const plain = fakeDraft();
    await runOutlineSample(LEAF, BASELINE, { draft: plain });
    expect(plain.mock.calls[0][0].ctx.outlineModel).toEqual({ model: "anthropic/claude-opus-5.5", id: "anthropic/claude-opus-5.5", keyOwner: "app" });
  });

  describe("an error with no status", () => {
    const gateFor = async (error: unknown) => (await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error }) })).gate;

    it("fails an answer that did not match the schema with its message: the model's own output", async () => {
      const error = new NoObjectGeneratedError({ message: "No object generated: response did not match schema.", finishReason: "stop" } as unknown as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
      expect(await gateFor(error)).toEqual({ status: "failed", reason: "No object generated: response did not match schema." });
    });

    it("fails an answer that did not parse or validate, also when wrapped", async () => {
      expect((await gateFor(new JSONParseError({ text: "{", cause: new Error("Unexpected end") }))).status).toBe("failed");
      const invalid = new TypeValidationError({ value: {}, cause: new Error("units: required") });
      expect((await gateFor(invalid)).status).toBe("failed");
      expect((await gateFor(new Error("draft failed", { cause: invalid }))).status).toBe("failed");
      expect((await gateFor(new NoContentGeneratedError())).status).toBe("failed");
    });

    it("voids a stream's error part, a plain object, with a readable reason", async () => {
      const gate = await gateFor({ type: "overloaded_error", message: "Overloaded" });
      expect(gate).toEqual({ status: "void", reason: "Overloaded" });
    });

    it("voids a plain object with no message, its reason the object as JSON", async () => {
      const gate = await gateFor({ type: "error", error: { type: "api_error" } });
      expect(gate).toEqual({ status: "void", reason: '{"type":"error","error":{"type":"api_error"}}' });
    });

    it("voids a network error or a provider stream error that gives no status, without halting", async () => {
      expect(await gateFor(new TypeError("fetch failed"))).toEqual({ status: "void", reason: "fetch failed" });
      expect(await gateFor(new StreamProviderError({ message: "Overloaded", type: "overloaded_error" }))).toEqual({ status: "void", reason: "Overloaded" });
    });

    it("voids and halts on the gateway's out-of-funds refusal that gives only a message", async () => {
      const gate = await gateFor(new Error("A positive credit balance is required to use AI Gateway."));
      expect(gate).toMatchObject({ status: "void", halt: true });
      const wrapped = await gateFor({ message: "A positive credit balance is required." });
      expect(wrapped).toMatchObject({ status: "void", halt: true });
    });
  });

  describe("an error with a status", () => {
    const gateFor = async (error: unknown) => (await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error }) })).gate;

    it("voids a 5xx and a 429 without halting, also after retries", async () => {
      for (const status of [500, 529, 429]) {
        const gate = await gateFor(apiError(status));
        expect(gate, String(status)).toEqual({ status: "void", reason: `gateway ${status}: status ${status}` });
      }
      const retried = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(503), apiError(503)] });
      expect(await gateFor(retried)).toMatchObject({ status: "void", reason: expect.stringMatching(/^gateway 503/) });
      expect(await gateFor(new StreamProviderError({ message: "Overloaded", statusCode: 529 }))).toEqual({ status: "void", reason: "gateway 529: Overloaded" });
    });

    it("voids and halts on 401 and 403", async () => {
      for (const status of [401, 403]) expect(await gateFor(apiError(status)), String(status)).toMatchObject({ status: "void", halt: true });
    });

    it("fails another client error: the request the model's settings made", async () => {
      expect(await gateFor(apiError(400))).toEqual({ status: "failed", reason: "status 400" });
      expect(await gateFor(apiError(422))).toEqual({ status: "failed", reason: "status 422" });
    });

    it("voids and halts on a 404: the contestant names a model the gateway does not know, our config to fix", async () => {
      expect(await gateFor(apiError(404))).toMatchObject({ status: "void", reason: expect.stringMatching(/^gateway 404/), halt: true });
      const retried = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(404)] });
      expect(await gateFor(retried)).toMatchObject({ status: "void", halt: true });
    });
  });

  it("fails a level past the time ceiling, and keeps its output", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ breaches: [breach("over-budget", "Day 1 runs 300 min against 120")] }) });
    expect(sample.gate.status).toBe("failed");
    expect(sample.gate).toMatchObject({ reason: expect.stringMatching(/^over the time ceiling/) });
    expect(sample.output).not.toBeNull();
  });

  it("passes the contestant's outline model and effort, and a deadline from the fixture's limit", async () => {
    const draft = fakeDraft();
    const contestant: Contestant = { name: "gpt-test", roles: { outline: { model: "google/gemini-3-flash", effort: "low" } } };
    const before = Date.now();
    await runOutlineSample(LEAF, contestant, { draft });
    const input = draft.mock.calls[0][0];
    expect(input.ctx.effort).toBe("low");
    expect(input.ctx.outlineModel.id).toBe("google/gemini-3-flash");
    expect(input.ctx.deadline).toBeGreaterThanOrEqual(before + LEAF.timeLimitMs);
    expect(input.parentId).toBe("w1");
  });

  it("runs the baseline's outline model for a contestant that leaves the role out", async () => {
    const draft = fakeDraft();
    await runOutlineSample(LEAF, { name: "bare", roles: {} }, { draft });
    expect(draft.mock.calls[0][0].ctx).toMatchObject({ effort: BASELINE.roles.outline!.effort, outlineModel: { id: BASELINE.roles.outline!.model } });
  });
});
