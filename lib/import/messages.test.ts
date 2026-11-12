import { describe, expect, it } from "vitest";
import { importMessages } from "./messages";

const base = { fileName: "plan.md", text: "# Plan", kept: [], skipped: [] };

describe("importMessages", () => {
  it("starts with the sys line, then the intro", () => {
    const ms = importMessages(base);
    expect(ms[0]).toMatchObject({ kind: "sys", text: "Imported from plan.md. No research ran, and nothing was looked up." });
    expect(ms[1]).toMatchObject({
      kind: "answer",
      streaming: false,
      text: "Here's your plan as the file has it. What the file doesn't say, like how a week splits into days, I'll decide when you ask.",
    });
    expect(ms).toHaveLength(2);
  });

  it("lists kept sections as context", () => {
    const ms = importMessages({ ...base, kept: ["Resources", "Notes"] });
    expect(ms[2]).toMatchObject({ kind: "answer", text: "Kept as context, not as units: Resources, Notes." });
  });

  it("lists skipped sections", () => {
    const ms = importMessages({ ...base, skipped: [{ heading: "Eval-interview prep", reason: "no weeks given" }] });
    expect((ms[2] as { text: string }).text).toBe(
      "Couldn't place 1 section: Eval-interview prep (no weeks given). Tell me where it goes, or leave it as context.",
    );
  });

  it("pluralises and joins several skipped sections", () => {
    const ms = importMessages({
      ...base,
      skipped: [
        { heading: "A", reason: "x" },
        { heading: "B", reason: "y" },
      ],
    });
    expect((ms[2] as { text: string }).text).toContain("Couldn't place 2 sections: A (x); B (y).");
  });

  it("has no brief message", () => {
    expect(importMessages({ ...base, kept: ["K"], skipped: [{ heading: "S", reason: "r" }] }).some((m) => m.kind === "brief")).toBe(false);
  });
});
