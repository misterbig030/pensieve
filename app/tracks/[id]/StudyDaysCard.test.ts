import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudyDaysCard } from "./StudyDaysCard";

const today = new Date("2026-10-31T12:00:00Z"); // a Saturday
const rows = [
  { completedAt: new Date("2026-10-30T10:00:00Z"), nodeTitle: "The Senior Loop and Scaling Basics" },
  { completedAt: new Date("2026-10-31T09:00:00Z"), nodeTitle: "Back-of-the-Envelope Estimation" },
];
const render = (createdAt = new Date("2026-10-29T08:00:00Z")) =>
  renderToStaticMarkup(createElement(StudyDaysCard, { rows, createdAt, today })).replace(/<!-- -->/g, "");

describe("StudyDaysCard", () => {
  it("shows the caption, 12 columns of 7 days and the days studied", () => {
    const html = render();
    expect(html).toContain("Your study days");
    expect(html.match(/data-state=/g)).toHaveLength(84);
    expect(html).toContain("Studied on 2 days");
    expect(html).not.toContain("since you started");
  });

  it("says since you started for a track older than the grid", () => {
    expect(render(new Date("2026-01-01T08:00:00Z"))).toContain("Studied on 2 days since you started");
  });

  it("shows no hours, finish or Activity link", () => {
    const html = render();
    expect(html).not.toMatch(/\d h\b/);
    expect(html).not.toMatch(/finish/i);
    expect(html).not.toContain("Activity");
  });

  it("lets the keyboard reach a studied date", () => {
    expect(render()).toMatch(/data-state="studied"[^>]*tabindex="0"[^>]*role="img"[^>]*aria-label="Fri 30 Oct · The Senior Loop and Scaling Basics"/);
  });

  it("labels the months over their columns", () => {
    const html = render();
    for (const m of ["Aug", "Sep", "Oct"]) expect(html).toContain(`>${m}<`);
  });
});
