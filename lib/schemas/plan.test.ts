import { describe, expect, it } from "vitest";
import { capProblems, MAX_PROBLEM_CHARS, MAX_PROBLEMS, problemsSchema } from "./plan";

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
