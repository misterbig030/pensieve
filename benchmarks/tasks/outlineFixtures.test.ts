import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftRequestBody } from "@/lib/ai/draftRequest";
import type { ModelCall } from "@/lib/ai/logged";
import { STEP_MIN_MS, streamPlanDraft } from "@/lib/ai/planDraft";
import { findNode, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";
import type { PlanSplit } from "@/lib/studyTime";
import { writeRun, type RunRecord } from "@/evals/draft/record";
import { callGroup, captureOutline, fixtureSlug, loadOutlineFixture, timeLimitMs } from "./outlineFixtures";

describe("timeLimitMs", () => {
  it("is what the draft had left when the call started", () => {
    expect(timeLimitMs({ endedAt: 1793911743324, latencyMs: 17466 }, "2026-11-05T20:47:35.627Z")).toBe(214769);
    expect(timeLimitMs({ endedAt: 1793911765496, latencyMs: 22164 }, "2026-11-05T20:47:35.627Z")).toBe(197295);
  });

  it("is at least STEP_MIN_MS when the call started past the deadline", () => {
    expect(timeLimitMs({ endedAt: 1793911765496 + 600_000, latencyMs: 22164 }, "2026-11-05T20:47:35.627Z")).toBe(60000);
    expect(STEP_MIN_MS).toBe(60000);
  });
});

describe("fixtureSlug", () => {
  it("names a fixture by where its call plans", () => {
    expect(fixtureSlug("Top level · 4 weeks")).toBe("top");
    expect(fixtureSlug("Top level · 8 weeks in 3 blocks")).toBe("top");
    expect(fixtureSlug("Week 1 · 5 days")).toBe("week-1");
    expect(fixtureSlug("Weeks 3–5 · 3 weeks")).toBe("weeks-3-5");
  });
});

describe("callGroup", () => {
  it("puts top-level calls in top, leaves in leaves and the rest in inner", () => {
    expect(callGroup({ leaf: true })).toBe("top");
    expect(callGroup({ parentId: "x", leaf: true })).toBe("leaves");
    expect(callGroup({ parentId: "x", leaf: false })).toBe("inner");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Run folders recorded from the app's own draft, with a scripted model

const MATERIALS: Material[] = [
  { id: "M1", origin: "research", type: "link", kind: "docs", url: "https://example.com/guide", title: "The Guide", author: null, year: null, why: "The main guide", backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 600 },
];
const SPLIT: PlanSplit = { readingShare: 50, practice: "building projects", reason: "A craft topic.", formats: [{ format: "project", share: 100, focus: "a small tool", reason: "Learning by building." }] };
const STARTED_AT = "2026-11-05T20:00:00.000Z";

/** The user text of a prompt as the model receives it. */
function userText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** How many units the model returns for a prompt that asked for `asked`: as many, unless a test says otherwise. */
type Count = (prompt: string, asked: number) => number;

/** Units for a prompt: headings reserve the guide and state their time; leaves read it. */
function unitsFor(prompt: string, count: Count): UnitDraft[] {
  const n = count(prompt, Number(/Return exactly (\d+) units/.exec(prompt)![1]));
  const leaves = prompt.includes('list its Read table in "materials"');
  return Array.from({ length: n }, (_, i) =>
    leaves
      ? { title: `Leaf ${i + 1}`, summary: `Leaf ${i + 1} reads the guide.`, materials: [{ id: "M1", tier: "must" as const, minutes: 30, note: `part ${i + 1}` }] }
      : { title: `Heading ${i + 1}`, summary: `Heading ${i + 1} covers part of the guide.`, covers: [{ id: "M1", note: `part ${i + 1}` }], time: { reading: 120, practice: [{ format: "project" as const, minutes: 120 }] } },
  );
}

/** A model that answers every outline prompt with `unitsFor`, after `delayMs(prompt)` so parallel calls can land out of order. */
function scriptedModel(delayMs: (prompt: string) => number = () => 0, count: Count = (_, asked) => asked) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const prompt = userText(options);
      await new Promise((resolve) => setTimeout(resolve, delayMs(prompt)));
      const text = JSON.stringify({ units: unitsFor(prompt, count) });
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: text });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 50, text: 50, reasoning: undefined } },
            });
            controller.close();
          },
        }),
      };
    },
  });
}

