import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import type { Material, PracticeItem } from "@/lib/schemas/material";
import { practiceRowsFor, type ReadRow } from "@/components/pensieve/ReadTable";
import { dayTasks } from "@/lib/dayTasks";
import { StepCard } from "./StepCard";
import { TaskCard } from "./TaskCard";

const book: Material = { ...AIE_MATERIALS.find((m) => m.id === "aie")!, url: "https://book.example/" };
const chapterRow: ReadRow = {
  material: book,
  tier: "must",
  minutes: 40,
  note: "sections 3.1–3.3",
  chapter: { n: 3, title: "Evaluation Methodology", url: "https://book.example/ch3" } as ReadRow["chapter"],
  activity: "read",
  key: "aie#3",
};
const noteRow: ReadRow = { ...chapterRow, material: { ...book, id: "mine", type: "note", title: "My notes", url: "note:mine" }, chapter: null, key: "mine#0" };
const items: PracticeItem[] = PROBLEM_ITEMS.map((it) => ({ ...it }));
items[3] = { ...items[3], url: "https://leetcode.com/problems/group-anagrams/", solutionUrl: "https://neetcode.io/solutions/group-anagrams" };
const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", practice: { ...LISTED_PROBLEMS, list: { ...LISTED_PROBLEMS.list!, items } } };
const [chapter, note, problem] = dayTasks(
  [chapterRow, noteRow],
  practiceRowsFor([{ format: "problem-set", id: "nc", task: "NeetCode 150 · problem", done: "solved without hints", minutes: 25, generated: false, itemFrom: 4, itemTo: 4 }], new Map([[bank.id, bank]])),
);

const clean = (html: string) => html.replace(/<!-- -->/g, "");
const card = (task: Parameters<typeof TaskCard>[0]["task"], ticked = false) => clean(renderToStaticMarkup(createElement(TaskCard, { task, unit: "day", ticked, onToggle() {} })));
const step = (props: Partial<Parameters<typeof StepCard>[0]>) =>
  clean(renderToStaticMarkup(createElement(StepCard, { n: 2, minutes: 25, body: "Read **up to** the example.", task: chapter!, ticked: false, onToggle() {}, ...props })));

describe("TaskCard", () => {
  it("shows a chapter task's tag, tier, minutes, note and an Open chapter link to the chapter", () => {
    const html = card(chapter!);
    expect(html).toContain(">Read<");
    expect(html).toContain(">Must<");
    expect(html).toContain("40 min");
    expect(html).toContain("AI Engineering, ch. 3");
    expect(html).toContain("sections 3.1–3.3");
    expect(html).toMatch(/<a[^>]*href="https:\/\/book.example\/ch3"[^>]*>.*Open chapter<\/a>/);
  });

  it("shows a problem task's group and difficulty, and Open and Solution links", () => {
    const html = card(problem!);
    expect(html).toContain(">Problems<");
    expect(html).toContain("Arrays &amp; Hashing · Medium");
    expect(html).toContain("49. Group Anagrams");
    expect(html).toContain("solved without hints");
    expect(html).toMatch(/href="https:\/\/leetcode.com\/problems\/group-anagrams\/"[^>]*>.*Open<\/a>/);
    expect(html).toMatch(/href="https:\/\/neetcode.io\/solutions\/group-anagrams"[^>]*>Solution<\/a>/);
  });

  it("shows no link for a note material", () => {
    expect(card(note!)).not.toContain("<a");
  });

  it("shows the lesson card", () => {
    const html = card({ kind: "lesson", minutes: 10 });
    expect(html).toContain(">Lesson<");
    expect(html).toContain("Read today&#x27;s lesson");
    expect(html).toContain("10 min");
  });

  it("marks a ticked card done and its checkbox checked", () => {
    expect(card(chapter!)).toContain('aria-checked="false"');
    const html = card(chapter!, true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-done="true"');
  });
});

describe("StepCard", () => {
  it("shows a step's number, body and minutes, with a link to its task and a tick", () => {
    const html = step({ ticked: true });
    expect(html).toContain("Step 2");
    expect(html).toContain("<strong>up to</strong>");
    expect(html).toContain("25 min");
    expect(html).toMatch(/<a[^>]*href="https:\/\/book.example\/ch3"[^>]*>.*AI Engineering, ch. 3/);
    expect(html).toMatch(/role="checkbox" aria-checked="true" aria-label="Step 2"/);
    expect(html).toContain('data-done="true"');
  });

  it("shows an unlinked step without a link or tick", () => {
    const html = step({ task: null });
    expect(html).toContain("Step 2");
    expect(html).not.toContain("<a");
    expect(html).not.toContain('role="checkbox"');
  });
});
