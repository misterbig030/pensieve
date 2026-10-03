import { describe, expect, it } from "vitest";
import { describeUses } from "@/components/pensieve/MaterialsList";
import type { ResearchEvent } from "@/lib/ai/research/events";
import { formatDuration, initialResearch, reduceResearch } from "./researchProgress";

describe("reduceResearch", () => {
  it("folds the stream into counters, a log and the found list", () => {
    const learner = new Set(["https://mine.example.com/post"]);
    const events: ResearchEvent[] = [
      { type: "research.start", caps: { searches: 6, fetches: 12, steps: 12 } },
      { type: "research.reading", url: "https://mine.example.com/post" },
      { type: "research.fetch", url: "https://mine.example.com/post", ok: true },
      { type: "research.search", query: "best book", results: 5 },
      { type: "research.reading", url: "https://docs.example.com/" },
      { type: "research.verified", id: "M1", title: "AI Engineering", kind: "book", backbone: true },
      { type: "research.dropped", title: "Top 10 books", reason: "a list page" },
    ];
    const state = events.reduce((s, e) => reduceResearch(s, e, learner), initialResearch(0));
    expect(state).toMatchObject({ searches: 1, reads: 1, verified: 1, dropped: 1, reading: "https://docs.example.com/", running: true });
    expect(state.log.map((l) => l.kind)).toEqual(["source", "searched", "verified", "dropped"]);
    expect(state.found).toEqual([{ id: "M1", title: "AI Engineering", kind: "book", backbone: true, yours: false }]);

    const done = reduceResearch(
      state,
      {
        type: "research.done",
        materials: [
          { id: "M1", origin: "research", type: "link", kind: "book", url: "https://x", title: "AI Engineering", author: null, year: null, why: null, backbone: true, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null },
        ],
        dropped: [],
        notice: "thin",
        counts: { searches: 1, fetches: 1 },
      },
      learner,
    );
    expect(done).toMatchObject({ running: false, reading: null, notice: "thin" });
  });
});

describe("describeUses", () => {
  it("names where a material is assigned and reserved", () => {
    expect(
      describeUses([
        { label: "Week 2", role: "assigned" },
        { label: "Week 11", role: "assigned" },
        { label: "Month 3", role: "covers" },
      ]),
    ).toBe("It's assigned in Week 2 and Week 11, and reserved by Month 3. Those units keep their other materials.");
    expect(describeUses([])).toBe("No unit uses it yet.");
  });
});

describe("formatDuration", () => {
  it.each([
    [45, "45 min"],
    [60, "1 h"],
    [90, "1 h 30"],
  ])("%i", (m, text) => expect(formatDuration(m)).toBe(text));
});
