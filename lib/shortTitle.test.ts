import { describe, expect, it } from "vitest";
import { shortTitle } from "@/lib/shortTitle";

describe("shortTitle", () => {
  it("names a GitHub repo by its repo name, words spaced", () => {
    expect(shortTitle("GitHub - mdmzfzl/NeetCode-Solutions: My solutions in C++, Python and Rust for problems on NeetCode.io · GitHub")).toBe(
      "NeetCode Solutions",
    );
    expect(shortTitle("GitHub - donnemartin/system-design-primer: Learn how to design large-scale systems.")).toBe("System Design Primer");
  });

  it("drops a subtitle and a site name", () => {
    expect(shortTitle("AI Assisted Coding Interviews: Direct, Explain, Verify")).toBe("AI Assisted Coding Interviews");
    expect(shortTitle("AI Just Changed Tech Interviews Forever | Here's how to be ready")).toBe("AI Just Changed Tech Interviews Forever");
    expect(shortTitle("System Design in a Hurry | Hello Interview System Design in a Hurry")).toBe("System Design in a Hurry");
    expect(shortTitle("How to Nail Behavioral Interviews - YouTube")).toBe("How to Nail Behavioral Interviews");
  });

  it("drops a trailing bracketed note", () => {
    expect(shortTitle("Google’s AI-Assisted Coding Interview (2026 Guide)")).toBe("Google’s AI-Assisted Coding Interview");
  });

  it("keeps a short title whole", () => {
    expect(shortTitle("Designing Data-Intensive Applications")).toBe("Designing Data-Intensive Applications");
    expect(shortTitle("My notes")).toBe("My notes");
  });

  it("keeps the subtitle when the main title alone would say too little", () => {
    expect(shortTitle("C: A Reference Manual")).toBe("C: A Reference Manual");
  });

  it("cuts a long title at a word, with an ellipsis", () => {
    const short = shortTitle("How to Nail Big Tech Behavioral Interviews as a Senior Software Engineer");
    expect(short).toBe("How to Nail Big Tech Behavioral Interviews…");
    expect(short.length).toBeLessThanOrEqual(44);
  });
});
