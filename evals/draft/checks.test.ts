import { describe, expect, it } from "vitest";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { Chapter, Material, PracticeItem } from "@/lib/schemas/material";
import { checkRun, resourceKey, type Verdict } from "./checks";
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

  it("fails a matching title by another author", () => {
    const r = record();
    r.materials.allocated![0].author = "Someone Else";
    expect(verdict(r, 1).status).toBe("fail");
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

  it("fails a list whose URL was never fetched", () => {
    const r = record();
    r.events = [];
    const v = verdict(r, 2);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("NeetCode 150");
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
    expect(result.warnings.find((w) => w.kind === "retries")!.text).toContain("anthropic 2");
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

  it("counts items × minutes per item when a source has no minutes", () => {
    const r = record();
    const practice = r.materials.allocated![2].practice!;
    practice.minutes = null;
    practice.items = 1;
    practice.perItemMinutes = 10;
    expect(verdict(r, 5).status).toBe("fail");
  });
});

describe("criterion 6: Week 1 days", () => {
  function withMinutes(r: RunRecord, totals: number[]): RunRecord {
    days(r).forEach((d, i) => (d.practice![0].minutes = totals[i] - 30));
    return r;
  }

  it("passes days of 70, 75, 60, 80 and 72 minutes", () => {
    expect(verdict(withMinutes(record(), [70, 75, 60, 80, 72]), 6).status).toBe("pass");
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

  it("fails a chapter read on two days", () => {
    const r = record();
    days(r)[2].materials = [{ id: "M2.1", tier: "must", minutes: 30, note: null }];
    const v = verdict(r, 6);
    expect(v.status).toBe("fail");
    expect(v.evidence.join("\n")).toContain("M2.1");
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

  it("counts breach re-asks as retries", () => {
    const r = record();
    r.calls = [{ label: "Week 1", facts: ["breach: Week 1's must-reading is 400 min against a budget of 200"] } as RunRecord["calls"][number]];
    expect(kinds(r)).toContain("retries");
  });
});
