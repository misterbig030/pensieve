import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialResearch } from "@/lib/researchProgress";
import { ResearchProgress } from "./ResearchProgress";

describe("ResearchProgress", () => {
  it("no longer shows found items under the research card", () => {
    const html = renderToStaticMarkup(
      createElement(ResearchProgress, {
        state: { ...initialResearch(0), found: [{ id: "a", title: "Genki I", kind: "book", backbone: true, yours: false }] },
      }),
    );
    expect(html).not.toContain("Found so far");
    expect(html).not.toContain("Genki I");
  });
});
