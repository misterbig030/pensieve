import { describe, expect, it } from "vitest";
import { dailyContentSchema } from "./dailyContent";

describe("dailyContentSchema", () => {
  it("accepts valid content with citations", () => {
    const result = dailyContentSchema.safeParse({
      contentMarkdown: "# Load balancing\n\nContent here.",
      citations: [{ title: "AWS ELB docs", url: "https://aws.amazon.com/elb" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty citations array", () => {
    const result = dailyContentSchema.safeParse({
      contentMarkdown: "# Content",
      citations: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing contentMarkdown", () => {
    const result = dailyContentSchema.safeParse({ citations: [] });
    expect(result.success).toBe(false);
  });
});
