import { describe, expect, it } from "vitest";
import { z } from "zod";
import { convertDraft, type ImportedPlan } from "@/lib/import/convert";
import { importDraftSchema, type ImportDraft, type ImportUnitDraft } from "@/lib/import/schema";
import { WEEKLY_PLAN_DRAFT } from "@/lib/import/__fixtures__/weekly-plan.draft";
import { materialListSchema } from "@/lib/schemas/material";
import { planTreeInputSchema } from "@/lib/schemas/plan";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, SPLIT_FROM_FILE, planSplitSchema } from "@/lib/studyTime";

type PlanDraft = Extract<ImportDraft, { kind: "plan" }>;

function convert(draft: ImportDraft = WEEKLY_PLAN_DRAFT): ImportedPlan {
  const result = convertDraft(draft, "weekly-plan.md");
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}: ${result.message}`);
  return result.plan;
}

function unit(title: string, over: Partial<ImportUnitDraft> = {}): ImportUnitDraft {
  return { title, summary: `${title} summary`, budgetHours: null, reading: [], practice: [], children: null, ...over };
}

function plan(over: Partial<PlanDraft> = {}): PlanDraft {
  return { kind: "plan", title: "A plan", hoursPerWeek: null, daysPerWeek: null, level: "week", materials: [], units: [unit("One")], kept: [], skipped: [], ...over };
}

describe("convertDraft on weekly-plan.md", () => {
  it("imports all 8 weeks in order", () => {
    const { tree, granularity } = convert();
    expect(tree.length).toBe(8);
    expect(tree.map((n) => n.level)).toEqual(Array(8).fill("week"));
    expect(tree[0].title).toBe("Nov 10–15 · freeze + calibrate + Heap + framework");
    expect(tree.map((n) => n.children ?? null)).toEqual(Array(8).fill(null));
    expect(granularity).toBe("week");
  });

  it("keeps a non-ASCII title", () => {
    expect(convert().tree[1].title).toBe("Nov 16–22 · 基准测试 + CI");
  });

  it("sorts Week 1", () => {
    const { tree, materials } = convert();
    const byId = new Map(materials.map((m) => [m.id, m]));
    const week = tree[0];

    const book = (week.materials ?? []).map((ref) => ({ ref, material: byId.get(ref.id)! }));
    const ch13 = book.find((r) => r.ref.note === "Ch. 1–3");
    expect(ch13?.material.title).toBe("System Design Interview, vol. 1");
    expect(ch13?.material.kind).toBe("book");
    expect(ch13?.ref).toMatchObject({ tier: "must", activity: "read", minutes: 90 });

    const practice = week.practice ?? [];
    const leetcode = materials.find((m) => m.title === "LeetCode")!;
    const problems = practice.filter((p) => p.format === "problem-set");
    expect(problems).toHaveLength(7);
    expect(problems.every((p) => p.id === leetcode.id)).toBe(true);
    const items = leetcode.practice!.list!.items;
    expect(problems.map((p) => items[p.itemFrom! - 1].number)).toEqual(["703", "1046", "973", "215", "621", "355", "295"]);
    expect(problems.every((p) => p.itemFrom === p.itemTo)).toBe(true);
    // The row's 300 minutes divided evenly over its seven items.
    expect(problems.reduce((sum, p) => sum + p.minutes, 0)).toBe(300);
    expect(Math.max(...problems.map((p) => p.minutes)) - Math.min(...problems.map((p) => p.minutes))).toBeLessThanOrEqual(1);

    const design = practice.filter((p) => p.format === "design-exercise");
    expect(design).toHaveLength(1);
    expect(design[0].task).toContain("rate limiter");

    expect(practice.filter((p) => p.format === "other")).toHaveLength(3);
    expect(practice.every((p) => p.imported === true && p.generated === false)).toBe(true);
  });

  it("shares one book entry across weeks", () => {
    const { tree, materials } = convert();
    const books = materials.filter((m) => m.title === "System Design Interview, vol. 1");
    expect(books).toHaveLength(1);
    const readers = tree.filter((n) => n.materials?.some((r) => r.id === books[0].id));
    expect(readers.length).toBeGreaterThan(1);
  });

  it("materials have no links", () => {
    const { materials } = convert();
    for (const m of materials) {
      expect(m.type).toBe("note");
      expect(m.origin).toBe("import");
      expect(m.url.startsWith("import:")).toBe(true);
      expect(m).toMatchObject({ verifiedAt: null, sig: null, fetchedTitle: null, recommendedBy: [], backbone: false, why: null, year: null });
    }
    expect(new Set(materials.map((m) => m.url)).size).toBe(materials.length);
  });

  it("makes the numbered source a practice list from the file", () => {
    const leetcode = convert().materials.find((m) => m.title === "LeetCode")!;
    expect(leetcode.practice).toMatchObject({ format: "problem-set", items: 41, perItemMinutes: 10, minutes: 410, answers: false });
    expect(leetcode.practice!.list).toMatchObject({ source: "file", url: leetcode.url });
    expect(leetcode.practice!.list!.items[0]).toEqual({ title: "703", number: "703", group: null, difficulty: null, url: null, solutionUrl: null, minutes: null });
  });

  it("budget comes from the file", () => {
    const { tree, hoursPerWeek, daysPerWeek } = convert();
    expect(tree[0].budgetHours).toBe(13);
    expect(tree[6].budgetHours).toBe(7);
    // Week 8 gives no hours: the plan's weekly hours.
    expect(tree[7].budgetHours).toBe(13);
    expect(hoursPerWeek).toBe(13);
    expect(daysPerWeek).toBe(DEFAULT_DAYS_PER_WEEK);
    expect(tree.every((n) => n.len === DEFAULT_DAYS_PER_WEEK)).toBe(true);
  });

  it("skipped and kept pass through", () => {
    const { kept, skipped } = convert();
    expect(kept).toEqual(WEEKLY_PLAN_DRAFT.kind === "plan" ? WEEKLY_PLAN_DRAFT.kept : []);
    expect(skipped).toEqual([{ heading: "Eval-interview prep (ongoing from Week 3)", reason: "It runs from Week 3 onward and belongs to no single week." }]);
  });

  it("splits time as the file does", () => {
    const { split } = convert();
    expect(split.practice).toBe("From your plan");
    expect(split.reason).toBe(SPLIT_FROM_FILE);
    expect(split.formats!.map((p) => p.format)).toEqual(["other", "problem-set", "design-exercise", "mock"]);
    expect(split.formats!.reduce((sum, p) => sum + p.share, 0)).toBe(100);
    // 270 reading minutes over the whole plan.
    expect(split.readingShare).toBeGreaterThan(0);
    expect(split.readingShare).toBeLessThan(10);
  });

  it("output passes the app schemas", () => {
    const { tree, materials, split } = convert();
    expect(() => planTreeInputSchema.parse(tree)).not.toThrow();
    expect(() => materialListSchema.parse(materials)).not.toThrow();
    expect(() => planSplitSchema.parse(split)).not.toThrow();
  });
});

describe("convertDraft rules", () => {
  it("empty week imports with title only", () => {
    const { tree } = convert(plan({ units: [unit("Busy", { practice: [{ format: "other", id: null, items: null, task: "Do it", done: "Done", minutes: 30 }] }), unit("Dec 7–13 · empty", { summary: "" })] }));
    expect(tree[1].title).toBe("Dec 7–13 · empty");
    expect(tree[1].materials).toBeUndefined();
    expect(tree[1].practice).toBeUndefined();
    expect(tree[1].summary.length).toBeGreaterThan(0);
    expect(tree[1].budgetHours).toBe(DEFAULT_HOURS_PER_WEEK);
    expect(() => planTreeInputSchema.parse(tree)).not.toThrow();
  });

  it("unknown kind becomes other", () => {
    const { materials } = convert(plan({ materials: [{ id: "M1", title: "Budget sheet", author: null, kind: "spreadsheet", practiceFormat: null, items: null }] }));
    expect(materials[0].kind).toBe("other");
  });

  it("unknown practice format becomes other", () => {
    const { tree } = convert(plan({ units: [unit("W", { practice: [{ format: "flashcards-ish", id: null, items: null, task: "Cards", done: "Done", minutes: 20 }] })] }));
    expect(tree[0].practice![0]).toMatchObject({ format: "other", imported: true, generated: false, minutes: 20 });
  });

  it("no_plan passes the reason through", () => {
    expect(convertDraft({ kind: "no_plan", reason: "It lists 12 books but no weeks." }, "books.md")).toEqual({
      ok: false,
      reason: "no_plan",
      message: "It lists 12 books but no weeks.",
    });
  });

  it("refuses 41 top-level units", () => {
    const units = Array.from({ length: 41 }, (_, i) => unit(`Unit ${i + 1}`));
    expect(convertDraft(plan({ units }), "long.md")).toEqual({
      ok: false,
      reason: "too_long",
      message: "This plan has more than 40 top-level units. Pensieve can import up to 40.",
    });
    const forty = convertDraft(plan({ units: units.slice(0, 40) }), "long.md");
    expect(forty.ok).toBe(true);
  });

  it("drops the Week N prefix the app adds itself", () => {
    const { tree } = convert(plan({ units: [unit("Week 1 · Nov 10–15 · freeze"), unit("Week 2"), unit("Week 3: graphs"), unit("Week 4-5 review")] }));
    expect(tree.map((n) => n.title)).toEqual(["Nov 10–15 · freeze", "Week 2", "graphs", "Week 4-5 review"]);
  });

  it("never gives two materials one url, whatever the script", () => {
    const { materials } = convert(
      plan({
        materials: [
          { id: "M1", title: "基准测试", author: null, kind: "book", practiceFormat: null, items: null },
          { id: "M2", title: "算法导论", author: null, kind: "book", practiceFormat: null, items: null },
          { id: "M3", title: "Notes!", author: null, kind: "note", practiceFormat: null, items: null },
          { id: "M4", title: "Notes?", author: null, kind: "note", practiceFormat: null, items: null },
        ],
      }),
    );
    expect(materials.map((m) => m.title)).toEqual(["基准测试", "算法导论", "Notes!", "Notes?"]);
    expect(new Set(materials.map((m) => m.url)).size).toBe(4);
    expect(materials.every((m) => /^import:[a-z0-9-]+$/.test(m.url))).toBe(true);
  });

  it("a list under 3 items stays a plain row", () => {
    const { tree, materials } = convert(
      plan({
        materials: [{ id: "M1", title: "Kata site", author: null, kind: "tool", practiceFormat: "problem-set", items: ["1", "2"] }],
        units: [unit("W", { practice: [{ format: "problem-set", id: "M1", items: ["1", "2"], task: "Katas 1 and 2", done: "Both pass", minutes: 40 }] })],
      }),
    );
    expect(materials[0].practice ?? null).toBeNull();
    expect(tree[0].practice).toEqual([{ format: "problem-set", id: "M1", task: "Katas 1 and 2", done: "Both pass", minutes: 40, generated: false, imported: true }]);
  });

  it("takes a list's format from the rows that name its items when the material has none", () => {
    const row = (format: string, items: string[]) => ({ format, id: "M1", items, task: `Problems ${items.join(", ")}`, done: "Solved", minutes: null });
    const { tree, materials } = convert(
      plan({
        materials: [{ id: "M1", title: "Kata site", author: null, kind: "tool", practiceFormat: null, items: null }],
        units: [
          unit("W1", { practice: [row("problem-set", ["1", "2"]), row("lab", ["3"])] }),
          unit("W2", { practice: [row("problem-set", ["4"]), row("not-a-format", ["5"]), row("not-a-format", ["6"])] }),
        ],
      }),
    );
    expect(materials[0].practice).toMatchObject({ format: "problem-set", items: 6 });
    expect(materials[0].practice!.list!.items.map((i) => i.number)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(tree[0].practice!.map((p) => [p.format, p.itemFrom])).toEqual([
      ["problem-set", 1],
      ["problem-set", 2],
      ["lab", 3],
    ]);
  });

  it("lists a reading of a material the list does not have as skipped", () => {
    const { tree, skipped } = convert(plan({ units: [unit("W", { reading: [{ id: "M9", part: "Ch. 2", minutes: 30 }] })] }));
    expect(tree[0].materials).toBeUndefined();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].heading).toBe("W");
  });

  it("month files import as headings with reservations", () => {
    const { tree, granularity } = convert(
      plan({
        level: "month",
        materials: [
          { id: "M1", title: "SICP", author: null, kind: "book", practiceFormat: null, items: null },
          { id: "M2", title: "Katas", author: null, kind: "tool", practiceFormat: "problem-set", items: ["a", "b", "c", "d"] },
        ],
        units: [
          unit("January", {
            reading: [{ id: "M1", part: "Ch. 1", minutes: 600 }],
            practice: [
              { format: "problem-set", id: "M2", items: ["a", "b", "c"], task: "Katas a–c", done: "Pass", minutes: 90 },
              { format: "other", id: null, items: null, task: "Set up the editor", done: "Set up", minutes: 60 },
            ],
          }),
          unit("February", { children: [unit("Feb week 1", { budgetHours: 4 }), unit("Feb week 2")] }),
        ],
      }),
    );
    expect(granularity).toBe("week");
    expect(tree[0]).toMatchObject({ level: "month", budgetHours: null, children: null, len: 4 * DEFAULT_DAYS_PER_WEEK });
    expect(tree[0].covers).toEqual([{ id: "M1", note: "Ch. 1", chapter: null, activity: "read", tier: "must", minutes: 600 }]);
    expect(tree[0].practiceCovers).toEqual([
      { format: "problem-set", id: "M2", note: null, task: "Katas a–c", minutes: 90, itemFrom: 1, itemTo: 3, imported: true },
      { format: "other", id: null, note: null, task: "Set up the editor", minutes: 60, imported: true },
    ]);
    expect(tree[0].time).toEqual({ reading: 600, practice: { "problem-set": 90, other: 60 } });
    expect(tree[1].children!.map((w) => [w.level, w.budgetHours, w.len])).toEqual([
      ["week", 4, DEFAULT_DAYS_PER_WEEK],
      ["week", DEFAULT_HOURS_PER_WEEK, DEFAULT_DAYS_PER_WEEK],
    ]);
    expect(tree[1].len).toBe(2 * DEFAULT_DAYS_PER_WEEK);
    expect(() => planTreeInputSchema.parse(tree)).not.toThrow();
  });

  it("day-only files are grouped into weeks of the days per week", () => {
    const days = Array.from({ length: 7 }, (_, i) => unit(`Day ${i + 1} · topic ${i + 1}`, { practice: [{ format: "recall", id: null, items: null, task: `Quiz ${i + 1}`, done: "Answered", minutes: 20 }] }));
    const { tree, granularity, daysPerWeek } = convert(plan({ level: "day", daysPerWeek: 3, units: days }));
    expect(granularity).toBe("day");
    expect(daysPerWeek).toBe(3);
    expect(tree.map((w) => [w.level, w.title, w.children!.length, w.len])).toEqual([
      ["week", "Week 1", 3, 3],
      ["week", "Week 2", 3, 3],
      ["week", "Week 3", 1, 1],
    ]);
    expect(tree[0].children![0]).toMatchObject({ level: "day", title: "topic 1", len: 1, budgetHours: null });
    expect(tree[0].children![0].practice![0]).toMatchObject({ format: "recall", task: "Quiz 1", imported: true });
    expect(() => planTreeInputSchema.parse(tree)).not.toThrow();
  });

  it("weeks the file breaks into days keep their days", () => {
    const { tree, granularity } = convert(plan({ units: [unit("W1", { children: [unit("Mon"), unit("Tue")] }), unit("W2", { children: [unit("Mon")] })] }));
    expect(granularity).toBe("day");
    expect(tree[0].children!.map((d) => d.title)).toEqual(["Mon", "Tue"]);
    expect(tree[0].len).toBe(2);
    expect(() => planTreeInputSchema.parse(tree)).not.toThrow();
  });

  it("an empty plan still gets a valid split", () => {
    const { split } = convert(plan());
    expect(planSplitSchema.parse(split)).toEqual({ readingShare: 100, practice: "From your plan", reason: SPLIT_FROM_FILE, formats: [] });
  });

  it("a plan with no units is no_plan", () => {
    const result = convertDraft(plan({ units: [] }), "empty.md");
    expect(result).toMatchObject({ ok: false, reason: "no_plan" });
  });

  it("uses the file name when the plan has no title", () => {
    expect(convert(plan({ title: "  " })).title).toBe("weekly-plan");
  });
});

describe("importDraftSchema", () => {
  it("reads the fixture draft back unchanged", () => {
    expect(importDraftSchema.parse(WEEKLY_PLAN_DRAFT)).toEqual(WEEKLY_PLAN_DRAFT);
  });

  it("fills a no_plan answer's missing fields", () => {
    expect(importDraftSchema.parse({ kind: "no_plan", reason: "A syllabus.", title: null, units: null })).toEqual({ kind: "no_plan", reason: "A syllabus." });
  });

  it("sends no array caps to the model", () => {
    const sent = JSON.stringify(z.toJSONSchema(importDraftSchema, { io: "input" }));
    expect(sent).not.toContain("maxItems");
  });
});