const ALLOCATE_CALL: ModelCall = {
  caller: "outline",
  model: "anthropic/claude-opus-5.5",
  effort: "high",
  keyOwner: "app",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: null,
  reasoningTokens: null,
  costUsd: 0.01,
  latencyMs: 1000,
  trackId: null,
  userId: null,
  label: "Allocate",
  system: null,
  prompt: "allocate",
  response: "{}",
  finishReason: "stop",
  facts: [],
  endedAt: Date.parse(STARTED_AT) + 60_000,
};

/** Drafts `request` through the app's own `streamPlanDraft` on a scripted model, and records it as the eval would. */
async function recordDraft(request: DraftRequestBody, delayMs?: (prompt: string) => number, count?: Count): Promise<RunRecord> {
  const calls: ModelCall[] = [ALLOCATE_CALL];
  let plan: PlanNode | null = null;
  const outlineModel = { model: scriptedModel(delayMs, count), id: "anthropic/claude-opus-5.5" as const, keyOwner: "app" as const };
  for await (const event of streamPlanDraft({ ...request, materials: MATERIALS, split: SPLIT, outlineModel, log: { onCall: (call) => void calls.push({ ...call, endedAt: Date.now() }) } })) {
    if (event.type === "finish") plan = event.root;
  }
  return {
    meta: { topic: "t", run: 1, startedAt: STARTED_AT, commit: "abc1234", key: "app", models: {}, request, ms: 1, costUsd: 0, costByStage: {} },
    events: [{ type: "split", split: SPLIT, t: 1 }],
    calls,
    materials: { verified: [], allocated: MATERIALS, dropped: [], coverage: null },
    split: SPLIT,
    plan,
  };
}

