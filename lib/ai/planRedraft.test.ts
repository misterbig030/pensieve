import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";

// Only streamObject is faked; the rest of the SDK stays real.
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamObject: vi.fn(), generateObject: vi.fn() }));

import { streamObject } from "ai";
import type { ModelCall } from "./logged";
import { NothingToRedraftError, redraftPlan, type RedraftInput } from "./planRedraft";
import { LockedNodeError } from "./planRevision";
import { cloneTree, layout, makeNode, makeRoot, walk, type PlanNode } from "@/lib/planTree";
import { LISTED_PROBLEMS } from "@/lib/__fixtures__/problemList";

const mockedStreamObject = vi.mocked(streamObject);

function fakeStream(units: UnitDraft[]) {
  return {
    partialObjectStream: (async function* () {
      for (let i = 1; i <= units.length; i++) yield { units: units.slice(0, i) };
    })(),
    object: Promise.resolve({ units }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 }),
    finishReason: Promise.resolve("stop"),
    providerMetadata: Promise.resolve({ gateway: { cost: "0.004" } }),
  } as unknown as ReturnType<typeof streamObject>;
}

function material(id: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "docs", url: `https://example.com/${id}`, title: id, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, ...extra };
}

/** A book of eight 60-minute chapters, read in order, and a 21-problem list. */
const chapters = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, minutes: 60, sections: [] }));
const book = material("book", { kind: "book", title: "The Book", backbone: true, minutes: 480, minutesBasis: "measured", toc: { source: "catalogue", url: "u", printPages: false, end: null, chapters } });
const problems = material("probs", { kind: "course", title: "The Problems", practice: LISTED_PROBLEMS });
const materials = [book, problems];
const split = { readingShare: 50, practice: "problems", reason: "r", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "" }] };

const time = (reading: number, practice: number) => ({ reading, practice: { "problem-set": practice } });
const day = (id: string, chapter: number, status: "completed" | "pending" = "completed") =>
  makeNode({ id, level: "day", title: `Day ${id}`, summary: "s", len: 1, status, materials: [{ id: "book", tier: "must", minutes: 30, note: null, chapter, activity: "read" }] });
const week = (n: number, extra: Partial<Parameters<typeof makeNode>[0]> = {}) =>
  makeNode({
    id: `w${n}`,
    level: "week",
    title: `Old week ${n}`,
    summary: "s",
    len: 2,
    covers: [{ id: "book", note: null, chapter: n, activity: "read" }],
    practiceCovers: [{ format: "problem-set", id: "probs", note: null, itemFrom: 3 * n - 2, itemTo: 3 * n }],
    time: time(60, 90),
    ...extra,
  });

/**
 * Eight two-day weeks: weeks 1–2 done (their days completed; week 2 from before unit time, so without `time`), week 4
 * planned into days, the rest headings. Days 1–4 are behind the learner. With `started`, week 4's first day is done
 * too, out of order.
 */
function plan({ started = false } = {}): PlanNode {
  return layout(
    makeRoot([
      week(1, { status: "completed", children: [day("d1", 1), day("d2", 1)] }),
      week(2, { status: "completed", time: undefined, children: [day("d3", 2), day("d4", 2)] }),
      week(3),
      week(4, { children: [day("d7", 4, started ? "completed" : "pending"), day("d8", 4, "pending")] }),
      ...[5, 6, 7].map((n) => week(n)),
      week(8, { practiceCovers: undefined }),
    ]),
  );
}

const base = (tree: PlanNode, scope: RedraftInput["scope"]): RedraftInput => ({
  topic: "Interviews",
  materials,
  granularity: "day",
  weeks: 8,
  daysPerWeek: 2,
  hoursPerWeek: 6,
  split,
  tree,
  lockBefore: 4,
  scope,
});

/** The model's weeks for the open part: chapters 3–8 and the problem list, each with its time. */
const newWeeks = (count: number, opts: { untimed?: number } = {}): UnitDraft[] =>
  Array.from({ length: count }, (_, i) => ({
    title: `New week ${i + 3}`,
    summary: "s",
    covers: [{ id: `M1.${i + 3}` }],
    practiceCovers: [{ format: "problem-set", id: "M2" }],
    ...(opts.untimed === i ? {} : { time: { reading: 60, practice: [{ format: "problem-set" as const, minutes: 90 }] } }),
  }));
