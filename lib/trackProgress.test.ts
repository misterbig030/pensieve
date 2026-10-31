import { describe, expect, it } from "vitest";
import { findNode, makeNode, makeRoot } from "./planTree";
import { dayMinutes } from "./studyTime";
import { sampleDayPlan, sampleMonthPlan, sampleSplitWeekPlan, sampleWeekPlan } from "./testPlans";
import { cardAction, dayStrip, doneToday, finishDate, plannedHours, sortTracks, studyEvents, weekActivity, type CardAction } from "./trackProgress";

const today = new Date("2026-10-30T12:00:00Z"); // a Friday

describe("dayStrip", () => {
  it("gives one cell per day with week starts marked", () => {
    const cells = dayStrip(sampleDayPlan(), "day", 5);
    expect(cells.map((c) => c.state)).toEqual(["done", "done", "done", "done", "current", "planned", "planned", "planned", "planned"]);
    expect(cells.flatMap((c, i) => (c.weekStart ? [i] : []))).toEqual([0, 3, 6]);
  });

  it("marks a written lesson after the current leaf as ready", () => {
    const root = sampleDayPlan();
    findNode(root, "b3")!.status = "generated";
    expect(dayStrip(root, "day", 5)[5].state).toBe("ready");
  });

  it("gives one cell per week on a week-granularity track", () => {
    const cells = dayStrip(sampleWeekPlan(), "week", 5);
    expect(cells.map((c) => c.state)).toEqual(["done", "current", "planned"]);
    expect(cells.every((c) => c.weekStart)).toBe(true);
  });

  it("keeps one cell for a week split into days on a week-granularity track", () => {
    const cells = dayStrip(sampleSplitWeekPlan(), "week", 5);
    expect(cells.map((c) => c.state)).toEqual(["done", "current", "planned"]);
    expect(cells.every((c) => c.weekStart)).toBe(true);
  });

  it("marks a split week done on a week track when all its days are done", () => {
    const root = sampleSplitWeekPlan();
    for (const id of ["b2", "b3", "b4", "b5"]) findNode(root, id)!.status = "completed";
    expect(dayStrip(root, "week", 5).map((c) => c.state)).toEqual(["done", "done", "current"]);
  });

  it("starts a week at each week's first day inside a month", () => {
    const cells = dayStrip(sampleMonthPlan(), "day", 4);
    expect(cells).toHaveLength(12);
    expect(cells.slice(0, 4).map((c) => c.weekStart)).toEqual([true, false, true, false]);
    expect(cells[3].state).toBe("current");
  });
});

