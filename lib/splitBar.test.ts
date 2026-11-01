import { describe, expect, it } from "vitest";
import { splitBar } from "./splitBar";

const pick = (format: "problem-set" | "design-exercise" | "mock", share: number) => ({ format, share, focus: `${format} focus`, reason: "" });
const sources = [
  { id: "M1", minutes: 600 },
  { id: "P1", minutes: null, practice: { format: "problem-set", minutes: 600 } },
  { id: "P2", minutes: null, practice: { format: "design-exercise", minutes: 600 } },
] as unknown as Parameters<typeof splitBar>[1];

describe("splitBar", () => {
  it("gives reading first, then each pick with its shade, percent and width", () => {
    const { parts, toReading } = splitBar({ readingShare: 40, practice: "problems and design", reason: "r", formats: [pick("problem-set", 50), pick("design-exercise", 50)] }, sources);
    expect(parts.map((p) => [p.key, p.kind, p.percent, p.shade])).toEqual([
      ["reading", "reading", 40, "bg-accent-700"],
      ["problem-set", "practice", 30, "bg-accent-2-700"],
      ["design-exercise", "practice", 30, "bg-accent-2-500"],
    ]);
    expect(parts[1].focus).toBe("problem-set focus");
    expect(parts.reduce((sum, p) => sum + p.width, 0)).toBeCloseTo(100);
    expect(toReading).toEqual([]);
  });

  it("shows an old split's practice as one part", () => {
    const { parts } = splitBar({ readingShare: 65, practice: "building projects", reason: "r" }, []);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ kind: "practice", label: "Building projects", shade: "bg-accent-2-700", percent: 35, width: 35 });
  });

  it("folds a pick with no source into reading", () => {
    const { parts, toReading } = splitBar({ readingShare: 50, practice: "problems and design", reason: "r", formats: [pick("problem-set", 50), pick("design-exercise", 50)] }, sources.slice(0, 1));
    expect(parts.map((p) => p.key)).toEqual(["reading", "design-exercise"]);
    expect(toReading).toEqual(["Problems"]);
    expect(parts[0]).toMatchObject({ percent: 75, width: 75 });
  });

  it("leaves out a practice part with no share", () => {
    const { parts } = splitBar({ readingShare: 100, practice: "reading", reason: "r", formats: [] }, []);
    expect(parts.map((p) => p.key)).toEqual(["reading"]);
  });
});
