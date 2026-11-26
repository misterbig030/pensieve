import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchivedNotice, TrackHeader } from "./TrackHeader";

const action = async () => {};
const header = (archived: boolean) =>
  renderToStaticMarkup(
    createElement(TrackHeader, {
      title: "Rust",
      pace: "Daily · 5 days a week · 6 h a week",
      done: 2,
      total: 40,
      studied: 2.5,
      planned: 48,
      finish: null,
      adjustHref: "/tracks/t/adjust",
      archived,
      archiveAction: action,
    }),
  );

describe("TrackHeader", () => {
  it("offers to archive an active track beside Adjust plan", () => {
    const html = header(false);
    expect(html).toContain("Adjust plan");
    expect(html).toMatch(/<form[^>]*>.*<button[^>]*type="submit"[^>]*>.*Archive<\/button><\/form>/);
  });

  it("does not offer it again once the track is archived", () => {
    expect(header(true)).not.toContain("Archive</button>");
  });
});

describe("ArchivedNotice", () => {
  it("says the track is off the home page and offers Restore", () => {
    const html = renderToStaticMarkup(createElement(ArchivedNotice, { restoreAction: action }));
    expect(html).toContain("This track is archived");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>.*Restore<\/button>/);
  });
});
