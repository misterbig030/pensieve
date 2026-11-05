import { describe, expect, it } from "vitest";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { Chapter, Material, PracticeItem } from "@/lib/schemas/material";
import { checkRun, practiceTimeFindings, resourceKey, type Verdict } from "./checks";
import type { RunRecord, TimedEvent } from "./record";
import { DRAFT_TOPICS, type DraftTopic } from "./topics";

const SDE = DRAFT_TOPICS.sde;
const UNLABELLED: DraftTopic = { id: "plain", request: SDE.request };

function chapters(count: number): { source: "catalogue"; url: string; printPages: false; end: null; chapters: Chapter[] } {
  return {
    source: "catalogue",
    url: "https://openlibrary.org/books/OL1M",
    printPages: false,
    end: null,
    chapters: Array.from({ length: count }, (_, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, minutes: null, sections: [] })),
  };
}

function material(id: string, title: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "book", url: `https://example.com/${id}`, title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 600, ...extra } as Material;
}

const PROBLEMS = ["Contains Duplicate", "Valid Anagram", "Two Sum", "Group Anagrams", "Top K Frequent Elements", "Valid Palindrome", "3Sum", "Container With Most Water"];

function item(title: string): PracticeItem {
  const slug = title.toLowerCase().replace(/\s+/g, "-");
  return { title, number: null, group: "Arrays & Hashing", difficulty: "easy", url: `https://leetcode.com/problems/${slug}/`, solutionUrl: null, minutes: null };
}

function neetcode(): Material {
  return material("M3", "NeetCode 150", {
    kind: "repo",
    url: "https://neetcode.io/practice",
    minutes: null,
    practice: { format: "problem-set", items: 8, perItemMinutes: 40, minutes: 800, answers: true, list: { source: "page", url: "https://neetcode.io/practice", items: PROBLEMS.map(item) } },
  });
}

function day(n: number, reading: { id: string; chapter?: number }, practiceItem: number | null): PlanNode {
  return makeNode({
    id: `d${n}`,
    level: "day",
    title: `Day ${n}`,
    summary: "Study and practise.",
    len: 1,
    materials: [{ id: reading.id, tier: "must", minutes: 30, note: null, ...(reading.chapter ? { chapter: reading.chapter } : {}) }],
    practice:
      practiceItem === null
        ? []
        : [{ format: "problem-set", id: "M3", task: PROBLEMS[practiceItem - 1], done: "solved", minutes: 42, generated: false, itemFrom: practiceItem, itemTo: practiceItem }],
  });
}

function week(n: number, input: Partial<Parameters<typeof makeNode>[0]> = {}): PlanNode {
  return makeNode({ id: `w${n}`, level: "week", title: `Week ${n}`, summary: "A week.", len: 5, ...input });
}

/**
 * A run that passes every criterion with no warnings: Alex Xu's book as the backbone, DDIA beside it, a NeetCode list
 * read from its page, and two weeks that reserve everything once. Week 1's days read 30 minutes and solve one item.
 */
function record(): RunRecord {
  const week1 = week(1, {
    covers: [
      { id: "M1", chapter: 1, note: null },
      { id: "M2", chapter: 1, note: null },
      { id: "M4", note: null },
    ],
    practiceCovers: [{ format: "problem-set", id: "M3", note: null, itemFrom: 1, itemTo: 5 }],
    children: [day(1, { id: "M1", chapter: 1 }, 1), day(2, { id: "M2", chapter: 1 }, 2), day(3, { id: "M4" }, 3), day(4, { id: "M4" }, 4), day(5, { id: "M4" }, 5)],
  });
  const week2 = week(2, {
    covers: [
      { id: "M1", chapter: 2, note: null },
      { id: "M2", chapter: 2, note: null },
    ],
    practiceCovers: [{ format: "problem-set", id: "M3", note: null, itemFrom: 6, itemTo: 8 }],
  });
  return {
    meta: { topic: "sde", run: 1, startedAt: "2026-10-29T10:00:00.000Z", commit: "abc1234", key: "app", models: {}, ms: 100_000, costUsd: 1, costByStage: {} },
    events: [{ type: "research.fetch", url: "https://neetcode.io/practice", ok: true, t: 10 }],
    calls: [],
    materials: {
      verified: [],
      allocated: [
        material("M1", "System Design Interview – An Insider's Guide", { author: "Alex Xu", backbone: true, toc: chapters(4) }),
        material("M2", "Designing Data-Intensive Applications", { author: "Martin Kleppmann", toc: chapters(3) }),
        neetcode(),
        material("M4", "Grokking Modern System Design", { kind: "course", minutes: 300 }),
      ],
      dropped: [],
      coverage: null,
    },
    split: { readingShare: 60, practice: "problems", formats: [{ format: "problem-set", share: 100, focus: "patterns", reason: "" }], reason: "" },
    plan: makeRoot([week1, week2]),
  };
}

