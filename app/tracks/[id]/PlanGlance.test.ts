import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SPLIT_SET_BY_LEARNER, type PlanSplit } from "@/lib/studyTime";
import { PlanGlance } from "./PlanGlance";

const summary = "8 weeks on Senior software engineer interview preparation, usually 5 study days a week.";
const split: PlanSplit = { readingShare: 65, practice: "building projects", reason: "Mostly reading, with projects." };
const render = (props: Partial<Parameters<typeof PlanGlance>[0]> = {}) =>
  renderToStaticMarkup(createElement(PlanGlance, { summary, totalHours: 48, split, materials: [], ...props })).replace(/<!-- -->/g, "");

describe("PlanGlance", () => {
  it("shows the summary clamped to two lines, and the split with its heading", () => {
    const html = render();
    expect(html).toMatch(new RegExp(`<p[^>]*line-clamp-2[^>]*>${summary}</p>`));
    expect(html).toContain("How the 48 h split");
    expect(html).toContain("The plan’s call");
    expect(html).toContain("Reading · 65%");
    expect(html).toContain("Building projects · 35%");
    expect(html.match(/style="width:\d+(\.\d+)?%"/g)).toHaveLength(2);
  });

  it("says Your call for a split the learner set, with no Why", () => {
    const html = render({ split: { ...split, reason: SPLIT_SET_BY_LEARNER } });
    expect(html).toContain("Your call");
    expect(html).not.toContain(">Why<");
  });

  it("offers Why for the plan's reason", () => {
    expect(render()).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Why<\/button>/);
  });

  it("shows the summary alone, full width, when there is no split", () => {
    const html = render({ split: null });
    expect(html).toContain(summary);
    expect(html).not.toContain("split");
    expect(html).not.toContain('role="img"');
  });
});
