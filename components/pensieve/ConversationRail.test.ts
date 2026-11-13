import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationRail } from "./ConversationRail";

describe("ConversationRail", () => {
  it("is a box headed Talk it over, with no desktop collapsed tab", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationRail, {
        mode: "create",
        messages: [],
        open: true,
        unread: false,
        busy: false,
        input: "",
        suggestions: ["Expand week 2"],
        onToggle() {},
        onInputChange() {},
        onSend() {},
        onUndo() {},
      }),
    );
    expect(html).toContain("Talk it over");
    expect(html).not.toContain("[writing-mode:vertical-rl]");
    expect(html).not.toContain('title="Open conversation"');
    expect(html).toContain("Expand week 2");
  });
});
