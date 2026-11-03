import { describe, expect, it } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";
import { planTreeInputSchema } from "@/lib/schemas/plan";
import { fromTreeInput, toTreeInput } from "./planInput";

describe("tree input", () => {
  it("carries practice rows and reservations through the browser round trip", () => {
    const row = { format: "problem-set", id: "M4", task: "Problems 1-10", done: "All solved", minutes: 60, generated: false } as const;
    const cover = { format: "lab", id: null, note: null, task: "Lab", minutes: 30 } as const;
    const root = makeRoot([
      makeNode({ level: "month", title: "M", summary: "s", len: 14, practiceCovers: [cover], children: [makeNode({ level: "week", title: "W", summary: "s", len: 7, practice: [row] })] }),
    ]);
    const input = planTreeInputSchema.parse(toTreeInput(root));
    const back = fromTreeInput(input);
    expect(back.children![0].practiceCovers).toEqual([cover]);
    expect(back.children![0].children![0].practice).toEqual([row]);
  });

  it("carries a heading's unit time and problems through the browser round trip", () => {
    const time = { reading: 180, practice: { "problem-set": 90, lab: 45 } };
    const problems = ["Week 3 · Problems 1-10 from the text"];
    const root = makeRoot([
      makeNode({ level: "month", title: "M", summary: "s", len: 14, time, problems, children: [makeNode({ level: "week", title: "W", summary: "s", len: 7 })] }),
    ]);
    const input = planTreeInputSchema.parse(toTreeInput(root));
    expect(input[0].time).toEqual(time);
    expect(input[0].problems).toEqual(problems);
    const back = fromTreeInput(input);
    expect(back.children![0].time).toEqual(time);
    expect(back.children![0].problems).toEqual(problems);
  });

  it("leaves time and problems undefined when a node has none", () => {
    const root = makeRoot([makeNode({ level: "week", title: "W", summary: "s", len: 7 })]);
    const input = planTreeInputSchema.parse(toTreeInput(root));
    expect("time" in input[0]).toBe(false);
    expect("problems" in input[0]).toBe(false);
    const back = fromTreeInput(input);
    expect(back.children![0].time).toBeUndefined();
    expect(back.children![0].problems).toBeUndefined();
  });
});