function weeks(r: RunRecord): PlanNode[] {
  return r.plan!.children!;
}

function days(r: RunRecord): PlanNode[] {
  return weeks(r)[0].children!;
}

function verdict(r: RunRecord, id: Verdict["id"], topic: DraftTopic = SDE): Verdict {
  return checkRun(r, topic).verdicts.find((v) => v.id === id)!;
}

function event(e: Record<string, unknown>): TimedEvent {
  return { t: 0, ...e } as TimedEvent;
}

describe("practiceTimeFindings", () => {
  const split = { readingShare: 0, practice: "problems", formats: [{ format: "problem-set" as const, share: 60, focus: "patterns", reason: "" }], reason: "" };
  const request = { weeks: 1, hoursPerWeek: 10 };

  it("reports a served format under half its share as short", () => {
    const served = material("M3", "Problems", { practice: { format: "problem-set", items: null, perItemMinutes: null, minutes: 10, answers: true, list: null } });
    const found = practiceTimeFindings(split, [served], request);
    expect(found.unserved).toEqual([]);
    expect(found.short).toEqual(["problem-set: materials give 10 min against a share of 360 min (60%)"]);
  });

  it("reports a format that cannot be generated and has no serving material as unserved", () => {
    const found = practiceTimeFindings(split, [], request);
    expect(found.unserved).toEqual(["problem-set: 60% of practice (360 min) and no material serves it"]);
    expect(found.short).toEqual([]);
  });

  it("notes a served format that gets its share", () => {
    const served = material("M3", "Problems", { practice: { format: "problem-set", items: null, perItemMinutes: null, minutes: 300, answers: true, list: null } });
    const found = practiceTimeFindings(split, [served], request);
    expect(found).toEqual({ unserved: [], short: [], notes: ["problem-set: 300 of 360 min from M3"] });
  });
});

describe("resourceKey", () => {
  it("gives a chapter the same key written either way", () => {
    expect(resourceKey({ id: "M1", chapter: 3 })).toBe(resourceKey({ id: "M1.3" }));
    expect(resourceKey({ id: "M1" })).toBe("M1");
    expect(resourceKey({ id: "M1", chapter: null })).toBe("M1");
  });
});

