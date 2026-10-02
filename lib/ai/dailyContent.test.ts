import { describe, expect, it } from "vitest";
import { buildDailyContentPrompt, enforceCitations } from "./dailyContent";

describe("buildDailyContentPrompt", () => {
  it("includes the day's title and summary", () => {
    const prompt = buildDailyContentPrompt({
      title: "Load balancing",
      summary: "L4 vs L7, algorithms",
      materials: [],
    });
    expect(prompt).toContain("Load balancing");
    expect(prompt).toContain("L4 vs L7, algorithms");
  });

  it("separates youtube sources from link sources and instructs embedding, not transcript extraction", () => {
    const prompt = buildDailyContentPrompt({
      title: "Caching",
      summary: "Cache strategies",
      materials: [
        { url: "https://youtube.com/watch?v=abc", type: "youtube", title: "Caching talk" },
        { url: "https://example.com/article", type: "link", title: "Caching article" },
      ],
    });
    expect(prompt).toContain("https://youtube.com/watch?v=abc");
    expect(prompt).toMatch(/embed|link card/i);
    expect(prompt).not.toMatch(/transcript/i);
  });

  it("mentions file/note materials as context without treating them as citable", () => {
    const prompt = buildDailyContentPrompt({
      title: "Caching",
      summary: "Cache strategies",
      materials: [{ url: "notes.pdf", type: "file", title: "My notes" }],
    });
    expect(prompt).toContain("My notes");
    expect(prompt).toMatch(/cannot access their contents/i);
  });

  it("lists the unit's Read table with tier, minutes and note, and limits citations to it", () => {
    const prompt = buildDailyContentPrompt({
      title: "Evals",
      summary: "How to evaluate LLM apps",
      unit: "week",
      spanDays: 7,
      materials: [{ url: "https://example.com/ai-eng", type: "link", title: "AI Engineering", tier: "must", minutes: 90, note: "Ch. 4 §2" }],
    });
    expect(prompt).toContain("- AI Engineering (https://example.com/ai-eng) — must, 90 min, Ch. 4 §2");
    expect(prompt).toMatch(/list only materials from this unit's list/);
    expect(prompt).not.toMatch(/search the web/i);
  });

  it("asks for no citations when nothing on the list is citable", () => {
    const prompt = buildDailyContentPrompt({ title: "A", summary: "B", materials: [] });
    expect(prompt).toMatch(/leave "citations" empty/);
  });
});

describe("enforceCitations", () => {
  const materials = [
    { url: "https://www.example.com/guide/", type: "link" as const, title: "The guide" },
    { url: "https://youtu.be/abc", type: "youtube" as const, title: "The talk" },
    { url: "My notes", type: "note" as const, title: "My notes" },
  ];
  it("keeps citations of assigned materials, under their own titles, and drops the rest", () => {
    const result = enforceCitations(
      [
        { title: "guide", url: "https://example.com/guide#part-2" },
        { title: "Something else", url: "https://elsewhere.example.com/" },
        { title: "Talk", url: "https://youtu.be/abc" },
        { title: "dup", url: "https://example.com/guide" },
      ],
      materials,
    );
    expect(result.citations).toEqual([
      { title: "The guide", url: "https://www.example.com/guide/" },
      { title: "The talk", url: "https://youtu.be/abc" },
    ]);
    expect(result.dropped).toBe(1);
  });
});
