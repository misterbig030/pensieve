import { describe, expect, it } from "vitest";
import { byWeek, heatmapWeeks, monthTotals, relativeDay, shortDate, thisWeekKeys, weekStart } from "./activity";

const today = new Date("2026-10-30T12:00:00Z"); // a Friday

describe("weekStart", () => {
  it("is Monday 00:00 UTC of today's week", () => {
    expect(weekStart(today).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("keeps Sunday in the week that started the Monday before", () => {
    expect(weekStart(new Date("2026-11-01T23:30:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("thisWeekKeys", () => {
  it("lists the seven UTC days of this week, Monday first", () => {
    expect(thisWeekKeys(today)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});

describe("heatmapWeeks", () => {
  const dates = ["2026-10-30T08:00:00Z", "2026-10-30T20:00:00Z", "2026-10-27T10:00:00Z"].map((s) => new Date(s));

  it("counts check-ins per day for twelve weeks, oldest first, with days after today marked -1", () => {
    const weeks = heatmapWeeks(dates, today);
    expect(weeks).toHaveLength(12);
    expect(weeks[11]).toEqual([0, 1, 0, 0, 2, -1, -1]);
    expect(weeks[0]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("starts its first column on the Monday eleven weeks before this one", () => {
    const weeks = heatmapWeeks([new Date("2026-08-10T10:00:00Z")], today);
    expect(weeks[0][0]).toBe(1);
  });
});

describe("monthTotals", () => {
  it("counts sessions and hours in today's UTC month, hours to the nearest half", () => {
    const events = [
      { at: new Date("2026-10-02T10:00:00Z"), hours: 0.75 },
      { at: new Date("2026-10-29T10:00:00Z"), hours: 1.5 },
      { at: new Date("2026-09-30T23:59:00Z"), hours: 4 },
    ];
    expect(monthTotals(events, today)).toEqual({ sessions: 2, hours: 2.5 });
  });
});

describe("relativeDay", () => {
  it("names today and yesterday by UTC day", () => {
    expect(relativeDay(new Date("2026-10-30T00:10:00Z"), today)).toBe("today");
    expect(relativeDay(new Date("2026-10-29T23:59:00Z"), today)).toBe("yesterday");
  });

  it("uses the weekday within the last week, then the date", () => {
    expect(relativeDay(new Date("2026-10-27T09:00:00Z"), today)).toBe("Tue");
    expect(relativeDay(new Date("2026-10-24T09:00:00Z"), today)).toBe("Sat");
    expect(relativeDay(new Date("2026-10-23T09:00:00Z"), today)).toBe("Oct 23");
  });
});

describe("byWeek", () => {
  it("groups rows by their Monday-to-Sunday UTC week, newest week and row first", () => {
    const at = (iso: string) => ({ completedAt: new Date(iso) });
    const groups = byWeek([at("2026-10-19T10:00:00Z"), at("2026-10-30T08:00:00Z"), at("2026-10-26T00:00:00Z"), at("2026-10-25T23:59:00Z")]);
    expect(groups.map((g) => g.start.toISOString())).toEqual(["2026-10-26T00:00:00.000Z", "2026-10-19T00:00:00.000Z"]);
    expect(groups[0].rows.map((r) => r.completedAt.toISOString())).toEqual(["2026-10-30T08:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
    expect(groups[1].rows.map((r) => r.completedAt.toISOString())).toEqual(["2026-10-25T23:59:00.000Z", "2026-10-19T10:00:00.000Z"]);
  });

  it("returns no groups for no rows", () => {
    expect(byWeek([])).toEqual([]);
  });
});

describe("shortDate", () => {
  it("formats the UTC day as month and day", () => {
    expect(shortDate(new Date("2026-11-21T23:30:00Z"))).toBe("Nov 21");
  });
});