describe("finishDate", () => {
  it("spreads the days left over the study days of each week", () => {
    // 5 of 9 days are left in the sample plan
    const root = sampleDayPlan();
    expect(finishDate(root, 5, today)?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
    const ten = makeRoot([makeNode({ id: "w", level: "week", title: "W", summary: "", len: 10 })]);
    expect(finishDate(ten, 5, today)?.toISOString()).toBe("2026-11-13T12:00:00.000Z");
    const three = makeRoot([makeNode({ id: "w", level: "week", title: "W", summary: "", len: 3 })]);
    expect(finishDate(three, 5, today)?.toISOString()).toBe("2026-11-04T12:00:00.000Z");
  });

  it("is null when nothing is left", () => {
    const done = makeRoot([makeNode({ id: "d", level: "day", title: "D", summary: "", len: 1, status: "completed" })]);
    expect(finishDate(done, 5, today)).toBeNull();
  });
});

describe("studyEvents", () => {
  it("turns a finished day into its planned time and keeps a session's hours", () => {
    const events = studyEvents(
      sampleDayPlan(),
      [
        { nodeId: "a1", completedAt: today, hours: null },
        { nodeId: "w2", completedAt: today, hours: 1.5 },
      ],
      6,
      5,
    );
    expect(events).toEqual([
      { at: today, hours: dayMinutes(6, 3) / 60 },
      { at: today, hours: 1.5 },
    ]);
  });
});

describe("plannedHours", () => {
  it("is the plan's weeks times the weekly hours", () => {
    expect(plannedHours(sampleWeekPlan(), 4, 5)).toBe(12);
  });
});

describe("weekActivity", () => {
  it("shows the current plan week's days on a day track", () => {
    expect(weekActivity(sampleDayPlan(), "day", [], today, 6, 5)).toEqual({ cells: ["done", "current", "open", "off", "off", "off", "off"], label: "1 of 3 this week" });
  });

  it("shows no week on a day track whose current week isn't planned", () => {
    const root = sampleDayPlan();
    for (const id of ["b2", "b3"]) findNode(root, id)!.status = "completed";
    expect(weekActivity(root, "day", [], today, 6, 5).cells).toEqual([]);
  });

  it("shows this calendar week's sessions on a week track", () => {
    const sessions = [
      { nodeId: "w2", completedAt: new Date("2026-10-27T10:00:00Z"), hours: 1 },
      { nodeId: "w2", completedAt: new Date("2026-10-30T09:00:00Z"), hours: 0.5 },
      { nodeId: "w1", completedAt: new Date("2026-10-20T09:00:00Z"), hours: 3 },
    ];
    expect(weekActivity(sampleWeekPlan(), "week", sessions, today, 4, 5)).toEqual({
      cells: ["open", "done", "open", "open", "done", "open", "open"],
      label: "1.5 of 4 h",
    });
  });

  it("counts a day finished in a split week as that day's share of the week's hours", () => {
    const finished = [{ nodeId: "b1", completedAt: new Date("2026-10-29T10:00:00Z"), hours: null }];
    expect(weekActivity(sampleSplitWeekPlan(), "week", finished, today, 4, 5)).toEqual({
      cells: ["open", "open", "open", "done", "open", "open", "open"],
      label: "0.8 of 4 h", // 50 minutes
    });
  });
});

describe("doneToday", () => {
  it("is true when any check-in falls on today's UTC day", () => {
    expect(doneToday([{ completedAt: new Date("2026-10-30T00:30:00Z") }], today)).toBe(true);
    expect(doneToday([{ completedAt: new Date("2026-10-29T23:30:00Z") }], today)).toBe(false);
  });
});

describe("cardAction", () => {
  it("starts a day, logs a week, plans a heading and finishes a done plan", () => {
    expect(cardAction(sampleDayPlan())).toMatchObject({ kind: "start", node: { id: "b2" } });
    expect(cardAction(sampleWeekPlan())).toMatchObject({ kind: "log", node: { id: "w2" } });
    const allDays = sampleDayPlan();
    for (const id of ["b2", "b3"]) findNode(allDays, id)!.status = "completed";
    expect(cardAction(allDays)).toMatchObject({ kind: "plan", node: { id: "w3" } });
    const finished = makeRoot([makeNode({ id: "d", level: "day", title: "D", summary: "", len: 1, status: "completed" })]);
    expect(cardAction(finished)).toEqual({ kind: "finished" });
  });
});

describe("sortTracks", () => {
  const node = makeNode({ level: "day", title: "D", summary: "", len: 1 });
  const card = (id: string, action: CardAction, doneToday: boolean, lastStudied: string | null, createdAt: string) => ({
    id,
    action,
    doneToday,
    lastStudied: lastStudied ? new Date(lastStudied) : null,
    createdAt: new Date(createdAt),
  });
  const cards = [
    card("finished", { kind: "finished" }, false, "2026-10-29", "2026-01-01"),
    card("plan", { kind: "plan", node }, false, "2026-10-29", "2026-01-02"),
    card("done", { kind: "start", node }, true, "2026-10-30", "2026-01-03"),
    card("old", { kind: "start", node }, false, "2026-10-01", "2026-01-04"),
    card("fresh", { kind: "log", node }, false, "2026-10-28", "2026-01-05"),
    card("never", { kind: "start", node }, false, null, "2026-01-06"),
  ];

  it("puts what is left to do today first", () => {
    expect(sortTracks(cards, "next").map((c) => c.id)).toEqual(["fresh", "old", "never", "done", "plan", "finished"]);
  });

  it("sorts by last studied or by newest", () => {
    expect(sortTracks(cards, "recent").map((c) => c.id)).toEqual(["done", "finished", "plan", "fresh", "old", "never"]);
    expect(sortTracks(cards, "newest").map((c) => c.id)).toEqual(["never", "fresh", "old", "done", "plan", "finished"]);
  });
});
