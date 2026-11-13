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
// The button's opening tag and its text, found by what its accessible name contains. The visible text is part of the name.
const button = (html: string, name: string) => {
  for (const m of html.matchAll(/<button[^>]*>.*?<\/button>/g)) if (m[0].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").includes(name)) return m[0];
  return "";
};

describe("StatStrip", () => {
  it("shows the length and three edit buttons", () => {
    const html = strip();
    expect(html).toContain("8 weeks");
    expect(button(html, "Change 13 h a week")).not.toBe("");
    expect(button(html, "Change 5 days a week")).not.toBe("");
    expect(button(html, "Change 3% reading")).not.toBe("");
    expect(html).not.toContain("aria-label=\"Change");
    expect(html).toContain("3% reading");
    expect(html).toContain("researched");
  });
  it("has no days button on a one-week plan, and counts its hours in all", () => {
    const html = strip({ topLevel: "day", lengthLabel: "1 week", onChangeDays: undefined });
    expect(button(html, "days a week")).toBe("");
    expect(html).toContain("in all");
    expect(button(html, "Change 13 h in all")).not.toBe("");
    expect(button(html, "Change 13 h a week")).toBe("");
  });
  it("reads deciding, disabled, while the draft sets the split", () => {
    const html = strip({ split: null, deciding: true });
    expect(html).toContain("deciding…");
    expect(button(html, "Change deciding…")).toContain("disabled");
  });
  it("reads not split on a plan saved with no split", () => {
    expect(strip({ split: null })).toContain("not split");
  });
  it("disables every button while the plan is busy", () => {
    const html = strip({ disabled: true });
    for (const name of ["Change 13 h a week", "Change 5 days a week", "Change 3% reading"]) expect(button(html, name)).toContain("disabled");
  });
});