const newDays = (chapters: number[]): UnitDraft[] => chapters.map((c, i) => ({ title: `New day ${i + 1}`, summary: "s", materials: [{ id: `M1.${c}`, tier: "must" as const, minutes: 30 }] }));

describe("redraftPlan", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });

  it("keeps the done weeks as they are and re-drafts the rest, then plans the first open week's days", async () => {
    const tree = plan();
    const before = cloneTree(tree);
    mockedStreamObject.mockReturnValueOnce(fakeStream(newWeeks(6))).mockReturnValueOnce(fakeStream(newDays([3, 3])));
    const calls: ModelCall[] = [];
    const out = await redraftPlan({ ...base(tree, { kind: "plan" }), log: { onCall: (c) => void calls.push(c) } });

    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    const weeks = out.tree.children!;
    // Weeks 1–2 come back exactly as they were: ids, titles, covers, item runs, days.
    expect(weeks.slice(0, 2)).toEqual(before.children!.slice(0, 2));
    expect(weeks.slice(2).map((w) => w.title)).toEqual(["New week 3", "New week 4", "New week 5", "New week 6", "New week 7", "New week 8"]);
    expect(weeks.map((w) => w.start)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    // The first open week is planned into days; the others stay headings.
    expect(weeks[2].children!.map((d) => d.title)).toEqual(["New day 1", "New day 2"]);
    expect(weeks.slice(3).every((w) => w.children === null)).toBe(true);
    // The re-drafted weeks' runs share out only the items the kept weeks do not hold.
    const runs = weeks.slice(2).flatMap((w) => (w.practiceCovers ?? []).map((c) => [c.itemFrom, c.itemTo]));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every(([from]) => (from ?? 0) >= 7)).toBe(true);
    // The input tree is not changed.
    expect(tree).toEqual(before);

    const prompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('"Old week 1"');
    expect(prompt).toContain('"Old week 2"');
    expect(prompt).toContain("1. Week 3 (2 study days)");
    expect(prompt).not.toContain("1. Week 1 ");
    expect(prompt).toContain("Return exactly 6 units");
    expect(prompt).toContain("Held by the fixed units");
    expect(prompt).toContain("M1.1");
    expect(prompt).toContain("Other units have: M2 items 1–3 in Week 1; M2 items 4–6 in Week 2.");
    // Week 1 states its time; week 2, from before units did, takes its share of the split: 3 h of each.
    expect(prompt).toContain("The fixed weeks take reading about 4 h; Problems (format \"problem-set\") about 4 h 30 min, so the weeks you write share what is left: reading about 4 h;");
    expect(calls.map((c) => c.label)).toEqual(["Top level · 6 weeks", "Week 3 · 2 days"]);
    expect(out.costUsd).toBeCloseTo(0.008);
  });

  it("reports a kept week without time as nothing, a re-drafted one without time as a problem, and flattens every level's problems", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(newWeeks(6, { untimed: 1 }))).mockReturnValueOnce(fakeStream(newDays([3, 5])));
    const out = await redraftPlan(base(plan(), { kind: "plan" }));
    expect(out.tree.problems).toContain("Week 4 has no time set for its activities.");
    expect(out.tree.problems!.some((p) => p.startsWith("Week 2 "))).toBe(false);
    const week3 = out.tree.children![2];
    expect(week3.problems).toEqual(expect.arrayContaining([expect.stringContaining("Week 3 · Day 2 reads The Book ch. 5")]));
    expect(out.problems).toEqual([...out.tree.problems!, ...week3.problems!]);
  });

  it("re-drafts only the top level for a level scope without a parent", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(newWeeks(6)));
    const before = plan();
    const out = await redraftPlan(base(plan(), { kind: "level", parentId: null }));
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(out.tree.children!.slice(0, 2)).toEqual(before.children!.slice(0, 2));
    expect(out.tree.children![2].children).toBeNull();
    expect(out.problems).toEqual(out.tree.problems ?? []);
  });

  it("re-drafts a heading's children and keeps the heading", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(newDays([5, 5])));
    const before = plan();
    const out = await redraftPlan(base(plan(), { kind: "level", parentId: "w5" }));
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    const w5 = out.tree.children![4];
    const shell = (n: PlanNode) => ({ ...n, children: null, problems: undefined });
    expect(shell(w5)).toEqual(shell(before.children![4]));
    expect(w5.children!.map((d) => d.title)).toEqual(["New day 1", "New day 2"]);
    expect(out.tree.children!.filter((w) => w.id !== "w5")).toEqual(before.children!.filter((w) => w.id !== "w5"));
  });

  it("refuses to re-draft a week with a completed day, before any call", async () => {
    await expect(redraftPlan(base(plan({ started: true }), { kind: "level", parentId: "w4" }))).rejects.toBeInstanceOf(LockedNodeError);
    await expect(redraftPlan(base(plan(), { kind: "level", parentId: "w1" }))).rejects.toBeInstanceOf(LockedNodeError);
    expect(mockedStreamObject).not.toHaveBeenCalled();
  });

  it("keeps a week that is started but not done, and every week before it", async () => {
    // Week 4 has a completed day: weeks 1–4 stay, and weeks 5–8 are re-drafted.
    mockedStreamObject.mockReturnValueOnce(fakeStream(newWeeks(4).map((w, i) => ({ ...w, title: `New week ${i + 5}`, covers: [{ id: `M1.${i + 5}` }] })))).mockReturnValueOnce(fakeStream(newDays([5, 5])));
    const before = plan({ started: true });
    const out = await redraftPlan(base(plan({ started: true }), { kind: "plan" }));
    expect(out.tree.children!.slice(0, 4)).toEqual(before.children!.slice(0, 4));
    expect(out.tree.children!.slice(4).map((w) => w.title)).toEqual(["New week 5", "New week 6", "New week 7", "New week 8"]);
    expect((mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt).toContain("1. Week 5 (2 study days)");
  });
  it("keeps a fixed week's own breaches out of the learner's problems, as facts", async () => {
    // Week 1 stated 10 h when the learner had more time; at 6 h a week it is over its hours, and it can't change.
    const tree = plan();
    tree.children![0].time = time(300, 300);
    mockedStreamObject.mockReturnValueOnce(fakeStream(newWeeks(6)));
    const calls: ModelCall[] = [];
    const out = await redraftPlan({ ...base(tree, { kind: "level", parentId: null }), log: { onCall: (c) => void calls.push(c) } });
    expect(calls[0].facts).toContain("kept unit: Week 1 plans 600 min in a week of 360 min.");
    expect(calls[0].facts).not.toContain("breach: Week 1 plans 600 min in a week of 360 min.");
    expect((out.tree.problems ?? []).some((p) => p.startsWith("Week 1 "))).toBe(false);
    expect(out.problems.some((p) => p.startsWith("Week 1 "))).toBe(false);
  });

  it("says when there is nothing left to re-draft: every unit kept, or a plan no longer than its kept units", async () => {
    const done = plan();
    walk(done, (n) => void (n.status = "completed"));
    await expect(redraftPlan(base(done, { kind: "plan" }))).rejects.toThrow(new NothingToRedraftError("Every unit of the plan is done or started, so there is nothing left to re-draft."));
    // Weeks 1–4 are kept (week 4 is started), and the plan is now 3 weeks long.
    const shrunk = redraftPlan({ ...base(plan({ started: true }), { kind: "plan" }), weeks: 3 });
    await expect(shrunk).rejects.toBeInstanceOf(NothingToRedraftError);
    await expect(shrunk).rejects.toThrow(/no longer than the units already done or started/);
    expect(mockedStreamObject).not.toHaveBeenCalled();
  });

  it("keeps nothing when nothing is behind the learner, and drafts the whole plan without fixed units", async () => {
    const fresh = plan();
    walk(fresh, (n) => void (n.status = "pending"));
    const weeks = Array.from({ length: 8 }, (_, i) => ({ title: `New week ${i + 1}`, summary: "s", covers: [{ id: `M1.${i + 1}` }], time: { reading: 60, practice: [{ format: "problem-set" as const, minutes: 90 }] } }));
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks)).mockReturnValueOnce(fakeStream(newDays([1, 1])));
    const out = await redraftPlan({ ...base(fresh, { kind: "plan" }), lockBefore: 0 });
    const prompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("fixed");
    expect(prompt).toContain("Split the plan into 8 weeks");
    expect(prompt).toContain("1. Week 1 (2 study days)");
    expect(out.tree.children!.map((w) => w.title)).toEqual(weeks.map((w) => w.title));
  });

  it("plans no branch when the deadline leaves too little time for it", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(newWeeks(6)));
    const out = await redraftPlan({ ...base(plan(), { kind: "plan" }), deadline: Date.now() + 30_000 });
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(out.tree.children![2].children).toBeNull();
  });
});
