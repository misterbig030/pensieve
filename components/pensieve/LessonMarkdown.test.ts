import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { LessonMarkdown } from "./LessonMarkdown";

const render = (markdown: string) => renderToStaticMarkup(createElement(LessonMarkdown, null, markdown));

describe("LessonMarkdown", () => {
  it("shows an answers fence as a collapsed Answers block, its body rendered as markdown", () => {
    const html = render(["1. What does a KV cache store?", "", "```answers", "1. The **keys and values** of past tokens.", "```"].join("\n"));
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toMatch(/<summary[^>]*>Answers<\/summary>/);
    expect(html).toContain("<strong>keys and values</strong>");
    expect(html).not.toContain("<pre");
  });

  it("renders other code fences exactly as plain markdown does", () => {
    for (const markdown of ["```python\nprint('hi')\n```", "```\nplain\n```", "- Use `answers` inline."]) {
      expect(render(markdown)).toBe(renderToStaticMarkup(createElement(ReactMarkdown, null, markdown)));
    }
  });

  it("keeps raw HTML as text", () => {
    expect(render("<details><summary>Answers</summary>x</details>")).not.toContain("<details");
  });
});
