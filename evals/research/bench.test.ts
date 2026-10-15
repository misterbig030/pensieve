import { describe, expect, it } from "vitest";
import { type CandidateList, briefFromPrompt, checkObject, estimateCostUsd, hoursCap, notesUrls, pairs, pickCall, readTitles } from "./bench";

const PROMPT = [
  `You researched materials for a self-study plan.`,
  `Topic: X`,
  `Plan length: 90 days at about 6 hours a week: 77 hours of study in all`,
  `Research notes (search results, pages read, and your own notes):`,
  `Search: "q"`,
  `  - A title <https://a.example/page>: snippet.`,
  `  - B title <https://b.example/list?x=1>: snippet`,
  `Read <https://c.example/doc> → <https://docs.c.example/doc/>: title "C Docs Overview" (500 words)`,
  `  excerpt text`,
  `Read <https://e.example/talk>: title "A Talk" (runtime 54 min)`,
  `  excerpt`,
  `Could not read <https://d.example/>: returned 403`,
  `Now list the materials.`,
  `"candidates": the researched materials. Choose a list: together the candidates' minutes must not exceed 77 hours, and a short plan needs only a handful.`,
].join("\n");

describe("pickCall", () => {
  it("returns the prompt and system of the labelled call", () => {
    const calls = [
      { label: "Research · backbone · step 1", prompt: "a", system: "s" },
      { label: "Research · candidates", prompt: "the prompt", system: null },
    ];
    expect(pickCall(calls, "Research · candidates")).toEqual({ prompt: "the prompt", system: null });
  });

  it("throws when the label is missing or the prompt is not text", () => {
    expect(() => pickCall([{ label: "x", prompt: "a", system: null }], "Research · candidates")).toThrow(/Research · candidates/);
    expect(() => pickCall([{ label: "Research · candidates", prompt: [{ role: "user" }], system: null }], "Research · candidates")).toThrow(/text/);
  });
});

describe("notesUrls / readTitles / hoursCap", () => {
  it("collects every URL in the notes, read or not, without trailing punctuation", () => {
    const urls = notesUrls(PROMPT);
    expect(urls.has("https://a.example/page")).toBe(true);
    expect(urls.has("https://b.example/list?x=1")).toBe(true);
    expect(urls.has("https://c.example/doc")).toBe(true);
    expect(urls.has("https://docs.c.example/doc")).toBe(true);
    expect(urls.has("https://d.example")).toBe(true);
    expect([...urls].some((u) => u.endsWith(">") || u.endsWith(":"))).toBe(false);
  });

  it("maps a read page's url and final url to the title the notes recorded", () => {
    const titles = readTitles(PROMPT);
    expect(titles.get("https://c.example/doc")).toBe("C Docs Overview");
    expect(titles.get("https://docs.c.example/doc")).toBe("C Docs Overview");
    expect(titles.get("https://e.example/talk")).toBe("A Talk");
    expect(titles.has("https://d.example")).toBe(false);
  });

  it("reads the hour cap from the instructions", () => {
    expect(hoursCap(PROMPT)).toBe(77);
    expect(hoursCap("no cap here")).toBeNull();
  });
});

describe("checkObject", () => {
  const base = { author: null, year: null, uses: null, recommendedBy: [] as string[], why: "w" };
  it("counts candidates, backbones, minutes, and what the notes cannot vouch for", () => {
    const object: CandidateList = {
      learner: [],
      candidates: [
        { ...base, url: "https://a.example/page", title: "A Book", kind: "book", backbone: true, minutes: 600, recommendedBy: ["https://b.example/list?x=1", "https://nowhere.example/"] },
        { ...base, url: "https://docs.c.example/doc/", title: "C Docs Overview", kind: "docs", backbone: false, minutes: 30 },
        { ...base, url: "https://e.example/talk", title: "A Talk, retitled", kind: "video", backbone: false, minutes: 54 },
        { ...base, url: "https://z.example/new", title: "Z", kind: "essay", backbone: false, minutes: null },
      ],
    };
    const c = checkObject(object, PROMPT);
    expect(c.candidates).toBe(4);
    expect(c.backbones).toBe(1);
    expect(c.backboneIsBook).toBe(true);
    expect(c.totalMinutes).toBe(684);
    expect(c.overCap).toBe(false);
    expect(c.unsized).toBe(1);
    expect(c.urlsOutsideNotes).toEqual(["https://z.example/new"]);
    expect(c.recommendersOutsideNotes).toBe(1);
    expect(c.retitled).toEqual(["https://e.example/talk"]);
  });

  it("flags more than one backbone, a non-book backbone, and a list over the cap", () => {
    const object: CandidateList = {
      learner: [],
      candidates: [
        { ...base, url: "https://a.example/page", title: "A", kind: "course", backbone: true, minutes: 77 * 60 },
        { ...base, url: "https://b.example/list?x=1", title: "B", kind: "book", backbone: true, minutes: 1 },
      ],
    };
    const c = checkObject(object, PROMPT);
    expect(c.backbones).toBe(2);
    expect(c.backboneIsBook).toBe(false);
    expect(c.overCap).toBe(true);
  });
});

describe("estimateCostUsd / pairs", () => {
  it("prices output tokens, reasoning included, at the model's list price", () => {
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 8934, 10973)).toBeCloseTo(0.1276, 4);
    expect(estimateCostUsd("anthropic/claude-haiku-5.5", 10000, 10000)).toBeCloseTo(0.006, 4);
    expect(() => estimateCostUsd("anthropic/unknown", 1, 1)).toThrow(/price/);
  });

  it("pairs every model with every effort, models outermost", () => {
    expect(pairs(["m1", "m2"], ["low", "high"])).toEqual([
      { model: "m1", effort: "low" },
      { model: "m1", effort: "high" },
      { model: "m2", effort: "low" },
      { model: "m2", effort: "high" },
    ]);
  });
});

describe("briefFromPrompt", () => {
  it("rebuilds the brief from a recorded candidate prompt's header", () => {
    expect(briefFromPrompt(PROMPT)).toEqual({ topic: "X", days: 90, hoursPerWeek: 6, sources: [] });
    expect(briefFromPrompt("Plan length: 30 days at about 1 hour a week: 4 hours of study in all\nTopic: Y")).toEqual({ topic: "Y", days: 30, hoursPerWeek: 1, sources: [] });
    expect(() => briefFromPrompt("nothing here")).toThrow(/Topic/);
  });
});
