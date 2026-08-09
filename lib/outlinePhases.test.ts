import { describe, expect, it } from "vitest";
import { buildPhases, chunkIntoPhases } from "./outlinePhases";

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    dayIndex: i + 1,
    title: `Day ${i + 1} title`,
    summary: `Day ${i + 1} summary`,
  }));

describe("chunkIntoPhases", () => {
  it("returns an empty array for no items", () => {
    expect(chunkIntoPhases([])).toEqual([]);
  });

  it("splits into at most 3 roughly-equal chunks", () => {
    const chunks = chunkIntoPhases(items(7));
    expect(chunks).toHaveLength(3);
    expect(chunks.flat()).toHaveLength(7);
  });

  it("uses fewer chunks than 3 when there are fewer items", () => {
    const chunks = chunkIntoPhases(items(2));
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length === 1)).toBe(true);
  });
});

describe("buildPhases", () => {
  it("labels phases and computes a day range", () => {
    const phases = buildPhases(items(6));
    expect(phases.map((p) => p.label)).toEqual([
      "Foundations",
      "Applied practice",
      "Mastery & review",
    ]);
    expect(phases[0].range).toBe("Day 1–2");
  });

  it("uses a single-day range and focus for a one-item phase", () => {
    const phases = buildPhases(items(1));
    expect(phases[0].range).toBe("Day 1");
    expect(phases[0].focus).toBe("Day 1 title.");
  });
});
