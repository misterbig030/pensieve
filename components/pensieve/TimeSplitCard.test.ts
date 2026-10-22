import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeSplitCard } from "./TimeSplitCard";

const card = (split: Parameters<typeof TimeSplitCard>[0]["split"], materials: Parameters<typeof TimeSplitCard>[0]["materials"] = []) =>
  renderToStaticMarkup(createElement(TimeSplitCard, { weeks: 12, hoursPerWeek: 6, daysPerWeek: 5, split, materials }));

describe("TimeSplitCard", () => {
  it("shows no practice legend on an all-reading plan", () => {
    const html = card({ readingShare: 100, practice: "reading", reason: "Nothing to practise.", formats: [] });
    expect(html).toContain("Reading and watching · about 72 h");
    expect(html).not.toContain("about 0 h");
  });

  it("counts a pick with no source as reading and says so, with no hours of its own", () => {
    const pick = (format: "problem-set" | "design-exercise", share: number) => ({ format, share, focus: "f", reason: "" });
    const html = card({ readingShare: 50, practice: "problems and design", reason: "r", formats: [pick("problem-set", 50), pick("design-exercise", 50)] }, [{ id: "M1", minutes: 600 }]);
    expect(html).toContain("Reading and watching · about 54 h");
    expect(html).toContain("Problems · no source found, so its time is reading");
    expect(html).toContain("Design · about 18 h");
  });
});
