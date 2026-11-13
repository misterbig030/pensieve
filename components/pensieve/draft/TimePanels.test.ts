import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanSplit } from "@/lib/studyTime";
import { DaysPanel, HoursPanel, ReadingPanel } from "./TimePanels";

const reading = (split: PlanSplit | null, materials: { id: string; minutes: number }[] = [], deciding = false) =>
  renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(ReadingPanel, { split, deciding, totalHours: 72, materials: materials as any, disabled: false, onChange: () => {} }),
  ).replace(/<!-- -->/g, "");

describe("the time panels", () => {
  it("shows the per-kind breakdown above the reading slider", () => {
    const html = reading({ readingShare: 65, practice: "building projects", reason: "r" });
    expect(html).toContain("How the 72 h split");
    expect(html.indexOf("How the 72 h split")).toBeLessThan(html.indexOf('type="range"'));
    expect(html).toContain("Reading and watching: 65% of your time");
  });
  it("says a pick with no source is drafted as reading", () => {
    const pick = (format: "problem-set" | "design-exercise", share: number) => ({ format, share, focus: "f", reason: "" });
    const html = reading({ readingShare: 50, practice: "problems and design", reason: "r", formats: [pick("problem-set", 50), pick("design-exercise", 50)] }, [{ id: "M1", minutes: 600 }]);
    expect(html).toContain("Problems · no source found, so its time is reading");
  });
  it("has no slider on an all-reading plan, and says why", () => {
    const html = reading({ readingShare: 100, practice: "reading", reason: "Nothing to practise.", formats: [] });
    expect(html).not.toContain('type="range"');
    expect(html).toContain("All reading: no practice was picked for this topic, so there is no share to move.");
  });
  it("offers to divide the time on a plan saved with no split", () => {
    expect(reading(null)).toContain("Divide the time between reading and practice");
  });
  it("says the split is coming while the draft decides it", () => {
    expect(reading(null, [], true)).toContain("The plan decides how to divide this between reading and practice as it drafts the first units.");
  });
  it("offers today's hour presets and says the open weeks get re-drafted", () => {
    const html = renderToStaticMarkup(createElement(HoursPanel, { hoursPerWeek: 13, disabled: false, onChange: () => {} }));
    expect(html).toContain("Casual · 3 h");
    expect(html).toContain("Full time · 30 h");
    expect(html).toContain("The open weeks get re-drafted for it.");
  });
  it("keeps today's note on days already split", () => {
    const html = renderToStaticMarkup(createElement(DaysPanel, { daysPerWeek: 5, disabled: false, onChange: () => {} }));
    expect(html).toContain("Applies to weeks you split from now on. Weeks already split keep their days.");
  });
});
