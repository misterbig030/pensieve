import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityTab, type ActivityRow } from "./ActivityTab";

const today = new Date("2026-10-31T12:00:00Z"); // a Saturday
const row = (iso: string, nodeTitle: string, hours: number | null, studyHours: number): ActivityRow => ({
  nodeId: nodeTitle,
  completedAt: new Date(iso),
  hours,
  studyHours,
  nodeTitle,
  nodeLevel: "day",
  trackId: "t",
  trackTitle: "Track",
});
const rows = [row("2026-10-30T10:00:00Z", "The Senior Loop and Scaling Basics", null, 1.25), row("2026-10-31T09:00:00Z", "Back-of-the-Envelope Estimation", null, 1.25)];
const render = (props: Partial<Parameters<typeof ActivityTab>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ActivityTab, { rows, createdAt: new Date("2026-10-29T08:00:00Z"), today, studied: 2.5, finish: new Date("2026-12-26T00:00:00Z"), ...props }),
  ).replace(/<!-- -->/g, "");

describe("ActivityTab", () => {
  it("heads each week with its total", () => {
    const html = render();
    expect(html).toContain("Week of 26 Oct");
    expect(html).toContain("2 days · 2.5 h");
  });

  it("fills the dates studied and names them", () => {
    const html = render();
    expect(html).toMatch(/data-state="studied"[^>]*title="Fri 30 Oct · The Senior Loop and Scaling Basics"/);
    expect(html).toMatch(/data-state="studied"[^>]*data-today="true"/);
    expect(html).toContain("Your study days");
  });

  it("lets the keyboard reach each studied date and reads out what was done", () => {
    const html = render({ rows: [...rows, row("2026-10-30T15:00:00Z", "Caching Basics", 1, 1)] });
    expect(html).toMatch(/data-state="studied"[^>]*tabindex="0"[^>]*role="img"[^>]*aria-label="Fri 30 Oct\nThe Senior Loop and Scaling Basics\nCaching Basics"/);
    expect(html).not.toMatch(/data-state="empty"[^>]*tabindex/);
  });

  it("shows hours, dates studied and the estimated finish under the grid", () => {
    const html = render();
    expect(html).toContain("2.5 h studied · on 2 days");
    expect(html).toContain("Estimated finish: 26 Dec");
  });

  it("leaves out the finish once the plan is finished", () => {
    expect(render({ finish: null })).not.toContain("Estimated finish");
  });

  it("still shows the grid with no check-ins", () => {
    const html = render({ rows: [], studied: 0 });
    expect(html).toContain("No check-ins yet");
    expect(html).toContain("Your study days");
    expect(html).toMatch(/data-today="true"/);
  });
});
