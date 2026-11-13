import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS } from "@/lib/__fixtures__/problemList";
import { practiceRowsFor, readRowsFor, rowBrief } from "@/components/pensieve/ReadTable";
import { findNode, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { Material, MaterialRef, PracticeRef } from "@/lib/schemas/material";
import { adjustAnswer, adjustOpening, defaultOpen, lengthLabel, lockLine, nextLeafLabel, openRows, rowLine, touches, unitHours } from "./draftPage";

const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", backbone: false, practice: LISTED_PROBLEMS };
const byId = new Map<string, Material>([...AIE_MATERIALS, bank].map((m) => [m.id, m]));

const day = (id: string) => makeNode({ id, level: "day", title: id, summary: "", len: 1 });
const week = (id: string, days = 5, extra: Partial<Parameters<typeof makeNode>[0]> = {}) =>
  makeNode({ id, level: "week", title: id, summary: "", len: days, children: Array.from({ length: days }, (_, i) => day(`${id}d${i + 1}`)), ...extra });
const weekLeaf = (id: string) => makeNode({ id, level: "week", title: id, summary: "", len: 5, budgetHours: 6 });
const heading = (id: string, level: "week" | "month", len: number, summary = "") => makeNode({ id, level, title: id, summary, len });

const plan3 = makeRoot([week("w1"), week("w2"), week("w3")]);
const weekPlan = makeRoot([week("w1"), week("w2")]);
const monthPlan = makeRoot([
  makeNode({ id: "m1", level: "month", title: "m1", summary: "", len: 10, children: [week("m1w1"), week("m1w2")] }),
  heading("m2", "month", 20),
]);
const weekLeavesPlan = makeRoot([weekLeaf("a"), weekLeaf("b")]);
const sixMonths = makeRoot(Array.from({ length: 6 }, (_, i) => heading(`m${i}`, "month", 20)));
const fiveDays = makeRoot(Array.from({ length: 5 }, (_, i) => day(`d${i}`)));

const read: MaterialRef[] = [{ id: "aie", tier: "must", minutes: 30, note: null, chapter: 1 }];
const doing: PracticeRef[] = [
  { format: "problem-set", id: "nc", task: "t", done: "d", minutes: 20, generated: false, itemFrom: 1, itemTo: 1 },
  { format: "problem-set", id: "nc", task: "t", done: "d", minutes: 20, generated: false, itemFrom: 2, itemTo: 2 },
];
const withWork = makeNode({ id: "ww", level: "day", title: "t", summary: "A summary", len: 1, materials: read, practice: doing });

describe("lengthLabel", () => {
  it("counts the top units once they exist", () => {
    expect(lengthLabel(26, 5, sixMonths.children!)).toBe("6 months");
    expect(lengthLabel(1, 5, fiveDays.children!)).toBe("5 days");
  });
  it("falls back to the length the learner set before anything is drafted", () => {
    expect(lengthLabel(8, 5, [])).toBe("8 weeks");
    expect(lengthLabel(1, 5, [])).toBe("1 week");
    expect(lengthLabel(26, 5, [])).toBe("7 months");
  });
});

describe("unitHours", () => {
  it("uses a week's own budget, else its share of the weekly hours", () => {
    const budgeted = makeNode({ id: "b", level: "week", title: "b", summary: "", len: 5, budgetHours: 13 });
    const month = heading("mo", "month", 20);
    const root = makeRoot([budgeted, month]);
    expect(unitHours(root, budgeted, 6, 5)).toBe(13);
    expect(unitHours(root, month, 6, 5)).toBe(24);
  });
});

describe("rowLine", () => {
  it("shows a heading's summary", () => {
    expect(rowLine(heading("h", "week", 5, "Genki I lessons 5–8"), byId)).toBe("Genki I lessons 5–8");
  });
  it("shows what a unit with work reads and does, not its summary", () => {
    const line = rowLine(withWork, byId);
    expect(line).toContain(rowBrief(readRowsFor(read, byId)[0]).head);
    expect(line).toContain("Problems (2)");
    expect(line).not.toContain(withWork.summary);
    expect(practiceRowsFor(doing, byId)).toHaveLength(2);
  });
});

describe("defaultOpen", () => {
  it("opens a new plan's first unit, and in a month plan its first week too", () => {
    expect([...defaultOpen(weekPlan, "create", null)]).toEqual(["w1"]);
    expect([...defaultOpen(monthPlan, "create", null)].sort()).toEqual(["m1", "m1w1"]);
  });
  it("opens the way to the current day in Adjust", () => {
    expect(defaultOpen(plan3, "adjust", "w3d3")).toEqual(new Set(["w3", "w3d3"]));
  });
});

describe("openRows", () => {
  it("lays the learner's own opening and closing over the defaults", () => {
    expect(openRows(weekPlan, "create", null, new Map([["w1", false], ["w2", true]]))).toEqual(new Set(["w2"]));
  });
});

describe("lockLine and nextLeafLabel", () => {
  it("names the finished weeks and days and where changes start", () => {
    expect(lockLine(plan3, 12)).toBe("Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are. Changes apply from Day 3 of Week 3.");
    expect(nextLeafLabel(plan3, 12)).toBe("Day 3 of Week 3");
  });
  it("uses the singular for one finished unit", () => {
    expect(lockLine(plan3, 5)).toBe("Week 1 is done and stays as it is. Changes apply from Day 1 of Week 2.");
  });
  it("says nothing when nothing is done", () => {
    expect(lockLine(plan3, 0)).toBeNull();
  });
  it("says so when every day is done", () => {
    expect(lockLine(plan3, 15)).toBe("Every day of this plan is done, so there is nothing left to change.");
    expect(nextLeafLabel(plan3, 15)).toBeNull();
  });
  it("names a leaf week by its own label", () => {
    expect(nextLeafLabel(weekLeavesPlan, 5)).toBe("Week 2");
  });
  it("names a part of the first week alone", () => {
    expect(lockLine(plan3, 1)).toBe("The first day of Week 1 is done and stays as it is. Changes apply from Day 2 of Week 1.");
  });
});

describe("adjustOpening", () => {
  it("tells the learner where they are in Adjust", () => {
    expect(adjustOpening(plan3, 12)).toBe("You're on Day 3 of Week 3. Tell me what to change from here on. Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are.");
    expect(adjustOpening(plan3, 0)).toBe("Nothing is checked off yet, so the whole plan is open to change.");
    expect(adjustOpening(plan3, 15)).toBe("Every day of this plan is done, so there is nothing left to change.");
  });
  it("offers to work on the rest only while some of the plan is left", () => {
    expect(adjustAnswer(plan3, 12)).toMatch(/^Here is the rest of your plan as it stands\./);
    expect(adjustAnswer(plan3, 0)).toMatch(/^Here is the rest of your plan as it stands\./);
    expect(adjustAnswer(plan3, 15)).toBeNull();
  });
});

describe("touches", () => {
  it("is true when the node or anything under it is in the set", () => {
    expect(touches(findNode(plan3, "w3") as PlanNode, new Set(["w3d4"]))).toBe(true);
    expect(touches(findNode(plan3, "w2") as PlanNode, new Set(["w3d4"]))).toBe(false);
  });
});