describe("checkRun", () => {
  it("passes the base run with no warnings", () => {
    const result = checkRun(record(), SDE);
    expect(result.verdicts.map((v) => [v.id, v.status])).toEqual([
      [1, "pass"],
      [2, "pass"],
      [3, "pass"],
      [4, "pass"],
      [5, "pass"],
      [6, "pass"],
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails 2, 3 and 6 with Week 1 not drafted when Week 1 has no days", () => {
    const r = record();
    weeks(r)[0].children = null;
    const result = checkRun(r, SDE);
    for (const id of [2, 3, 6] as const) {
      const v = result.verdicts.find((x) => x.id === id)!;
      expect(v.status).toBe("fail");
      expect(v.evidence).toContain("Week 1 not drafted");
    }
    expect(result.passed).toBe(false);
  });
});

describe("criterion 1: backbone", () => {
  it("passes Alex Xu's System Design Interview", () => {
    expect(verdict(record(), 1).status).toBe("pass");
  });

  it("fails another backbone, naming it", () => {
    const r = record();
    r.materials.allocated![0] = material("M1", "Cracking the Coding Interview", { author: "Gayle Laakmann McDowell", backbone: true, toc: chapters(4) });
    const v = verdict(r, 1);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("Cracking the Coding Interview");
  });

  it("fails a matching backbone that is not a book", () => {
    const r = record();
    r.materials.allocated![0].kind = "course";
    const v = verdict(r, 1);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("course");
  });

  it("fails a matching title by another author", () => {
    const r = record();
    r.materials.allocated![0].author = "Someone Else";
    expect(verdict(r, 1).status).toBe("fail");
  });

  it("fails a book whose title only contains the label's: Machine Learning System Design Interview is not Alex Xu's", () => {
    const r = record();
    r.materials.allocated![0] = material("M1", "Machine Learning System Design Interview", { author: "Ali Aminian, Alex Xu", backbone: true, toc: chapters(4) });
    expect(verdict(r, 1).status).toBe("fail");
  });

  it("passes the label's title followed by a subtitle or a volume", () => {
    for (const title of ["System Design Interview, Volume 2", "System Design Interview – An Insider's Guide: Volume 2", "System Design Interview"]) {
      const r = record();
      r.materials.allocated![0].title = title;
      expect(verdict(r, 1).status, title).toBe("pass");
    }
  });

  it("is n/a without labels", () => {
    expect(verdict(record(), 1, UNLABELLED).status).toBe("n/a");
  });
});

describe("criterion 2: named practice list", () => {
  it("passes a fetched NeetCode list whose items Week 1 names", () => {
    const r = record();
    for (const d of days(r).slice(3)) d.practice = [];
    expect(verdict(r, 2).status).toBe("pass");
  });

  it("fails days that give counts only", () => {
    const r = record();
    for (const d of days(r)) d.practice = [{ format: "problem-set", id: "M3", task: "NeetCode 150 · problems 1–4", done: "solved", minutes: 42, generated: false }];
    const v = verdict(r, 2);
    expect(v.status).toBe("fail");
    expect(v.evidence[0]).toBe("0 of 5 days name an item of the list (at least 3)");
  });

  it("does not count an item position without the item's title in the task", () => {
    const r = record();
    days(r).forEach((d, i) => {
      d.practice = i < 3 ? [{ format: "problem-set", id: "M3", task: "problems 1–4", done: "solved", minutes: 42, generated: false, itemFrom: 1, itemTo: 1 }] : [];
    });
    const v = verdict(r, 2);
    expect(v.status).toBe("fail");
    expect(v.evidence[0]).toBe("0 of 5 days name an item of the list (at least 3)");
  });

  it("fails a list whose URL was never fetched", () => {
    const r = record();
    r.events = [];
    const v = verdict(r, 2);
    expect(v.status).toBe("fail");
    expect(v.evidence).toContain('M3 "NeetCode 150": its list at https://neetcode.io/practice was never read');
  });

  it("counts a title inside a longer title as the longer item only", () => {
    const r = record();
    const list = r.materials.allocated![2].practice!.list!;
    list.items[7] = { ...list.items[7], title: "Two Sum II – Input Array Is Sorted" };
    days(r)[0].practice = [{ ...days(r)[0].practice![0], task: "Two Sum", itemFrom: 3, itemTo: 3 }];
    days(r)[2].practice = [{ ...days(r)[2].practice![0], task: "Two Sum II – Input Array Is Sorted", itemFrom: 8, itemTo: 8 }];
    expect(verdict(r, 2).status).toBe("pass");
  });

  it("fails an item named on two days", () => {
    const r = record();
    days(r)[3].practice = [{ ...days(r)[0].practice![0] }];
    const v = verdict(r, 2);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("Contains Duplicate");
  });

  it("is n/a without labels", () => {
    expect(verdict(record(), 2, UNLABELLED).status).toBe("n/a");
  });
});

describe("criterion 3: reservations add up", () => {
  it("fails an allocated material no week reserves, naming it", () => {
    const r = record();
    r.materials.allocated!.push(material("M5", "Database Internals"));
    const v = verdict(r, 3);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("M5");
  });

  it("counts a chapter reserved as M1 + chapter 3 and as M1.3 as one overlap", () => {
    const r = record();
    weeks(r)[1].covers!.push({ id: "M1", chapter: 3, note: null });
    r.plan = makeRoot([...weeks(r), week(3), week(4, { covers: [{ id: "M1.3", note: null }] })]);
    const v = verdict(r, 3);
    expect(v.status).toBe("fail");
    expect(v.evidence.filter((line) => line.includes("reserved by"))).toEqual(["M1.3 reserved by Week 2 and Week 4"]);
  });

  it("counts a whole cover of a chaptered material as reserving its chapters", () => {
    const r = record();
    weeks(r)[1].covers!.push({ id: "M2", note: null });
    r.plan = makeRoot([...weeks(r), week(3), week(4, { covers: [{ id: "M2", chapter: 3, note: null }] })]);
    const v = verdict(r, 3);
    expect(v.status).toBe("fail");
    expect(v.evidence).toContain("M2.3 reserved by Week 2 and Week 4");
  });

  it("reads a practice cover's item id as its source", () => {
    const r = record();
    weeks(r)[0].practiceCovers![0].id = "M3.i1";
    weeks(r)[1].practiceCovers![0].id = "M3.i6";
    expect(verdict(r, 3).status).toBe("pass");
  });

  it("fails an item range two weeks share", () => {
    const r = record();
    weeks(r)[1].practiceCovers = [{ format: "problem-set", id: "M3", note: null, itemFrom: 5, itemTo: 8 }];
    const v = verdict(r, 3);
    expect(v.status).toBe("fail");
    expect(v.evidence[0]).toBe("M3 items 5–5 reserved by Week 1 and Week 2");
  });

  it("passes a whole course reserved in Weeks 2 and 3", () => {
    const r = record();
    weeks(r)[1].covers!.push({ id: "M4", note: null });
    r.plan = makeRoot([...weeks(r), week(3, { covers: [{ id: "M4", note: null }] })]);
    expect(verdict(r, 3).status).toBe("pass");
  });

  it("passes generated practice in every week", () => {
    const r = record();
    for (const w of weeks(r)) w.practiceCovers!.push({ format: "recall", id: null, note: null });
    expect(verdict(r, 3).status).toBe("pass");
  });

  it("passes a Week 1 day reading M5.2 when Week 1 covers M5 whole", () => {
    const r = record();
    r.materials.allocated!.push(material("M5", "Database Internals", { toc: chapters(3) }));
    weeks(r)[0].covers!.push({ id: "M5", note: null });
    days(r)[2].materials = [{ id: "M5.2", tier: "must", minutes: 30, note: null }];
    expect(verdict(r, 3).status).toBe("pass");
  });

  it("fails a Week 1 day reading a chaptered material whole when Week 1 reserves only a chapter", () => {
    const r = record();
    days(r)[1].materials = [{ id: "M2", tier: "must", minutes: 30, note: null }];
    const v = verdict(r, 3);
    expect(v.status).toBe("fail");
    expect(v.evidence).toContain("Day 2 reads M2, which Week 1 does not reserve");
  });

  it("passes a Week 1 day reading a chaptered material whole when Week 1 covers it whole", () => {
    const r = record();
    weeks(r)[0].covers![1] = { id: "M2", note: null };
    weeks(r)[1].covers = [{ id: "M1", chapter: 2, note: null }];
    days(r)[1].materials = [{ id: "M2", tier: "must", minutes: 30, note: null }];
    expect(verdict(r, 3).status).toBe("pass");
  });

  it("fails a Week 1 day reading what Week 1 does not reserve", () => {
    const r = record();
    days(r)[2].materials = [{ id: "M1", chapter: 2, tier: "must", minutes: 30, note: null }];
    const v = verdict(r, 3);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("M1.2");
  });
});

describe("criterion 4: outside services", () => {
  it("fails a final Anthropic failure", () => {
    const r = record();
    r.events.push(event({ type: "service", name: "anthropic", ok: false, final: true, ms: 0, status: 400, reason: "Bad Request", where: "outline" }));
    const v = verdict(r, 4);
    expect(v.status).toBe("fail");
    expect(v.evidence).toEqual(["anthropic failed (400) at outline: Bad Request"]);
  });

  it("passes failed attempts that recovered, with a retries warning", () => {
    const r = record();
    r.events.push(event({ type: "service", name: "anthropic", ok: false, final: false, ms: 5, status: 529 }));
    r.events.push(event({ type: "service", name: "anthropic", ok: false, final: false, ms: 5, status: 529 }));
    const result = checkRun(r, SDE);
    expect(result.verdicts.find((v) => v.id === 4)!.status).toBe("pass");
    expect(result.warnings.filter((w) => w.kind === "retries")).toHaveLength(1);
    expect(result.warnings.find((w) => w.kind === "retries")!.text).toBe("anthropic: 2 failed attempts, 0 calls gave up");
  });

  it("fails a failed page read on openlibrary.org", () => {
    const r = record();
    r.events.push(event({ type: "research.fetch", url: "https://openlibrary.org/works/OL1W.json", ok: false, reason: "returned 403" }));
    const result = checkRun(r, SDE);
    expect(result.verdicts.find((v) => v.id === 4)!.status).toBe("fail");
    expect(result.warnings.map((w) => w.kind)).not.toContain("refusal-rate");
  });

  it("passes a 403 on www.oreilly.com and counts it in the refusal rate", () => {
    const r = record();
    r.events.push(event({ type: "research.fetch", url: "https://www.oreilly.com/library/view/x/", ok: false, reason: "returned 403" }));
    const result = checkRun(r, SDE);
    expect(result.verdicts.find((v) => v.id === 4)!.status).toBe("pass");
    const refusal = result.warnings.find((w) => w.kind === "refusal-rate");
    expect(refusal?.text).toContain("1 of 2");
    expect(refusal?.text).toContain("oreilly.com");
  });

  it("fails an error event", () => {
    const r = record();
    r.events.push(event({ type: "error", message: "boom" }));
    const v = verdict(r, 4);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("boom");
  });
});

describe("criterion 5: practice time served", () => {
  it("fails a picked problem set no material serves", () => {
    const r = record();
    r.materials.allocated![2].practice = null;
    const v = verdict(r, 5);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("problem-set");
  });

  it("fails a problem set served at 1% of an 18% share", () => {
    const r = record();
    r.split!.formats = [
      { format: "problem-set", share: 18, focus: "patterns", reason: "" },
      { format: "recall", share: 82, focus: "facts", reason: "" },
    ];
    // Practice time is 6 h × 8 weeks × 40% = 1152 min; 1% of it is about 12.
    r.materials.allocated![2].practice!.minutes = 12;
    const v = verdict(r, 5);
    expect(v.status).toBe("fail");
    expect(v.evidence[0]).toBe("problem-set: materials give 12 min against a share of 207 min (18%)");
  });

  it("passes recall, which may be generated, with no serving material", () => {
    const r = record();
    r.split!.formats = [
      { format: "problem-set", share: 50, focus: "patterns", reason: "" },
      { format: "recall", share: 50, focus: "facts", reason: "" },
    ];
    expect(verdict(r, 5).status).toBe("pass");
  });

  it("passes a source sized by items × minutes per item", () => {
    const r = record();
    const practice = r.materials.allocated![2].practice!;
    practice.minutes = null;
    practice.items = 20;
    practice.perItemMinutes = 40;
    const v = verdict(r, 5);
    expect(v.status).toBe("pass");
    expect(v.evidence).toEqual(["problem-set: 800 of 1152 min from M3"]);
  });

  it("counts items × minutes per item when a source has no minutes", () => {
    const r = record();
    const practice = r.materials.allocated![2].practice!;
    practice.minutes = null;
    practice.items = 1;
    practice.perItemMinutes = 10;
    expect(verdict(r, 5).status).toBe("fail");
  });
});

describe("criterion 6: first drafted units", () => {
  function withMinutes(r: RunRecord, totals: number[]): RunRecord {
    days(r).forEach((d, i) => (d.practice![0].minutes = totals[i] - 30));
    return r;
  }

  it("passes days of 70, 75, 60, 80 and 72 minutes", () => {
    expect(verdict(withMinutes(record(), [70, 75, 60, 80, 72]), 6).status).toBe("pass");
  });

  it("judges the run by the request it was run with, not the topic's request today", () => {
    const r = withMinutes(record(), [120, 120, 120, 120, 120]);
    expect(verdict(r, 6).status).toBe("fail");
    r.meta.request = { ...SDE.request, hoursPerWeek: 10 };
    const v = verdict(r, 6);
    expect(v.status, v.evidence.join("\n")).toBe("pass");
  });

  it("fails a 40-minute day", () => {
    const v = verdict(withMinutes(record(), [70, 40, 60, 80, 72]), 6);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("40");
  });

  it("fails a material id in a summary", () => {
    const r = record();
    days(r)[1].summary = "Read parts M9.1–M9.10 of the book.";
    const v = verdict(r, 6);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("M9.1");
  });

  it("fails a chaptered material read whole on one day and by chapter on another", () => {
    const r = record();
    days(r)[0].materials = [{ id: "M2", tier: "must", minutes: 30, note: null }];
    const v = verdict(r, 6);
    expect(v.status).toBe("fail");
    expect(v.evidence).toContain("M2.1 read on Day 1 and Day 2, without the part in a note");
  });

  it("fails a chapter read on two days", () => {
    const r = record();
    days(r)[2].materials = [{ id: "M2.1", tier: "must", minutes: 30, note: null }];
    const v = verdict(r, 6);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("M2.1");
  });

  it("passes a long chapter run across consecutive days, each naming its part", () => {
    const r = record();
    days(r)[0].materials = [{ id: "M1", chapter: 1, tier: "must", minutes: 30, note: "first half" }];
    days(r)[1].materials = [{ id: "M1", chapter: 1, tier: "must", minutes: 30, note: "second half" }];
    const v = verdict(r, 6);
    expect(v.status, v.evidence.join("\n")).toBe("pass");
  });

  it("fails a chapter read on days that are not consecutive, even with notes", () => {
    const r = record();
    days(r)[0].materials = [{ id: "M1", chapter: 1, tier: "must", minutes: 30, note: "first half" }];
    days(r)[2].materials = [{ id: "M1", chapter: 1, tier: "must", minutes: 30, note: "second half" }];
    const v = verdict(r, 6);
    expect(v.status).toBe("fail");
    expect(v.evidence).toContain("M1.1 read on Day 1 and Day 3, not in consecutive units");
  });

  it("fails a chapter on consecutive days when one of them names no part", () => {
    const r = record();
    days(r)[0].materials = [{ id: "M1", chapter: 1, tier: "must", minutes: 30, note: "first half" }];
    days(r)[1].materials = [{ id: "M1", chapter: 1, tier: "must", minutes: 30, note: null }];
    const v = verdict(r, 6);
    expect(v.status).toBe("fail");
    expect(v.evidence).toContain("M1.1 read on Day 1 and Day 2, without the part in a note");
  });
});

describe("plan shapes", () => {
  type Request = DraftTopic["request"];
  const topicFor = (request: Partial<Request>): DraftTopic => ({ id: "shape", request: { ...SDE.request, ...request } });

  function leaf(level: "day" | "week", n: number, reads: { id: string; chapter?: number; note?: string }[], minutes: number, input: Partial<Parameters<typeof makeNode>[0]> = {}): PlanNode {
    const reading = reads.map((r) => ({ tier: "must" as const, minutes: 20, note: r.note ?? null, ...r }));
    const rest = minutes - reading.reduce((sum, r) => sum + r.minutes, 0);
    return makeNode({
      id: `${level[0]}${n}`,
      level,
      title: `${level} ${n}`,
      summary: "Study and practise.",
      len: level === "day" ? 1 : 5,
      materials: reading,
      practice: rest > 0 ? [{ format: "recall", id: null, task: "Recall the key ideas.", done: "written", minutes: rest, generated: true }] : [],
      ...input,
    });
  }

  function heading(level: "month" | "week", n: number, covers: string[], children: PlanNode[] | null = null): PlanNode {
    return makeNode({
      id: `${level[0]}${n}`,
      level,
      title: `${level} ${n}`,
      summary: "A stretch of the plan.",
      len: level === "week" ? 5 : 20,
      covers: covers.map((id) => ({ id, note: null })),
      children,
    });
  }

  /** M1 has four chapters, M2 is an essay with none. */
  function shapeRecord(plan: PlanNode | null): RunRecord {
    const r = record();
    r.materials.allocated = [material("M1", "A Textbook", { toc: chapters(4) }), material("M2", "An Essay", { kind: "essay", minutes: 40 })];
    r.split = null;
    r.plan = plan;
    return r;
  }

  const statuses = (r: RunRecord, topic: DraftTopic) => checkRun(r, topic).verdicts.filter((v) => v.id === 3 || v.id === 6).map((v) => [v.id, v.status]);

  describe("one week of days at the top", () => {
    const topic = topicFor({ weeks: 1 });
    const plan = () => makeRoot([1, 2, 3, 4, 5].map((n) => leaf("day", n, n <= 4 ? [{ id: `M1.${n}` }] : [{ id: "M2" }], 72)));

    it("reads the days' own rows as the reservation and judges them as the first units", () => {
      const result = checkRun(shapeRecord(plan()), topic);
      const [three, six] = [3, 6].map((id) => result.verdicts.find((v) => v.id === id)!);
      expect(three.status, three.evidence.join("\n")).toBe("pass");
      expect(three.evidence).toEqual(["2 materials across 5 days"]);
      expect(six.status, six.evidence.join("\n")).toBe("pass");
      expect(six.evidence).toEqual(["Days plan 72, 72, 72, 72, 72 min against 72"]);
    });

    it("fails a material no day reads", () => {
      const r = shapeRecord(plan());
      r.plan!.children![4].materials = [];
      expect(verdict(r, 3, topic).evidence).toContain('M2 "An Essay" is reserved by no day');
    });

    it("lets a chapter run across consecutive days with notes, not across a gap", () => {
      const r = shapeRecord(plan());
      r.plan!.children![1].materials = [{ id: "M1.1", tier: "must", minutes: 20, note: "second half" }, ...r.plan!.children![1].materials!];
      r.plan!.children![1].practice![0].minutes -= 20;
      r.plan!.children![0].materials![0].note = "first half";
      expect(statuses(r, topic)).toEqual([
        [3, "pass"],
        [6, "pass"],
      ]);
      r.plan!.children![1].materials!.shift();
      r.plan!.children![2].materials!.unshift({ id: "M1.1", tier: "must", minutes: 20, note: "second half" });
      expect(verdict(r, 3, topic).evidence).toContain("M1.1 reserved by Day 1 and Day 3, not in consecutive units");
    });
  });

  describe("week headings over days", () => {
    it("is the base run's shape", () => {
      expect(statuses(record(), SDE)).toEqual([
        [3, "pass"],
        [6, "pass"],
      ]);
      expect(verdict(record(), 6).evidence).toEqual(["Week 1 days plan 72, 72, 72, 72, 72 min against 72"]);
    });
  });

  describe("week leaves at the top", () => {
    const topic = topicFor({ weeks: 3, hoursPerWeek: 3, granularity: "week" });
    const plan = () => makeRoot([leaf("week", 1, [{ id: "M1.1" }, { id: "M1.2" }], 180, { budgetHours: 3 }), leaf("week", 2, [{ id: "M1.3" }], 180), leaf("week", 3, [{ id: "M1.4" }, { id: "M2" }], 180)]);

    it("reads the weeks' own rows and judges each week against its hours, with no days to draft", () => {
      const result = checkRun(shapeRecord(plan()), topic);
      const [three, six] = [3, 6].map((id) => result.verdicts.find((v) => v.id === id)!);
      expect(three.status, three.evidence.join("\n")).toBe("pass");
      expect(six.status, six.evidence.join("\n")).toBe("pass");
      expect(six.evidence).toEqual(["Weeks plan 180, 180, 180 min against 180"]);
    });

    it("fails a week far from its hours", () => {
      const r = shapeRecord(plan());
      r.plan!.children![1].practice = [];
      expect(verdict(r, 6, topic).evidence).toContain("Week 2 plans 20 min, outside 144–216");
    });

    it("fails a material no week reads", () => {
      const r = shapeRecord(plan());
      r.plan!.children![2].materials = [{ id: "M1.4", tier: "must", minutes: 20, note: null }];
      expect(verdict(r, 3, topic).evidence).toContain('M2 "An Essay" is reserved by no week');
    });
  });

  describe("months over week leaves", () => {
    const topic = topicFor({ weeks: 8, granularity: "week" });
    const plan = () =>
      makeRoot([
        heading("month", 1, ["M1.1", "M1.2"], [leaf("week", 1, [{ id: "M1.1" }], 360, { budgetHours: 6 }), leaf("week", 2, [{ id: "M1.2" }], 360, { budgetHours: 6 })]),
        heading("month", 2, ["M1.3", "M1.4", "M2"]),
      ]);

    it("reads the months' covers as the reservation and judges Month 1's weeks", () => {
      const result = checkRun(shapeRecord(plan()), topic);
      const [three, six] = [3, 6].map((id) => result.verdicts.find((v) => v.id === id)!);
      expect(three.status, three.evidence.join("\n")).toBe("pass");
      expect(three.evidence).toEqual(["2 materials across 2 months"]);
      expect(six.status, six.evidence.join("\n")).toBe("pass");
      expect(six.evidence).toEqual(["Month 1 weeks plan 360, 360 min against 360"]);
    });

    it("fails a Month 1 week reading what Month 1 does not reserve", () => {
      const r = shapeRecord(plan());
      r.plan!.children![0].children![1].materials![0].id = "M1.3";
      expect(verdict(r, 3, topic).evidence).toContain("Week 2 reads M1.3, which Month 1 does not reserve");
    });

    it("fails Month 1 not drafted", () => {
      const r = shapeRecord(plan());
      r.plan!.children![0].children = null;
      for (const id of [3, 6] as const) expect(verdict(r, id, topic).evidence).toContain("Month 1 not drafted");
    });
  });

  describe("months over week headings over days", () => {
    const topic = topicFor({ weeks: 12 });
    const plan = () =>
      makeRoot([
        heading("month", 1, ["M1.1", "M1.2"], [heading("week", 1, ["M1.1"], [1, 2, 3, 4, 5].map((n) => leaf("day", n, n === 1 ? [{ id: "M1.1" }] : [], 72))), heading("week", 2, ["M1.2"])]),
        heading("month", 2, ["M1.3", "M1.4"]),
        heading("month", 3, ["M2"]),
      ]);

    it("counts what later months reserve and judges Month 1's Week 1 days", () => {
      const result = checkRun(shapeRecord(plan()), topic);
      const [three, six] = [3, 6].map((id) => result.verdicts.find((v) => v.id === id)!);
      expect(three.status, three.evidence.join("\n")).toBe("pass");
      expect(three.evidence).toEqual(["2 materials across 3 months"]);
      expect(six.status, six.evidence.join("\n")).toBe("pass");
      expect(six.evidence).toEqual(["Month 1 · Week 1 days plan 72, 72, 72, 72, 72 min against 72"]);
    });

    it("holds the days to their week's reservation, not their month's", () => {
      const r = shapeRecord(plan());
      r.plan!.children![0].children![0].children![1].materials = [{ id: "M1.2", tier: "must", minutes: 20, note: null }];
      expect(verdict(r, 3, topic).evidence).toContain("Day 2 reads M1.2, which Month 1 · Week 1 does not reserve");
    });

    it("fails a chapter two months reserve, with no allowance for headings", () => {
      const r = shapeRecord(plan());
      r.plan!.children![1].covers!.push({ id: "M1.2", note: "the rest" });
      r.plan!.children![0].covers![1].note = "first part";
      expect(verdict(r, 3, topic).evidence).toContain("M1.2 reserved by Month 1 and Month 2");
    });
  });

  it("fails 3 and 6 once, with no material list, when the record has no plan", () => {
    const r = shapeRecord(null);
    for (const id of [3, 6] as const) {
      const v = verdict(r, id, UNLABELLED);
      expect(v.status).toBe("fail");
      expect(v.evidence).toEqual(["no plan in the record"]);
    }
  });
});

describe("warnings", () => {
  const kinds = (r: RunRecord) => checkRun(r, SDE).warnings.map((w) => w.kind);

  it("does not warn when two of three expected books are allocated", () => {
    expect(kinds(record())).not.toContain("expected-books");
  });

  it("warns when only one expected book is allocated", () => {
    const r = record();
    r.materials.allocated![1].title = "Database Internals";
    const warning = checkRun(r, SDE).warnings.find((w) => w.kind === "expected-books");
    expect(warning?.text).toContain("1 of 3");
  });

  it("does not count an essay whose title contains an expected book's", () => {
    const r = record();
    r.materials.allocated = [material("M6", "System design interview questions in 2026: real prompts, model answers", { kind: "essay" })];
    const warning = checkRun(r, SDE).warnings.find((w) => w.kind === "expected-books");
    expect(warning?.text).toBe(
      '0 of 3 expected books allocated; missing "Designing Data-Intensive Applications", "System Design Interview", "Cracking the Coding Interview"',
    );
  });

  it("does not count a book whose title only contains an expected book's, and counts one with a subtitle", () => {
    const r = record();
    r.materials.allocated = [
      material("M6", "Machine Learning System Design Interview", { author: "Ali Aminian, Alex Xu" }),
      material("M7", "Cracking the Coding Interview: 189 Programming Questions and Solutions", { author: "Gayle Laakmann McDowell" }),
    ];
    const warning = checkRun(r, SDE).warnings.find((w) => w.kind === "expected-books");
    expect(warning?.text).toBe('1 of 3 expected books allocated; missing "Designing Data-Intensive Applications", "System Design Interview"');
  });

  it("warns about 1-minute reading rows", () => {
    const r = record();
    days(r)[0].materials![0].minutes = 1;
    expect(kinds(r)).toContain("sizes");
  });

  it("warns about item titles that are labels", () => {
    const r = record();
    r.materials.allocated![2].practice!.list!.items[7].title = "Solution";
    expect(kinds(r)).toContain("sizes");
  });

  it("warns about a run that cost $2.10", () => {
    const r = record();
    r.meta.costUsd = 2.1;
    const warning = checkRun(r, SDE).warnings.find((w) => w.kind === "cost-time");
    expect(warning?.text).toContain("$2.10");
  });

  it("counts drop reasons by kind", () => {
    const r = record();
    r.events.push(event({ type: "research.dropped", title: "A", reason: "Open Library matched the title, but no author was given to confirm it" }));
    r.events.push(event({ type: "research.dropped", title: "B", reason: "no matching book on Open Library" }));
    r.events.push(event({ type: "research.dropped", title: "C", reason: "returned 403" }));
    const warning = checkRun(r, SDE).warnings.find((w) => w.kind === "drop-reasons");
    expect(warning?.text).toContain("no author 1");
    expect(warning?.text).toContain("no match 1");
    expect(warning?.text).toContain("page refused 1");
  });

  it("counts the rule breaks reported as problems, apart from retries", () => {
    const r = record();
    r.calls = [{ label: "Week 1", facts: ["breach: Week 1's must-reading is 400 min against a budget of 200"] } as RunRecord["calls"][number]];
    expect(kinds(r)).toContain("problems");
    expect(kinds(r)).not.toContain("retries");
    expect(checkRun(r, SDE).warnings.find((w) => w.kind === "problems")!.text).toBe("reported problems: 1");
  });
});
