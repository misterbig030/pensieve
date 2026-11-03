import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeSplitCard } from "./TimeSplitCard";

const card = (split: Parameters<typeof TimeSplitCard>[0]["split"], materials: Parameters<typeof TimeSplitCard>[0]["materials"] = []) =>
  renderToStaticMarkup(createElement(TimeSplitCard, { weeks: 12, hoursPerWeek: 6, daysPerWeek: 5, split, materials }));

describe("TimeSplitCard", () => {
  it("shows no practice legend on an all-reading plan", () => {
    const html = card({ readingShare: 100, practice: "reading", reason: "Nothing to practise.", formats: [] });
    expect(html).toContain("How this plan spends your 72 h");
    expect(html).toContain("Reading and watching · 100%");
    expect(html).not.toContain("· 0%");
  });

  it("counts a pick with no source as reading and says so, with no share of its own", () => {
    const pick = (format: "problem-set" | "design-exercise", share: number) => ({ format, share, focus: "f", reason: "" });
    const html = card({ readingShare: 50, practice: "problems and design", reason: "r", formats: [pick("problem-set", 50), pick("design-exercise", 50)] }, [{ id: "M1", minutes: 600 }]);
    expect(html).toContain("Reading and watching · 75%");
    expect(html).toContain("Problems · no source found, so its time is reading");
    expect(html).toContain("Design · 25%");
  });

  it("shows a split without picks as two shares of the total", () => {
    const html = card({ readingShare: 65, practice: "building projects", reason: "r" });
    expect(html).toContain("Reading and watching · 65%");
    expect(html).toContain("Building projects · 35%");
    expect(html).not.toMatch(/about \d+ h/);
  });
});
