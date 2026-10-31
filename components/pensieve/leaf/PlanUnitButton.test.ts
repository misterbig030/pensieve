import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/tracks/[id]/actions", () => ({ expandNodeAction: vi.fn() }));

const { PlanUnitButton } = await import("./PlanUnitButton");

describe("PlanUnitButton", () => {
  it("lets a week be split into a number of days other than the usual", () => {
    const html = renderToStaticMarkup(createElement(PlanUnitButton, { trackId: "t", nodeId: "w2", reason: "split", label: "Split into days", daysPerWeek: 4, hoursPerWeek: 8 }));
    expect(html).toContain('aria-label="Split into 4 days, or choose another number"');
  });
});
