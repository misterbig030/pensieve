import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import type { Material, PracticeItem } from "@/lib/schemas/material";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import { budgetLine, byTier, chapterLabel, coverPracticeRows, DoRows, itemLabel, minutesOver, partLabel, practiceRowsFor, readRowsFor, ReadTable, rowBrief } from "./ReadTable";

describe("readRowsFor", () => {
  it("fills chapter, activity and a key per row", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const rows = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 35, note: "Post-Training; Sampling", chapter: 2 },
        { id: "aie", tier: "should", minutes: 20, note: null, chapter: 1, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: null },
      ],
      byId,
    );
    expect(rows.map((r) => [r.key, r.activity, r.chapter?.title ?? null])).toEqual([
      ["aie#2", "read", "Understanding Foundation Models"],
      ["aie#1", "review", "Introduction to Building AI Applications with Foundation Models"],
      ["evals#0", "read", null],
    ]);
    expect(chapterLabel(rows[0].chapter!)).toBe("Ch. 2 Understanding Foundation Models");
    expect(chapterLabel({ ...rows[0].chapter!, n: null })).toBe("Understanding Foundation Models");
  });
  it("names the part as a phrase: the chapter, or a review of it", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const [read, review, whole, wholeReview] = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 35, note: null, chapter: 2 },
        { id: "aie", tier: "should", minutes: 20, note: null, chapter: 2, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: null },
        { id: "evals", tier: "should", minutes: 20, note: null, activity: "review" },
      ],
      byId,
    );
    expect(partLabel(read)).toBe("Ch. 2 Understanding Foundation Models");
    expect(partLabel(review)).toBe("Review of Ch. 2 Understanding Foundation Models");
    expect(partLabel(whole)).toBeNull();
    expect(partLabel(wholeReview)).toBe("Review");
  });
});

describe("row order", () => {
  it("shows must rows before should rows, keeping the plan's order within a tier", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const rows = readRowsFor(
      [
        { id: "aie", tier: "should", minutes: 50, note: null, chapter: 2, activity: "review" },
        { id: "aie", tier: "must", minutes: 93, note: null, chapter: 3 },
        { id: "evals", tier: "should", minutes: 79, note: null },
        { id: "oaievals", tier: "must", minutes: 25, note: null },
      ],
      byId,
    );
    expect(rows.map((r) => r.key)).toEqual(["aie#3", "oaievals#0", "aie#2", "evals#0"]);
    expect([{ tier: "should" as const }, { tier: "must" as const }].sort(byTier).map((r) => r.tier)).toEqual(["must", "should"]);
  });
});

describe("rowBrief", () => {
  it("names the chapter by number and the sections after it; a whole resource by its title", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const [chapter, review, whole] = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 55, note: "The Rise of AI Engineering; Foundation Model Use Cases", chapter: 1 },
        { id: "aie", tier: "should", minutes: 20, note: "Modeling; Post-Training", chapter: 2, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: "whole essay" },
      ],
      byId,
    );
    expect(rowBrief(chapter)).toEqual({ head: "Ch. 1", detail: "The Rise of AI Engineering; Foundation Model Use Cases" });
    expect(rowBrief(review)).toEqual({ head: "Review of ch. 2", detail: "Modeling; Post-Training" });
    expect(rowBrief(whole)).toEqual({ head: "AI Evals", detail: "whole essay" });
    expect(rowBrief({ ...chapter, chapter: { ...chapter.chapter!, n: null } })).toEqual({ head: "Introduction to Building AI Applications with Foundation Models", detail: "The Rise of AI Engineering; Foundation Model Use Cases" });
  });
});

describe("budgetLine", () => {
  it("gives reading, practice and the budget as one line", () => {
    expect(budgetLine({ readingMinutes: 191, practiceMinutes: 169, budgetMinutes: 360 })).toBe("3 h 11 reading · 2 h 49 practice · 6 h");
  });
  it("says reading against the budget when the unit has no practice rows", () => {
    expect(budgetLine({ readingMinutes: 191, practiceMinutes: 0, budgetMinutes: 360 })).toBe("3 h 11 of 6 h reading");
  });
});

describe("minutesOver", () => {
  it("is over only past the tolerance the drafting checks accept, and then by the minutes past the budget", () => {
    // Six hours over five days is a 72-minute day; the checks accept up to 72 × 1.25 + 10 = 100 minutes.
    expect(minutesOver(100, 72)).toBe(0);
    expect(minutesOver(80, 72)).toBe(0);
    expect(minutesOver(101, 72)).toBe(29);
    expect(minutesOver(0, 0)).toBe(0);
  });
});

