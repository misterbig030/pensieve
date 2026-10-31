import { describe, expect, it } from "vitest";
import { makeRoot } from "@/lib/planTree";
import { day, sampleDayPlan, sampleWeekPlan, week } from "@/lib/testPlans";
import type { CardAction } from "./trackProgress";
import { homeStatus, toTrackCard, type CardCheckIn } from "./trackCard";

const today = new Date("2026-10-30T12:00:00Z");
const createdAt = new Date("2026-10-01T00:00:00Z");
const dayTrack = { id: "t1", title: "Rust", granularity: "day" as const, hoursPerWeek: 5, daysPerWeek: 5, createdAt };
const weekTrack = { id: "t2", title: "Music", granularity: "week" as const, hoursPerWeek: 4, daysPerWeek: 5, createdAt };

function checkIn(nodeId: string, at: string, nodeTitle = `Node ${nodeId}`, hours: number | null = null): CardCheckIn {
  return { nodeId, nodeTitle, completedAt: new Date(at), hours };
}

describe("toTrackCard", () => {
  it("offers today's day on a day track with its pace, progress and finish", () => {
    const card = toTrackCard(dayTrack, sampleDayPlan(), [checkIn("b1", "2026-10-28T10:00:00Z")], today);
    expect(card.pace).toBe("Daily · 1 h");
    expect(card.action).toMatchObject({ kind: "start", node: { id: "b2" } });
    expect(card.actionLabel).toBe("Today · Week 2 · Day 2");
    expect(card.actionTitle).toBe("Day b2");
    expect(card.doneToday).toBe(false);
    expect(card.progress).toEqual({ done: 4, total: 9, unit: "Day" });
    expect(card.finish).toEqual(new Date("2026-11-06T12:00:00Z"));
    expect(card.lastStudied).toEqual(new Date("2026-10-28T10:00:00Z"));
  });

  it("shows what was done today, by the newest check-in today", () => {
    const card = toTrackCard(
      dayTrack,
      sampleDayPlan(),
      [checkIn("b1", "2026-10-30T09:00:00Z", "Lifetimes"), checkIn("a3", "2026-10-29T09:00:00Z", "Traits")],
      today,
    );
    expect(card.doneToday).toBe(true);
    expect(card.actionTitle).toBe("Lifetimes");
  });

  it("offers the current week on a week track, counting weeks", () => {
    const card = toTrackCard(weekTrack, sampleWeekPlan(), [checkIn("w2", "2026-10-29T10:00:00Z", "Intervals", 1.5)], today);
    expect(card.pace).toBe("Weekly · 4 h");
    expect(card.action).toMatchObject({ kind: "log", node: { id: "w2" } });
    expect(card.actionLabel).toBe("This week · Week 2");
    expect(card.actionTitle).toBe("Week w2");
    expect(card.progress).toEqual({ done: 1, total: 3, unit: "Week" });
    expect(card.week.label).toBe("1.5 of 4 h");
  });

  it("asks to plan a heading that is up next", () => {
    const root = makeRoot([week("w1", [day("a1", "completed")]), week("w2", null, { len: 3 })]);
    const card = toTrackCard(dayTrack, root, [], today);
    expect(card.action).toMatchObject({ kind: "plan", node: { id: "w2" } });
    expect(card.actionLabel).toBe("Week 2 isn't planned yet");
    expect(card.lastStudied).toBeNull();
  });

  it("says all days are done on a finished track", () => {
    const root = makeRoot([week("w1", [day("a1", "completed"), day("a2", "completed")])]);
    const card = toTrackCard(dayTrack, root, [], today);
    expect(card.action).toEqual({ kind: "finished" });
    expect(card.actionLabel).toBe("All days done");
    expect(card.actionTitle).toBe("");
    expect(card.finish).toBeNull();
  });
});

describe("homeStatus", () => {
  const card = (kind: CardAction["kind"], doneToday = false) => ({ action: { kind } as CardAction, doneToday });

  it("counts the sessions left today", () => {
    expect(homeStatus([card("start"), card("log"), card("start", true)])).toBe("2 sessions left today. Pick up where you left off.");
  });

  it("doesn't call the day done when nothing was studied and a track needs planning", () => {
    expect(homeStatus([card("plan")])).toBe("One track needs its next part planned.");
    expect(homeStatus([card("plan"), card("start", true)])).toBe("You're done for today. One track needs its next part planned.");
  });

  it("calls the day done only when something was studied", () => {
    expect(homeStatus([card("start", true), card("finished")])).toBe("You're done for today.");
    expect(homeStatus([card("finished")])).toBe("Every track is finished.");
  });
});
