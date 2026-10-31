import { describe, expect, it } from "vitest";
import { hasStaleSteps, resolveStepTokens, splitLesson, stepKey } from "./lessonSteps";

const lesson = [
  "Intro paragraph.",
  "",
  "```step",
  "task: read:aie#3",
  "minutes: 25",
  "Read **chapter 3** up to the worked example.",
  "```",
  "",
  "Some explanation.",
  "",
  "```step",
  "minutes: 10",
  "task: read:aie#3",
  "Finish the chapter.",
  "```",
  "",
  "```STEP  ",
  "task: practice:problem-set#nc#4",
  "Solve it.",
  "```",
].join("\n");

describe("splitLesson", () => {
  it("returns a lesson without steps as one text part, unchanged", () => {
    const markdown = "# Title\n\nSome text.\n\n```python\nprint(1)\n```\n";
    expect(splitLesson(markdown)).toEqual([{ kind: "text", markdown }]);
  });

  it("splits text and steps in order, numbering steps from 1", () => {
    const parts = splitLesson(lesson);
    expect(parts.map((p) => (p.kind === "step" ? `step ${p.n}` : "text"))).toEqual(["text", "step 1", "text", "step 2", "step 3"]);
    expect(parts[0]).toEqual({ kind: "text", markdown: "Intro paragraph.\n\n" });
    expect(parts[1]).toMatchObject({ body: "Read **chapter 3** up to the worked example." });
  });

  it("reads task and minutes off the top of a step in either order", () => {
    const steps = splitLesson(lesson).filter((p) => p.kind === "step");
    expect(steps.map((s) => [s.taskId, s.minutes])).toEqual([
      ["read:aie#3", 25],
      ["read:aie#3", 10],
      ["practice:problem-set#nc#4", null],
    ]);
    expect(steps[1]).toMatchObject({ body: "Finish the chapter." });
  });

  it("counts repeat steps for the same task with nth", () => {
    const steps = splitLesson(lesson).filter((p) => p.kind === "step");
    expect(steps.map((s) => s.nth)).toEqual([0, 1, 0]);
  });

  it("gives a step with an empty task line a null task", () => {
    const [step] = splitLesson("```step\ntask:\nDo something.\n```");
    expect(step).toMatchObject({ kind: "step", taskId: null, body: "Do something." });
  });

  it("leaves answers fences inside text parts", () => {
    const parts = splitLesson("Q?\n\n```answers\nA.\n```\n\n```step\ntask: T1\nGo.\n```");
    expect(parts[0]).toEqual({ kind: "text", markdown: "Q?\n\n```answers\nA.\n```\n\n" });
  });
});

describe("resolveStepTokens", () => {
  const ids = new Map([
    ["T1", "read:aie#3"],
    ["T2", "practice:problem-set#nc#4"],
  ]);

  it("rewrites step labels to task ids, ignoring case, and empties unknown labels", () => {
    const out = resolveStepTokens("```step\ntask: T1\nGo.\n```\n\n```step\ntask: t2\nGo.\n```\n\n```step\ntask: T9\nGo.\n```", ids);
    expect(out).toBe("```step\ntask: read:aie#3\nGo.\n```\n\n```step\ntask: practice:problem-set#nc#4\nGo.\n```\n\n```step\ntask:\nGo.\n```");
  });

  it("does not touch task: lines outside step fences", () => {
    const markdown = "task: T1\n\n```text\ntask: T1\n```";
    expect(resolveStepTokens(markdown, ids)).toBe(markdown);
  });
});

describe("hasStaleSteps", () => {
  it("flags steps whose task is no longer on the day, but not unlinked ones", () => {
    const parts = splitLesson(lesson);
    expect(hasStaleSteps(parts, new Set(["read:aie#3", "practice:problem-set#nc#4"]))).toBe(false);
    expect(hasStaleSteps(parts, new Set(["read:aie#3"]))).toBe(true);
    expect(hasStaleSteps(splitLesson("```step\ntask:\nGo.\n```"), new Set())).toBe(false);
  });
});

describe("stepKey", () => {
  it("names a step by its task and how many came before it", () => {
    expect(stepKey("read:aie#3", 1)).toBe("read:aie#3@1");
  });
});
