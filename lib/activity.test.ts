import { describe, expect, it } from "vitest";
import { heatmapWeeks, monthLabels, monthTotals, relativeDay, shortDate, studyCalendar, studyDates, thisWeekKeys, weekStart, weekdayDate } from "./activity";

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

describe("shortDate", () => {
  it("formats the UTC day as month and day", () => {
    expect(shortDate(new Date("2026-11-21T23:30:00Z"))).toBe("Nov 21");
  });
});

describe("weekdayDate", () => {
  it("names the UTC day without a clock time", () => {
    expect(weekdayDate(new Date("2026-10-30T23:15:00Z"))).toBe("Friday, 30 Oct");
  });
});

describe("studyCalendar", () => {
  const saturday = new Date("2026-10-31T12:00:00Z");
  const row = (iso: string, nodeTitle = "A day") => ({ completedAt: new Date(iso), nodeTitle });

  it("always shows 12 weeks, blank before the track", () => {
    const weeks = studyCalendar([], new Date("2026-10-29T09:00:00Z"), saturday);
    expect(weeks).toHaveLength(12);
    expect(weeks[0].monday.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(weeks.slice(0, 11).every((w) => w.days.every((d) => d.state === "before"))).toBe(true);
    expect(weeks[11].days.map((d) => d.state)).toEqual(["before", "before", "before", "empty", "empty", "empty", "future"]);
    expect(weeks[11].days.map((d) => d.today)).toEqual([false, false, false, false, false, true, false]);
  });

  it("shows at most the last 12 weeks", () => {
    const weeks = studyCalendar([], new Date("2026-06-01T09:00:00Z"), saturday);
    expect(weeks).toHaveLength(12);
    expect(weeks.at(-1)!.monday.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(weeks[0].days.every((d) => d.state === "empty")).toBe(true);
  });

  it("fills a date once and names every check-in on it", () => {
    const weeks = studyCalendar([row("2026-10-30T18:00:00Z", "Second"), row("2026-10-30T08:00:00Z", "First")], new Date("2026-10-26T09:00:00Z"), saturday);
    expect(weeks[11].days[4]).toMatchObject({ key: "2026-10-30", state: "studied", titles: ["First", "Second"] });
  });
});

describe("monthLabels", () => {
  it("names the first column and each new month", () => {
    const weeks = studyCalendar([], new Date("2026-06-01T09:00:00Z"), new Date("2026-10-31T12:00:00Z"));
    expect(monthLabels(weeks)).toEqual([
      { index: 0, label: "Aug" },
      { index: 4, label: "Sep" },
      { index: 8, label: "Oct" },
    ]);
  });
});

describe("studyDates", () => {
  it("counts distinct dates", () => {
    const at = (iso: string) => ({ completedAt: new Date(iso) });
    expect(studyDates([at("2026-10-30T08:00:00Z"), at("2026-10-30T20:00:00Z"), at("2026-10-31T08:00:00Z")])).toBe(2);
  });
});
