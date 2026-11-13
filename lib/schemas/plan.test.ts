import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capProblems, MAX_LEVEL_UNITS, MAX_PROBLEM_CHARS, MAX_PROBLEMS, problemsSchema, revisedTreeSchema, unitListSchema } from "./plan";

/** The JSON schema `generateObject` sends: the AI SDK's own conversion (`asSchema`, zod 4 at `io: "input"`). */
function sent(schema: Parameters<typeof asSchema>[0]): unknown {
  return asSchema(schema).jsonSchema;
}

/**
 * Every property a JSON schema leaves out of its object's `required`, counting each nested copy. Anthropic's strict
 * output (`output_format`, which `@ai-sdk/anthropic` sends on a user's own key) refuses a schema with more than 24.
 */
function optionalCount(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, n) => sum + optionalCount(n), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  const required = new Set(Array.isArray(o.required) ? o.required : []);
  const own = o.properties && typeof o.properties === "object" ? Object.keys(o.properties).filter((k) => !required.has(k)).length : 0;
  return own + Object.values(o).reduce((sum: number, v) => sum + optionalCount(v), 0);
}

/** Anthropic's limit on optional parameters across one request's strict schemas. */
const ANTHROPIC_MAX_OPTIONAL = 24;

describe("optionalCount", () => {
  it("counts every property left out of required, nested ones too", () => {
    expect(optionalCount({ type: "object", properties: { a: {}, b: { type: "object", properties: { c: {}, d: {} }, required: ["c"] } }, required: ["a"] })).toBe(2);
  });
});

describe("revisedTreeSchema", () => {
  const unit = (depth: number, title: string, extra: Record<string, unknown> = {}) => ({ depth, title, summary: "s", days: 1, ...extra });

  it("sends the model no more optional parameters than Anthropic's strict output takes", () => {
    // A nested month → week → day schema repeated every optional field three times: 38, refused on a user's key.
    expect(optionalCount(sent(revisedTreeSchema))).toBe(12);
    expect(optionalCount(sent(revisedTreeSchema))).toBeLessThanOrEqual(ANTHROPIC_MAX_OPTIONAL);
    expect(optionalCount(sent(unitListSchema))).toBeLessThanOrEqual(ANTHROPIC_MAX_OPTIONAL);
  });

  it("sends one flat unit, not a nested tree", () => {
    const schema = JSON.stringify(sent(revisedTreeSchema));
    expect(schema).not.toContain('"children"');
    expect(schema).toContain('"depth"');
  });

  it("rebuilds the tree from the outline's depths", () => {
    const tree = revisedTreeSchema.parse({
      units: [unit(1, "M1", { ref: "n1" }), unit(2, "W1"), unit(3, "D1"), unit(3, "D2"), unit(2, "W2"), unit(1, "M2")],
    });
    expect(tree).toEqual({
      units: [
        {
          ref: "n1",
          title: "M1",
          summary: "s",
          days: 1,
          children: [
            { title: "W1", summary: "s", days: 1, children: [{ title: "D1", summary: "s", days: 1 }, { title: "D2", summary: "s", days: 1 }] },
            { title: "W2", summary: "s", days: 1 },
          ],
        },
        { title: "M2", summary: "s", days: 1 },
      ],
    });
  });

  it("keeps the fields a unit leaves out left out, so a kept unit keeps its own", () => {
    const tree = revisedTreeSchema.parse({ units: [unit(1, "W1", { ref: "n1", covers: [{ id: "M1" }] })] });
    expect(tree.units[0]).toEqual({ ref: "n1", title: "W1", summary: "s", days: 1, covers: [{ id: "M1" }] });
    expect(tree.units[0]).not.toHaveProperty("children");
  });

  it("puts a unit that skips a level just inside the unit above it", () => {
    const tree = revisedTreeSchema.parse({ units: [unit(2, "W1"), unit(3, "D1"), unit(1, "W2"), unit(3, "D2")] });
    expect(tree.units.map((u) => [u.title, u.children?.map((c) => c.title)])).toEqual([
      ["W1", ["D1"]],
      ["W2", ["D2"]],
    ]);
  });

  it("takes up to 40 units at a level and refuses none or more", () => {
    const tops = (n: number) => Array.from({ length: n }, (_, i) => unit(1, `W${i + 1}`));
    expect(revisedTreeSchema.safeParse({ units: tops(MAX_LEVEL_UNITS) }).success).toBe(true);
    expect(revisedTreeSchema.safeParse({ units: [] }).success).toBe(false);
    expect(revisedTreeSchema.safeParse({ units: tops(MAX_LEVEL_UNITS + 1) }).success).toBe(false);
    const days = Array.from({ length: MAX_LEVEL_UNITS + 1 }, (_, i) => unit(2, `D${i + 1}`));
    expect(revisedTreeSchema.safeParse({ units: [unit(1, "W1"), ...days] }).success).toBe(false);
  });
});

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
