import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import type { Material } from "@/lib/schemas/material";
import type { ReadRow } from "@/components/pensieve/ReadTable";
import { LessonMarkdown } from "@/components/pensieve/LessonMarkdown";
import { dayTasks } from "@/lib/dayTasks";
import { DayLesson } from "./DayLesson";
import { LessonIntro } from "./LessonIntro";

const book: Material = { ...AIE_MATERIALS.find((m) => m.id === "aie")!, url: "https://book.example/" };
const row = (n: number): ReadRow => ({
  material: book,
  tier: "must",
  minutes: 40,
  note: null,
  chapter: { n, title: `Chapter ${n}`, url: `https://book.example/ch${n}` } as ReadRow["chapter"],
  activity: "read",
  key: `aie#${n}`,
});
const tasks = dayTasks([row(3), row(4)], []);

const clean = (html: string) => html.replace(/<!-- -->/g, "");
const lesson = (markdown: string, ticks: string[] = []) =>
  clean(renderToStaticMarkup(createElement(DayLesson, { markdown, tasks, ticks: new Set(ticks), onToggleStep() {}, onRewrite() {}, rewriting: false })));

const stepped = ["Intro.", "", "```step", "task: read:aie#3", "minutes: 20", "First half.", "```", "", "Between.", "", "```step", "task: read:aie#4", "Chapter four.", "```"].join("\n");

describe("DayLesson", () => {
  it("renders a lesson without steps exactly as LessonMarkdown does", () => {
    const markdown = "# Title\n\nSome **text**.\n\n```answers\nA.\n```";
    expect(lesson(markdown)).toBe(clean(renderToStaticMarkup(createElement("div", { className: "space-y-4" }, createElement(LessonMarkdown, null, markdown)))));
  });

  it("renders steps in order, linked to their tasks, ticked from the step keys", () => {
    const html = lesson(stepped, ["read:aie#3@0"]);
    expect(html.indexOf("Intro.")).toBeLessThan(html.indexOf("Step 1"));
    expect(html.indexOf("Step 1")).toBeLessThan(html.indexOf("Between."));
    expect(html.indexOf("Between.")).toBeLessThan(html.indexOf("Step 2"));
    expect(html).toContain('href="https://book.example/ch3"');
    expect(html).toContain('href="https://book.example/ch4"');
    expect(html).toMatch(/aria-checked="true" aria-label="Step 1"/);
    expect(html).toMatch(/aria-checked="false" aria-label="Step 2"/);
    expect(html).not.toContain("tasks changed");
  });

  it("renders a step whose task is gone without a link, and shows the tasks-changed note", () => {
    const html = lesson(stepped.replace("read:aie#4", "read:aie#9"));
    expect(html).not.toContain('href="https://book.example/ch9"');
    expect(html).not.toContain('aria-label="Step 2"');
    expect(html).toContain("This day&#x27;s tasks changed after the lesson was written.");
    expect(html).toContain("Rewrite this lesson");
  });

  it("shows no tasks-changed note for an unlinked step with no task", () => {
    expect(lesson("```step\ntask:\nGo.\n```")).not.toContain("tasks changed");
  });
});

describe("LessonIntro", () => {
  const intro = (props: Partial<Parameters<typeof LessonIntro>[0]>) =>
    clean(renderToStaticMarkup(createElement(LessonIntro, { unit: "day", tasks, pending: false, error: null, errorLink: false, onWrite() {}, ...props })));

  it("previews the tasks in the intro card, in order", () => {
    const html = intro({});
    expect(html).toContain("Your lesson for today");
    expect(html).toContain("from the 2 tasks on the left");
    expect(html).toMatch(/<ol[^>]*><li>Read AI Engineering, ch. 3<\/li><li>Read AI Engineering, ch. 4<\/li><\/ol>/);
    expect(html).toContain("Write today&#x27;s lesson");
  });

  it("writes from the track's sources when the day has no tasks", () => {
    const html = intro({ tasks: [], unit: "week" });
    expect(html).toContain("Your material for this week");
    expect(html).toContain("Pensieve writes it from your track&#x27;s sources and cites what it uses.");
    expect(html).not.toContain("<ol");
    expect(html).toContain("Write this week&#x27;s material");
  });

  it("shows a generation error", () => {
    expect(intro({ error: "Your key was refused.", errorLink: true })).toContain("Open Settings");
  });
});