describe("practiceRowsFor", () => {
  const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
  it("keeps a source's row with its material and a generated row with none", () => {
    const rows = practiceRowsFor(
      [
        { format: "problem-set", id: "evals", task: "Problems 1-20", done: "checked against the solutions", minutes: 90, generated: false },
        { format: "design-exercise", id: null, task: "Design a rate limiter", done: "compared with the rubric", minutes: 50, generated: true },
      ],
      byId,
    );
    expect(rows.map((r) => [r.format, r.label, r.task, r.minutes, r.material?.id ?? null, r.generated])).toEqual([
      ["problem-set", "Problems", "Problems 1-20", 90, "evals", false],
      ["design-exercise", "Design", "Design a rate limiter", 50, null, true],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
  it("links a generated recall row to the reading it was made from", () => {
    const [row] = practiceRowsFor([{ format: "recall", id: "aie", task: "20 questions", done: "checked against the reading", minutes: 60, generated: true }], byId);
    expect(row.material?.id).toBe("aie");
    expect(row.generated).toBe(true);
  });
  it("drops a row whose source is not in the list, and reads nothing from no rows", () => {
    expect(practiceRowsFor([{ format: "lab", id: "gone", task: "Lab 1", done: "the check passes", minutes: 30, generated: false }], byId)).toEqual([]);
    expect(practiceRowsFor(undefined, byId)).toEqual([]);
  });
});

describe("coverPracticeRows", () => {
  const practiceSource = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "drills", practice: { format: "problem-set" as const, items: 100, perItemMinutes: 10, minutes: null, answers: true } };
  const byId = new Map([...AIE_MATERIALS, practiceSource].map((m) => [m.id, m]));
  it("shows a split week's kept reservations as rows without a done line, skipping covers that carry no task", () => {
    const rows = coverPracticeRows(
      [
        { format: "problem-set", id: "drills", note: null, task: "Problems 1-20", minutes: 90 },
        { format: "mock", id: null, note: null, task: "Mock interview", minutes: 45 },
        { format: "lab", id: "drills", note: "ch. 2" },
      ],
      byId,
    );
    expect(rows.map((r) => [r.task, r.minutes, r.done, r.generated])).toEqual([
      ["Problems 1-20", 90, "", false],
      ["Mock interview", 45, "", true],
    ]);
  });
  it("marks a recall cover whose id is a reading as generated and keeps the reading", () => {
    const [row] = coverPracticeRows([{ format: "recall", id: "aie", note: null, task: "20 questions", minutes: 60 }], byId);
    expect(row.generated).toBe(true);
    expect(row.material?.id).toBe("aie");
  });
  it("marks a cover whose id is a practice source of its format as not generated", () => {
    const [row] = coverPracticeRows([{ format: "problem-set", id: "drills", note: null, task: "Problems 21-40", minutes: 30 }], byId);
    expect(row.generated).toBe(false);
    expect(row.material?.id).toBe("drills");
  });
  it("marks a recall cover whose id is a book that also serves as practice as generated from that reading", () => {
    const [row] = coverPracticeRows([{ format: "recall", id: "drills", note: null, task: "Questions on ch. 2", minutes: 30 }], byId);
    expect(row.generated).toBe(true);
    expect(row.material?.id).toBe("drills");
  });
});

describe("a listed item row", () => {
  const items: PracticeItem[] = PROBLEM_ITEMS.map((it) => ({ ...it }));
  items[3] = { ...items[3], url: "https://leetcode.com/problems/group-anagrams/", solutionUrl: "https://neetcode.io/solutions/group-anagrams" };
  items[2] = { ...items[2], number: null, title: "Two Sum, no number" };
  const bank: Material = {
    ...AIE_MATERIALS.find((m) => m.id === "evals")!,
    id: "nc",
    title: "NeetCode 150",
    practice: { ...LISTED_PROBLEMS, list: { ...LISTED_PROBLEMS.list!, items } },
  };
  const byId = new Map([...AIE_MATERIALS, bank].map((m) => [m.id, m]));
  const row = (itemFrom: number | null, over = {}) => ({ format: "problem-set" as const, id: "nc", task: "NeetCode 150 · problem", done: "solved without hints", minutes: 25, generated: false, itemFrom, itemTo: itemFrom, ...over });

  it("reads the item the row's position names from the source's list", () => {
    const [listed, plain, outOfList] = practiceRowsFor([row(4), row(null), row(99)], byId);
    expect(listed.item?.title).toBe("Group Anagrams");
    expect(plain.item).toBeNull();
    expect(outOfList.item).toBeNull();
  });
  it("labels an item with its number, or its title alone without one", () => {
    expect(itemLabel(items[3])).toBe("49. Group Anagrams");
    expect(itemLabel(items[2])).toBe("Two Sum, no number");
  });
  it("shows the item as number and title, linked, with a solution link and its group as a label", () => {
    const html = renderToStaticMarkup(createElement(DoRows, { rows: practiceRowsFor([row(4)], byId) }));
    expect(html).toContain('<a href="https://leetcode.com/problems/group-anagrams/" target="_blank" rel="noopener noreferrer"');
    expect(html.replace(/<!-- -->/g, "")).toMatch(/>49\. Group Anagrams<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/neetcode.io\/solutions\/group-anagrams" target="_blank" rel="noopener noreferrer"[^>]*>solution<\/a>/);
    expect(html).toContain("Arrays &amp; Hashing");
    expect(html).toContain("solved without hints");
  });
  it("shows the title alone when the item has no number, and no link when it has no url", () => {
    const html = renderToStaticMarkup(createElement(DoRows, { rows: practiceRowsFor([row(3)], byId) }));
    expect(html).toContain("Two Sum, no number");
    expect(html).not.toContain("<a href=\"https://leetcode");
    expect(html).not.toContain("solution</a>");
    expect(html).not.toMatch(/\d\. Two Sum/);
  });
  it("leaves other practice rows as they were", () => {
    const html = renderToStaticMarkup(createElement(DoRows, { rows: practiceRowsFor([row(null, { task: "Problems 1-20" })], byId) }));
    expect(html).toContain("Problems 1-20");
    expect(html).not.toContain("solution");
  });
  it("draws no links inside a link, and shows the item on the day page's Do table too", () => {
    const rows = practiceRowsFor([row(4)], byId);
    const inLink = renderToStaticMarkup(createElement(DoRows, { rows, link: false }));
    expect(inLink).toContain("Group Anagrams");
    expect(inLink).not.toContain("leetcode.com");
    const table = renderToStaticMarkup(createElement(ReadTable, { rows: [], practice: rows, budgetMinutes: 60 })).replace(/<!-- -->/g, "");
    expect(table).toMatch(/>49\. Group Anagrams<\/a>/);
    expect(table).toContain(">solution</a>");
  });
});
