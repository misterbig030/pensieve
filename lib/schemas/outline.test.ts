import { describe, expect, it } from "vitest";
import { outlineDraftSchema } from "./outline";

describe("outlineDraftSchema", () => {
  it("accepts a valid draft", () => {
    const result = outlineDraftSchema.safeParse({
      items: [
        { dayIndex: 1, title: "System design basics", summary: "Intro to scalability" },
        { dayIndex: 2, title: "Load balancing", summary: "L4 vs L7, algorithms" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an item missing a summary", () => {
    const result = outlineDraftSchema.safeParse({
      items: [{ dayIndex: 1, title: "System design basics" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty items array", () => {
    const result = outlineDraftSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });
});