const DAY_PLAN: DraftRequestBody = { topic: "Making tools", weeks: 2, daysPerWeek: 5, hoursPerWeek: 6, granularity: "day", materials: [] };
const WEEK_LEAF_PLAN: DraftRequestBody = { topic: "Making tools", weeks: 8, daysPerWeek: 3, hoursPerWeek: 3, granularity: "week", materials: [] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-outline-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Saves the record as a run folder and returns its path. */
function saved(record: RunRecord, name = "t-run"): string {
  const runDir = join(dir, name);
  writeRun(runDir, record);
  return runDir;
}

describe("captureOutline", () => {
  it("captures every outline call of a saved run and checks each prompt", async () => {
    const record = await recordDraft(DAY_PLAN);
    const week1 = record.plan!.children![0];
    week1.problems = ["A day reads too much."];
    const fixtures = await captureOutline(saved(record), "t-1");

    expect(fixtures.map((f) => f.id)).toEqual(["t-1/top", "t-1/week-1"]);
    const [top, days] = fixtures;
    expect(top).toMatchObject({ label: "Top level · 2 weeks", group: "top", leaf: false, level: "week", spans: [5, 5], topic: "t", sourceRun: "t-run", commit: "abc1234", materials: MATERIALS, split: SPLIT });
    expect(top.tree).toBeUndefined();
    expect(top.parentId).toBeUndefined();
    expect(top.request).toEqual({ topic: "Making tools", granularity: "day", weeks: 2, daysPerWeek: 5, hoursPerWeek: 6 });
    expect(top.baseline).toEqual({ inputTokens: 100, outputTokens: 50, ms: record.calls[1].latencyMs });

    expect(days).toMatchObject({ label: "Week 1 · 5 days", group: "leaves", leaf: true, level: "day", spans: [1, 1, 1, 1, 1], parentId: week1.id });
    const parent = findNode(days.tree!, week1.id)!;
    expect(parent.children).toBeNull();
    expect(parent).not.toHaveProperty("problems");
    expect(days.tree!.children![1]).toEqual(record.plan!.children![1]);
  });

  it("captures a level that came back with fewer units than asked, as the call saw it", async () => {
    // Week 1 asked for 5 days and got 4: the app re-split the spans, and the saved plan's Week 1 is 4 days long.
    const record = await recordDraft(DAY_PLAN, undefined, (prompt, asked) => (prompt.includes('list its Read table in "materials"') ? asked - 1 : asked));
    const week1 = record.plan!.children![0];
    expect(week1.children).toHaveLength(4);
    expect(week1.len).toBe(4);
    expect(record.calls.map((c) => c.label)).toContain("Week 1 · 5 days");

    const fixtures = await captureOutline(saved(record), "t-1");
    expect(fixtures.map((f) => f.id)).toEqual(["t-1/top", "t-1/week-1"]);
    const days = fixtures[1];
    expect(days.spans).toHaveLength(5);
    expect(findNode(days.tree!, week1.id)!.len).toBe(5);
  });

  it("refuses a run whose recorded prompt differs, naming the call", async () => {
    const record = await recordDraft(DAY_PLAN);
    const call = record.calls.find((c) => c.label === "Week 1 · 5 days")!;
    call.prompt = call.prompt.replace("Day", "Dax");
    await expect(captureOutline(saved(record), "t-1")).rejects.toThrow("Week 1 · 5 days");
  });

  it("rebuilds #48's block headings from the recorded response", async () => {
    // The first block lands first, the last second and the middle one last, as the c25k run's did.
    const delay = (prompt: string) => (prompt.includes(">> Month 2") ? 60 : prompt.includes(">> Month 3") ? 30 : 0);
    const record = await recordDraft(WEEK_LEAF_PLAN, delay);
    expect(record.calls.map((c) => c.label)).toEqual(["Allocate", "Top level · 8 weeks in 3 blocks", "Weeks 1–2 · 2 weeks", "Weeks 6–8 · 3 weeks", "Weeks 3–5 · 3 weeks"]);
    const fixtures = await captureOutline(saved(record), "t-1");

    expect(fixtures.map((f) => f.id)).toEqual(["t-1/top", "t-1/weeks-1-2", "t-1/weeks-6-8", "t-1/weeks-3-5"]);
    const [heads, ...blocks] = fixtures;
    expect(heads).toMatchObject({ group: "top", leaf: false, level: "month", spans: [6, 9, 9] });
    expect(heads.tree).toBeUndefined();
    const byLabel = Object.fromEntries(blocks.map((f) => [f.label, f]));
    const positions: [string, number, number][] = [
      ["Weeks 1–2 · 2 weeks", 0, 2],
      ["Weeks 3–5 · 3 weeks", 1, 3],
      ["Weeks 6–8 · 3 weeks", 2, 3],
    ];
    for (const [label, position, weeks] of positions) {
      const block = byLabel[label];
      expect(block).toMatchObject({ group: "leaves", leaf: true, level: "week" });
      expect(block.tree!.children!.map((h) => h.title)).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
      expect(block.tree!.children!.every((h) => h.children === null)).toBe(true);
      expect(block.parentId).toBe(block.tree!.children![position].id);
      expect(block.spans).toHaveLength(weeks);
    }
  });

  it("skips a level the run did not record and captures the rest", async () => {
    const record = await recordDraft(DAY_PLAN);
    expect(record.plan!.children![0].children).toHaveLength(5);
    record.calls = record.calls.filter((c) => c.label !== "Week 1 · 5 days");
    const fixtures = await captureOutline(saved(record), "t-1");
    expect(fixtures.map((f) => f.id)).toEqual(["t-1/top"]);
  });
});

describe("loadOutlineFixture", () => {
  it("reads a saved fixture back", async () => {
    const [top] = await captureOutline(saved(await recordDraft(DAY_PLAN)), "t-1");
    mkdirSync(join(dir, "fixtures", "t-1"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "t-1", "outline-top.json"), JSON.stringify(top, null, 2));
    expect(loadOutlineFixture("t-1/top", join(dir, "fixtures"))).toEqual(top);
  });

  it("fails loudly on a fixture an older schema wrote", async () => {
    const [top] = await captureOutline(saved(await recordDraft(DAY_PLAN)), "t-1");
    const { timeLimitMs: _limit, ...older } = top;
    mkdirSync(join(dir, "fixtures", "t-1"), { recursive: true });
    const path = join(dir, "fixtures", "t-1", "outline-top.json");
    writeFileSync(path, JSON.stringify(older, null, 2));
    expect(readFileSync(path, "utf8")).not.toContain("timeLimitMs");
    expect(() => loadOutlineFixture("t-1/top", join(dir, "fixtures"))).toThrow("t-1/top");
  });

  it("throws naming the id when there is no such fixture", () => {
    expect(() => loadOutlineFixture("t-9/top", join(dir, "fixtures"))).toThrow("t-9/top");
  });
});
