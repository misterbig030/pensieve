import { describe, expect, it } from "vitest";
import { buildOutlinePrompt } from "./outline";

describe("buildOutlinePrompt", () => {
  it("includes the topic and period in a fresh-draft prompt", () => {
    const prompt = buildOutlinePrompt({
      topic: "System Design 面试准备",
      periodDays: 14,
      sources: [],
    });
    expect(prompt).toContain("System Design 面试准备");
    expect(prompt).toContain("14");
  });

  it("includes provided sources", () => {
    const prompt = buildOutlinePrompt({
      topic: "Stocks",
      sources: [{ url: "https://example.com/book", title: "Some Book" }],
    });
    expect(prompt).toContain("https://example.com/book");
    expect(prompt).toContain("Some Book");
  });

  it("includes the existing draft and feedback when revising", () => {
    const prompt = buildOutlinePrompt({
      topic: "System Design",
      sources: [],
      existingDraft: {
        items: [{ dayIndex: 1, title: "Old title", summary: "Old summary" }],
      },
      feedback: "Day 1 太难了，拆细一点",
    });
    expect(prompt).toContain("Old title");
    expect(prompt).toContain("太难了，拆细一点");
  });
});
