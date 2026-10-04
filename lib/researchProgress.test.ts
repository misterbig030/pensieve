import { describe, expect, it } from "vitest";
import { describeUses, thinText } from "@/components/pensieve/MaterialsList";
import type { ResearchEvent } from "@/lib/ai/research/events";
import { approxDuration, formatDuration, initialResearch, reduceResearch } from "./researchProgress";

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

describe("sizes in the research card and list", () => {
  it("rounds sizes the way a reader says them", () => {
    expect(approxDuration(25)).toBe("≈ 25 min");
    expect(approxDuration(72)).toBe("≈ 1 h 10");
    expect(approxDuration(300)).toBe("≈ 5 h");
    expect(approxDuration(1320)).toBe("≈ 22 h");
  });

  it("logs a verified material with its size and whether it was estimated", () => {
    const base = initialResearch(0);
    const measured = reduceResearch(base, { type: "research.verified", id: "M1", title: "AI Engineering", kind: "book", backbone: true, minutes: 1320, basis: "measured" }, new Set());
    expect(measured.log.at(-1)?.detail).toBe("book · ≈ 22 h");
    const estimated = reduceResearch(base, { type: "research.verified", id: "M2", title: "Course", kind: "course", backbone: false, minutes: 480, basis: "estimated" }, new Set());
    expect(estimated.log.at(-1)?.detail).toBe("course · ≈ 8 h, estimated");
    const unsized = reduceResearch(base, { type: "research.verified", id: "M3", title: "Repo", kind: "repo", backbone: false }, new Set());
    expect(unsized.log.at(-1)?.detail).toBe("repo");
  });

  it("describes thin research by what it could not cover", () => {
    expect(thinText({ researched: 3, sizedMinutes: 540, open: ["Advanced stitches", "Finishing"], hasBackbone: false })).toBe(
      "Pensieve could check only 3 materials, about 9 h, and found nothing on advanced stitches and finishing",
    );
    expect(thinText({ researched: 0, sizedMinutes: 0, open: [], hasBackbone: false })).toBe("Pensieve could not check any materials and no textbook stood out");
    expect(thinText({ researched: 2, sizedMinutes: 90, open: [], hasBackbone: true })).toBe("Pensieve could check only 2 materials, about 1 h 30");
    expect(thinText({ researched: 8, sizedMinutes: 0, open: ["Evals"], hasBackbone: true })).toBe("Pensieve could check 8 materials and found nothing on evals");
  });
});
