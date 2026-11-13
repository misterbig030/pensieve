import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatStrip, type StatStripProps } from "./StatStrip";

const strip = (over: Partial<StatStripProps> = {}) =>
  renderToStaticMarkup(
    createElement(StatStrip, {
      lengthLabel: "8 weeks",
      topLevel: "week",
      hoursPerWeek: 13,
      daysPerWeek: 5,
      split: { readingShare: 3, practice: "practice", reason: "r" },
      deciding: false,
      totalHours: 104,
      materials: [],
      sourceLabel: "researched",
      disabled: false,
      onChangeHours: () => {},
      onChangeDays: () => {},
      onChangeSplit: () => {},
      ...over,
    }),
  ).replace(/<!-- -->/g, "");

// The opening tag of the button with this label, whatever order its attributes come in.
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

describe("StatStrip", () => {
  it("shows the length and three edit buttons", () => {
    const html = strip();
    expect(html).toContain("8 weeks");
    expect(html).toMatch(/aria-label="Change hours a week"/);
    expect(html).toMatch(/aria-label="Change days a week"/);
    expect(html).toMatch(/aria-label="Change the reading share"/);
    expect(html).toContain("3% reading");
    expect(html).toContain("researched");
  });
  it("has no days button on a one-week plan, and counts its hours in all", () => {
    const html = strip({ topLevel: "day", lengthLabel: "1 week", onChangeDays: undefined });
    expect(html).not.toContain("Change days a week");
    expect(html).toContain("in all");
  });
  it("reads deciding, disabled, while the draft sets the split", () => {
    const html = strip({ split: null, deciding: true });
    expect(html).toContain("deciding…");
    expect(button(html, "Change the reading share")).toContain("disabled");
  });
  it("reads not split on a plan saved with no split", () => {
    expect(strip({ split: null })).toContain("not split");
  });
  it("disables every button while the plan is busy", () => {
    const html = strip({ disabled: true });
    for (const label of ["Change hours a week", "Change days a week", "Change the reading share"]) expect(button(html, label)).toContain("disabled");
  });
});
