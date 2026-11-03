import { describe, expect, it } from "vitest";
import { firstParagraph } from "./lessonPreview";

describe("firstParagraph", () => {
  it("takes the first paragraph after a heading, with inline markdown stripped", () => {
    expect(firstParagraph("# Title\n\nFirst **bold** para with [a link](https://x).\n\nSecond.")).toBe("First bold para with a link.");
  });

  it("strips emphasis and code spans", () => {
    expect(firstParagraph("Use _borrowing_ and `&mut` here.")).toBe("Use borrowing and &mut here.");
  });

  it("skips a leading code fence, a list and a quote", () => {
    const md = "```rust\nfn main() {}\n\nlet x = 1;\n```\n\n- one\n- two\n\n> quoted\n\nThe real start.";
    expect(firstParagraph(md)).toBe("The real start.");
  });

  it("joins a paragraph's lines", () => {
    expect(firstParagraph("One line\nand the next.")).toBe("One line and the next.");
  });

  it("cuts a long paragraph at a word boundary with an ellipsis", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const out = firstParagraph(words);
    expect(out.length).toBeLessThanOrEqual(320);
    expect(out.endsWith("…")).toBe(true);
    const kept = out.slice(0, -1).split(" ");
    expect(words.split(" ").slice(0, kept.length)).toEqual(kept);
  });

  it("is empty when there's no prose", () => {
    expect(firstParagraph("# Only a heading\n\n- and a list")).toBe("");
  });
});
