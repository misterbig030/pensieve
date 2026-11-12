import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capProblems, MAX_LEVEL_UNITS, MAX_PROBLEM_CHARS, MAX_PROBLEMS, problemsSchema, unitListSchema } from "./plan";

describe("unitListSchema", () => {
  const unit = { title: "Foundations", summary: "Why it comes first." };

  it("sends no cap on units to the model, which Gemini refuses", () => {
    const sent = JSON.stringify(z.toJSONSchema(unitListSchema));
    expect(sent).not.toMatch(/"units":\{[^}]*"maxItems"/);
    expect(sent).toContain('"minItems":1');
  });

  it("still takes 1 to 40 units and refuses none or more", () => {
    expect(unitListSchema.safeParse({ units: [unit] }).success).toBe(true);
    expect(unitListSchema.safeParse({ units: Array.from({ length: MAX_LEVEL_UNITS }, () => unit) }).success).toBe(true);
    expect(unitListSchema.safeParse({ units: [] }).success).toBe(false);
    expect(unitListSchema.safeParse({ units: Array.from({ length: MAX_LEVEL_UNITS + 1 }, () => unit) }).success).toBe(false);
  });
});

describe("capProblems", () => {
  it("leaves a list within the limits as it is", () => {
    const lines = ["Week 1 has no time set for its activities.", "Week 2 plans 5 h in a week of 4 h."];
    expect(capProblems(lines)).toEqual(lines);
    expect(capProblems([])).toEqual([]);
  });

  it("keeps the first lines and says how many more there are when the list runs past the limit", () => {
    const lines = Array.from({ length: 55 }, (_, i) => `Problem ${i + 1}.`);
    const capped = capProblems(lines);
    expect(capped).toHaveLength(MAX_PROBLEMS);
    expect(capped.slice(0, MAX_PROBLEMS - 1)).toEqual(lines.slice(0, MAX_PROBLEMS - 1));
    expect(capped[MAX_PROBLEMS - 1]).toBe(`…and ${55 - (MAX_PROBLEMS - 1)} more.`);
    expect(problemsSchema.safeParse(capped).success).toBe(true);
    // Exactly at the limit, nothing is folded.
    expect(capProblems(lines.slice(0, MAX_PROBLEMS))).toEqual(lines.slice(0, MAX_PROBLEMS));
  });

  it("shortens a line past the limit, its ellipsis inside it", () => {
    const long = "x".repeat(MAX_PROBLEM_CHARS + 20);
    const [line] = capProblems([long]);
    expect(line).toHaveLength(MAX_PROBLEM_CHARS);
    expect(line.endsWith("…")).toBe(true);
    expect(problemsSchema.safeParse([line]).success).toBe(true);
    expect(capProblems(["y".repeat(MAX_PROBLEM_CHARS)])[0]).toHaveLength(MAX_PROBLEM_CHARS);
  });
});
