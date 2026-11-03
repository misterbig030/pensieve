import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import type { Material } from "@/lib/schemas/material";
import { practiceRowsFor, type ReadRow } from "@/components/pensieve/ReadTable";
import { dayTasks } from "@/lib/dayTasks";

vi.mock("./actions", () => ({ generateLeafContentAction: vi.fn() }));
vi.mock("@/app/tracks/[id]/actions", () => ({ markCompleteAction: vi.fn(), logSessionAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { LeafView } = await import("./LeafView");

const book: Material = { ...AIE_MATERIALS.find((m) => m.id === "aie")!, url: "https://book.example/" };
const readRow: ReadRow = {
  material: book,
  tier: "must",
  minutes: 40,
  note: null,
  chapter: { n: 3, title: "Evaluation Methodology", url: "https://book.example/ch3" } as ReadRow["chapter"],
  activity: "read",
  key: "aie#3",
};
const practiceRows = practiceRowsFor([{ format: "recall", id: null, task: "Answer five questions", done: "all answered", minutes: 15, generated: true }], new Map());
const tasks = dayTasks([readRow], practiceRows);

const base: ComponentProps<typeof LeafView> = {
  trackId: "t1",
  nodeId: "n1",
  unit: "day",
  unitLabel: "Week 1 · Day 2",
  header: createElement("h1", null, "Evaluation"),
  budgetHours: null,
  initialSessions: [],
  initialContent: null,
  youtubeSources: [],
  isCompleted: false,
  readRows: [readRow],
  tasks,
  prev: { href: "/tracks/t1/nodes/n0", label: "Week 1 · Day 1", title: "Intro" },
  next: null,
};
const lesson = {
  contentMarkdown: ["Intro.", "", "```step", "task: read:aie#3", "minutes: 20", "Read it.", "```"].join("\n"),
  citations: [{ title: "AI Engineering", url: "https://book.example/" }],
};
const render = (props: Partial<ComponentProps<typeof LeafView>> = {}) => renderToStaticMarkup(createElement(LeafView, { ...base, ...props })).replace(/<!-- -->/g, "");

describe("LeafView", () => {
  it("shows the tasks and the intro card before the lesson is written", () => {
    const html = render();
    expect(html).toContain("Today&#x27;s tasks");
    expect(html).toContain("55 min");
    expect(html).toContain("AI Engineering, ch. 3");
    expect(html).toContain("Answer five questions");
    expect(html).toContain("Your lesson for today");
    expect(html).toContain("0 of 2 done");
    expect(html).not.toContain("Read today&#x27;s lesson");
  });

  it("shows the lesson with step cards, Sources and Rewrite under it once written", () => {
    const html = render({ initialContent: lesson });
    expect(html).not.toContain("Your lesson for today");
    expect(html).toContain("Step 1");
    expect(html.indexOf("Step 1")).toBeLessThan(html.indexOf("Sources"));
    expect(html).toContain("Rewrite this lesson");
  });

  it("shows the lesson card and counts it once the lesson is written", () => {
    const html = render({ initialContent: lesson });
    expect(html).toContain("Read today&#x27;s lesson");
    expect(html).toContain("0 of 3 done");
  });

  it("always shows Mark complete", () => {
    expect(render()).toContain("Mark Week 1 · Day 2 complete");
    expect(render({ initialContent: lesson })).toContain("Mark Week 1 · Day 2 complete");
  });

  it("says no tasks were assigned on a day without any, and still offers to write the lesson", () => {
    const html = render({ tasks: [], readRows: [] });
    expect(html).toContain("No tasks were assigned to this day.");
    expect(html).toContain("Write today&#x27;s lesson");
    expect(html).not.toMatch(/\d+ of \d+ done/);
  });

  it("shows the log-a-session form on a week leaf only", () => {
    expect(render()).not.toContain("Log");
    const week = render({ unit: "week", budgetHours: 6 });
    expect(week).toContain("This week&#x27;s tasks");
    expect(week).toContain("Log");
  });
});
